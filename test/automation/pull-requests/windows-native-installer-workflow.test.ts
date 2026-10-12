// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  assertWindowsInstallerWorkflow,
  readWindowsInstallerWorkflowSources,
  type WindowsInstallerWorkflowSources,
  type WorkflowJob,
  type WorkflowStep,
} from "../../../tools/windows-installer/workflow-boundary.mts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
function sources(): WindowsInstallerWorkflowSources {
  return readWindowsInstallerWorkflowSources(repoRoot);
}
function step(job: WorkflowJob, name: string): WorkflowStep {
  const found = job.steps?.find((item) => item.name === name);
  expect(found, "Missing fixture step: " + name).toBeDefined();
  return found!;
}
type Mutation = { name: string; mutate: (value: WindowsInstallerWorkflowSources) => void };
const mutations: Mutation[] = [
  ...[
    "windows-finished-request",
    "windows-compiled-application",
    "windows-finished-installer",
    "windows-finished-installed-startup",
    "windows-finished-candidate-migration",
    "windows-runtime-controls",
    "windows-runtime-preflight",
  ].flatMap((name) => [
    {
      name: "a protected environment on " + name,
      mutate: (value: WindowsInstallerWorkflowSources) => {
        value.workflow.jobs[name].environment = "privileged";
      },
    },
    {
      name: "a secret in " + name,
      mutate: (value: WindowsInstallerWorkflowSources) => {
        value.workflow.jobs[name].steps!.push({ run: "${{ secrets.INFERENCE_KEY }}" });
      },
    },
  ]),
  {
    name: "write access in candidate jobs",
    mutate: (value) => {
      value.workflow.permissions.contents = "write";
    },
  },
  {
    name: "missing candidate migration qualification",
    mutate: (value) => {
      delete value.workflow.jobs["windows-finished-candidate-migration"];
    },
  },
  {
    name: "migration controllers checked out from main instead of the candidate",
    mutate: (value) => {
      step(
        value.workflow.jobs["windows-finished-candidate-migration"],
        "Check out the exact candidate migration controllers",
      ).with!.ref = "main";
    },
  },
  ...[
    "Exercise candidate Burn fixture and diagnostics",
    "Exercise candidate preview migration and selective reset",
    "Bind candidate migration proof to controller and installer",
  ].map((name) => ({
    name: "skipped " + name,
    mutate: (value: WindowsInstallerWorkflowSources) => {
      step(value.workflow.jobs["windows-finished-candidate-migration"], name).if = "${{ false }}";
    },
  })),
  ...["build-burn-diagnostics-fixture.ps1", "test-burn-diagnostics.ps1"].map((file) => ({
    name: "missing candidate " + file,
    mutate: (value: WindowsInstallerWorkflowSources) => {
      const control = step(
        value.workflow.jobs["windows-finished-candidate-migration"],
        "Exercise candidate Burn fixture and diagnostics",
      );
      control.run = control.run!.replaceAll(file, "unrelated.ps1");
    },
  })),
  {
    name: "candidate migration executing trusted-main scripts",
    mutate: (value) => {
      const control = step(
        value.workflow.jobs["windows-finished-candidate-migration"],
        "Exercise candidate preview migration and selective reset",
      );
      control.run = control.run!.replaceAll("\\candidate\\", "\\controller\\");
    },
  },
  {
    name: "trusted qualification without candidate migration dependency",
    mutate: (value) => {
      value.workflow.jobs["windows-finished-trusted-qualification"].needs = [
        "windows-finished-request",
        "windows-finished-installer",
        "windows-compiled-application",
      ];
    },
  },
  {
    name: "trusted qualification without successful candidate migration",
    mutate: (value) => {
      const call = value.workflow.jobs["windows-finished-trusted-qualification"];
      call.if = call.if!.replace(
        "needs.windows-finished-candidate-migration.result == 'success'",
        "true",
      );
    },
  },
  ...["candidate_migration_evidence_id", "candidate_migration_proof_sha256"].map((input) => ({
    name: "unbound " + input,
    mutate: (value: WindowsInstallerWorkflowSources) => {
      value.workflow.jobs["windows-finished-trusted-qualification"].with![input] = "unbound";
    },
  })),
  ...[
    "controllerSourceRevision",
    "artifactSourceRevision",
    "installerManifestSha256",
    "workflowRunId",
    "workflowRunAttempt",
    "hashlib.sha256(data).hexdigest() == digest",
    "case['resetVerified'] is True",
  ].map((fragment) => ({
    name: "missing candidate migration proof check " + fragment,
    mutate: (value: WindowsInstallerWorkflowSources) => {
      const verify = step(
        value.trusted.jobs["candidate-migration-proof"],
        "Verify candidate controller and artifact identities",
      );
      verify.run = verify.run!.replaceAll(fragment, "omitted");
    },
  })),
  {
    name: "candidate migration proof from another run",
    mutate: (value) => {
      step(
        value.trusted.jobs["candidate-migration-proof"],
        "Download candidate migration evidence from this run",
      ).with!["run-id"] = "older-run";
    },
  },
  {
    name: "publication without successful candidate migration proof",
    mutate: (value) => {
      const publish = value.trusted.jobs["publish-qualified-installer"];
      publish.if = publish.if!.replace(
        "needs.candidate-migration-proof.result == 'success'",
        "true",
      );
    },
  },
  {
    name: "trusted migration labeled as candidate controller code",
    mutate: (value) => {
      const identity = step(
        value.trusted.jobs.migration,
        "Record trusted migration controller identity separately",
      );
      identity.run = identity.run!.replace(
        "controllerSourceRevision=$env:CONTROLLER_SHA",
        "controllerSourceRevision=$env:CANDIDATE_SHA",
      );
    },
  },
  {
    name: "cancellation of manual evidence",
    mutate: (value) => {
      value.workflow.concurrency["cancel-in-progress"] = "${{ true }}";
    },
  },
  {
    name: "credentialed PR admission",
    mutate: (value) => {
      const entry = step(
        value.workflow.jobs["windows-finished-request"],
        "Admit the exact pull request head without credentials",
      );
      entry.run = entry.run!.replace("credential_authorized=false", "credential_authorized=true");
    },
  },
  ...[
    [
      "windows-compiled-application",
      "Verify installed acceptance controller Windows compatibility",
    ],
    ["windows-runtime-controls", "Exercise installed acceptance controller compatibility"],
  ].flatMap(([name, title]) => [
    {
      name: "late controller checks in " + name,
      mutate: (value: WindowsInstallerWorkflowSources) => {
        const job = value.workflow.jobs[name];
        const control = step(job, title);
        job.steps = job.steps!.filter((item) => item !== control);
        job.steps.push(control);
      },
    },
    {
      name: "missing sentinel regression in " + name,
      mutate: (value: WindowsInstallerWorkflowSources) => {
        const control = step(value.workflow.jobs[name], title);
        control.run = control.run!.replaceAll(
          "control-installed-openclaw-input.test.mts",
          "unrelated.test.mts",
        );
      },
    },
  ]),
  {
    name: "an unpinned controller Node",
    mutate: (value) => {
      step(
        value.workflow.jobs["windows-runtime-controls"],
        "Set up actual ARM64 Node for controller preflight and shared-file fixtures",
      ).with!["node-version"] = "latest";
    },
  },
  {
    name: "a missing preflight Node version",
    mutate: (value) => {
      value.workflow.jobs["windows-runtime-preflight"].strategy!.matrix!.node = ["24.18.1"];
    },
  },
  {
    name: "cancellation of the other preflight Node result",
    mutate: (value) => {
      value.workflow.jobs["windows-runtime-preflight"].strategy!["fail-fast"] = true;
    },
  },
  {
    name: "preflight of a different candidate commit",
    mutate: (value) => {
      step(
        value.workflow.jobs["windows-runtime-preflight"],
        "Check out the exact candidate preflight",
      ).with!.ref = "main";
    },
  },
  {
    name: "unpinned preflight Node",
    mutate: (value) => {
      step(
        value.workflow.jobs["windows-runtime-preflight"],
        "Set up pinned ARM64 preflight Node",
      ).with!["node-version"] = "latest";
    },
  },
  ...[
    "control-installed-openclaw-input.test.mts",
    "native-turn-cleanup.test.mts",
    "runtime-published-resources.test.mts",
  ].map((file) => ({
    name: "missing early " + file,
    mutate: (value: WindowsInstallerWorkflowSources) => {
      const entry = step(
        value.workflow.jobs["windows-runtime-preflight"],
        "Verify observer shutdown and qualification cleanup before building",
      );
      entry.run = entry.run!.replaceAll(file, "unrelated.test.mts");
    },
  })),
  ...["windows-compiled-application", "windows-runtime-controls"].map((name) => ({
    name: "missing preflight dependency in " + name,
    mutate: (value: WindowsInstallerWorkflowSources) => {
      value.workflow.jobs[name].needs = ["windows-finished-request"];
    },
  })),
  {
    name: "compilation without successful preflight",
    mutate: (value) => {
      const job = value.workflow.jobs["windows-compiled-application"];
      job.if = job.if!.replace("needs.windows-runtime-preflight.result == 'success'", "true");
    },
  },
  ...["windows-finished-installer", "windows-finished-installed-startup"].flatMap((name) => [
    {
      name: "a fallback executable cache in " + name,
      mutate: (value: WindowsInstallerWorkflowSources) => {
        value.workflow.jobs[name].steps!.find((item) =>
          item.uses?.startsWith("actions/cache/restore@"),
        )!.with!["restore-keys"] = "older-";
      },
    },
    {
      name: "a tolerated executable cache miss in " + name,
      mutate: (value: WindowsInstallerWorkflowSources) => {
        value.workflow.jobs[name].steps!.find((item) =>
          item.uses?.startsWith("actions/cache/restore@"),
        )!.with!["fail-on-cache-miss"] = false;
      },
    },
  ]),
  ...(["workflow", "trusted"] as const).map((owner) => ({
    name: "missing nested application verification in " + owner,
    mutate: (value: WindowsInstallerWorkflowSources) => {
      const job =
        value[owner].jobs[
          owner === "workflow" ? "windows-finished-installed-startup" : "full-installed-acceptance"
        ];
      const entry = job.steps!.find(
        (item) =>
          item.name?.startsWith("Verify and materialize exact") &&
          item.run?.includes("$application"),
      )!;
      entry.run = entry.run!.replaceAll("-ExpectedManifestSha256 $env:APPLICATION_MANIFEST", "");
    },
  })),
  {
    name: "public compiled executables",
    mutate: (value) => {
      value.workflow.jobs["windows-compiled-application"].steps!.find((item) =>
        item.uses?.startsWith("actions/upload-artifact@"),
      )!.with!.path = "unqualified.exe";
    },
  },
  ...["first-run-consent-control", "gateway-control"].flatMap((directory) => [
    ...["gateway-control.json", "stdout.log", "stderr.log"].map((file) => ({
      name: `missing ${directory}/${file} diagnostics`,
      mutate: (value: WindowsInstallerWorkflowSources) => {
        const staging = step(
          value.workflow.jobs["windows-compiled-application"],
          "Stage only non-runnable application diagnostics",
        );
        staging.run = staging.run!.replaceAll(`"$work\\${directory}\\${file}"`, '"omitted"');
      },
    })),
    {
      name: `unbounded ${directory} diagnostics`,
      mutate: (value: WindowsInstallerWorkflowSources) => {
        const staging = step(
          value.workflow.jobs["windows-compiled-application"],
          "Stage only non-runnable application diagnostics",
        );
        const report = `"$work\\${directory}\\gateway-control.json"`;
        staging.run = staging.run!.replace(report, `"$work\\${directory}", ${report}`);
      },
    },
  ]),
  ...(["workflow", "trusted"] as const).flatMap((owner) =>
    [
      ".head.sha",
      ".base.sha",
      ".base.ref",
      ".head.repo.owner.type",
      "$TRIGGERING_ACTOR",
      "$ACTOR",
      ".merge_base_commit.sha",
      ".behind_by",
      "admin|maintain|write",
    ].map((fragment) => ({
      name: "missing " + fragment + " authorization in " + owner,
      mutate: (value: WindowsInstallerWorkflowSources) => {
        const job =
          value[owner].jobs[owner === "workflow" ? "windows-finished-request" : "authorize"];
        const entry = job.steps!.find((item) =>
          item.name?.startsWith(
            owner === "workflow"
              ? "Authorize exact internal PR"
              : "Require current main controller",
          ),
        )!;
        entry.run = entry.run!.replaceAll(fragment, "removed-control");
      },
    })),
  ),
  {
    name: "a different trusted workflow revision",
    mutate: (value) => {
      value.workflow.jobs["windows-finished-trusted-qualification"].uses =
        "NVIDIA/NemoClaw/.github/workflows/windows-native-installer-trusted.yaml@main";
    },
  },
  ...["trusted_main", "exact_workflow", "exact_pr", "credential_authorized"].map((flag) => ({
    name: "an absent " + flag + " call gate",
    mutate: (value: WindowsInstallerWorkflowSources) => {
      const call = value.workflow.jobs["windows-finished-trusted-qualification"];
      call.if = call.if!.replaceAll(flag, "omitted");
    },
  })),
  ...["full-installed-acceptance", "publish-qualified-installer"].map((name) => ({
    name: "an absent protected environment on " + name,
    mutate: (value: WindowsInstallerWorkflowSources) => {
      delete value.trusted.jobs[name].environment;
    },
  })),
  {
    name: "a secret outside protected jobs",
    mutate: (value) => {
      value.trusted.jobs.authorize.steps!.push({ run: "${{ secrets.INFERENCE_KEY }}" });
    },
  },
  {
    name: "inference before controller proof",
    mutate: (value) => {
      const job = value.trusted.jobs["full-installed-acceptance"];
      const entry = step(job, "Exercise installed preview, real inference and owned cleanup");
      job.steps = [entry, ...job.steps!.filter((item) => item !== entry)];
    },
  },
  {
    name: "an unpinned trusted Node",
    mutate: (value) => {
      const entry = step(
        value.trusted.jobs["full-installed-acceptance"],
        "Verify and materialize exact qualified inputs",
      );
      entry.run = entry.run!.replace(
        "97cce5301a815d2dce07ac5bfd1e6039eae88185ec1d10ae4f8cb712f1732878",
        "0".repeat(64),
      );
    },
  },
  {
    name: "a revived legacy installer lane",
    mutate: (value) => {
      value.workflow.jobs["windows-native-package-diagnostic"].if = "${{ true }}";
    },
  },
  {
    name: "publication without migration dependency",
    mutate: (value) => {
      value.trusted.jobs["publish-qualified-installer"].needs = [
        "authorize",
        "full-installed-acceptance",
      ];
    },
  },
  ...[
    "needs.full-installed-acceptance.result == 'success'",
    "needs.migration.result == 'success'",
  ].map((condition) => ({
    name: "publication without " + condition,
    mutate: (value: WindowsInstallerWorkflowSources) => {
      const job = value.trusted.jobs["publish-qualified-installer"];
      job.if = job.if!.replaceAll(condition, "true");
    },
  })),
  {
    name: "wildcard runnable publication",
    mutate: (value) => {
      value.trusted.jobs["publish-qualified-installer"].steps!.find((item) =>
        item.uses?.startsWith("actions/upload-artifact@"),
      )!.with!.path = "package/*.exe";
    },
  },
  {
    name: "missing publication inventory check",
    mutate: (value) => {
      const entry = step(
        value.trusted.jobs["publish-qualified-installer"],
        "Verify exact accepted installer bytes",
      );
      entry.run = entry.run!.replaceAll("-ExpectedPackageRunnables", "-Unused");
    },
  },
  ...[
    "workflowRunId",
    "workflowRunAttempt",
    "ReparsePoint",
    "A transfer cache entry differs from its manifest.",
  ].map((fragment) => ({
    name: "missing transfer check " + fragment,
    mutate: (value: WindowsInstallerWorkflowSources) => {
      value.transferSource = value.transferSource.replaceAll(fragment, "removed-control");
    },
  })),
  ...[
    "Evidence input contains PE or MSI/OLE runnable content",
    "[IO.FileMode]::CreateNew",
    "The staged evidence inventory changed before upload.",
  ].map((fragment) => ({
    name: "missing evidence guard " + fragment,
    mutate: (value: WindowsInstallerWorkflowSources) => {
      value.evidenceSource = value.evidenceSource.replaceAll(fragment, "removed-control");
    },
  })),
];

describe("Windows installer workflow boundary validation", () => {
  it("accepts the shipped candidate and trusted workflow boundaries", () => {
    expect(() => assertWindowsInstallerWorkflow(sources())).not.toThrow();
  });
  it.each(mutations)("rejects $name", ({ mutate }) => {
    const value = sources();
    mutate(value);
    expect(() => assertWindowsInstallerWorkflow(value)).toThrow();
  });
});

const proofCases: {
  name: string;
  expectedStatus?: number;
  fixture?: Record<string, unknown>;
  burn?: Record<string, unknown>;
  migration?: Record<string, unknown>;
  proof?: Record<string, unknown>;
  editFiles?: (files: { file: string; sha256: string }[]) => void;
  encode?: (text: string) => string;
}[] = [
  { name: "valid", expectedStatus: 0 },
  { name: "wrong controller", proof: { controllerSourceRevision: "c".repeat(40) } },
  { name: "wrong artifact", proof: { artifactSourceRevision: "c".repeat(40) } },
  { name: "wrong installer", proof: { installerManifestSha256: "c".repeat(64) } },
  { name: "wrong run", proof: { workflowRunId: "124" } },
  { name: "wrong attempt", proof: { workflowRunAttempt: "2" } },
  { name: "wrong agent", proof: { agent: "hermes" } },
  { name: "unpassed proof", proof: { passed: false } },
  { name: "failed Burn", burn: { status: "failed" } },
  { name: "failed migration", migration: { status: "failed" } },
  { name: "incomplete cleanup", migration: { cleanupErrors: ["retained state"] } },
  {
    name: "missing case",
    migration: { cases: [{ kind: "conventional-reinstall", resetVerified: true }] },
  },
  {
    name: "failed reset",
    migration: {
      cases: [
        { kind: "conventional-reinstall", resetVerified: false },
        { kind: "native-replace-preview", resetVerified: true },
      ],
    },
  },
  {
    name: "changed report",
    editFiles: (files) => {
      files[1].sha256 = "0".repeat(64);
    },
  },
  {
    name: "path traversal",
    editFiles: (files) => {
      files[1].file = "../outside.json";
    },
  },
  { name: "duplicate property", encode: (text) => '{"passed":false,' + text.slice(1) },
  { name: "distribution fixture", fixture: { intendedForDistribution: true } },
  { name: "oversized proof", encode: (text) => text + " ".repeat(1048576) },
];
it.each(proofCases)("checks downloaded candidate migration proof: $name", (scenario) => {
  const root = mkdtempSync(join(tmpdir(), "candidate-migration-proof-"));
  const revision = "a".repeat(40);
  const manifest = "b".repeat(64);
  const fixture = {
    sourceRevision: revision,
    classification: "actual-burn-host-preparation-failure-fixture",
    intendedForDistribution: false,
    ...scenario.fixture,
  };
  const burn = {
    sourceRevision: revision,
    classification: "actual-burn-prerequisite-failure-qualification",
    agent: "openclaw",
    status: "pass",
    cleanupErrors: [] as string[],
    packageNotInstalled: true,
    ...scenario.burn,
  };
  const migration = {
    sourceRevision: revision,
    classification: "actual-published-preview-native-migration",
    newAgent: "openclaw",
    status: "pass",
    cleanupErrors: [] as string[],
    installationRootRemoved: true,
    cases: [
      { kind: "conventional-reinstall", resetVerified: true },
      { kind: "native-replace-preview", resetVerified: true },
    ],
    ...scenario.migration,
  };
  try {
    const reports = [
      ["diagnostics-fixture/fixture.json", fixture],
      ["burn-diagnostics/burn-diagnostics.json", burn],
      ["migration/preview-migration.json", migration],
    ] as const;
    const files = reports.map(([file, report]) => {
      const content = JSON.stringify(report);
      const target = join(root, file);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);
      return { file: String(file), sha256: createHash("sha256").update(content).digest("hex") };
    });
    scenario.editFiles?.(files);
    const proof = {
      schemaVersion: 1,
      classification: "same-run-candidate-migration-controllers",
      passed: true,
      controllerSourceRevision: revision,
      artifactSourceRevision: revision,
      installerManifestSha256: manifest,
      agent: "openclaw",
      workflowRunId: "123",
      workflowRunAttempt: "1",
      files,
      ...scenario.proof,
    };
    const text = (scenario.encode ?? ((value: string) => value))(JSON.stringify(proof));
    writeFileSync(join(root, "candidate-migration-controller.json"), text);
    const program = step(
      sources().trusted.jobs["candidate-migration-proof"],
      "Verify candidate controller and artifact identities",
    ).run!;
    const result = spawnSync(process.platform === "win32" ? "python" : "python3", ["-c", program], {
      encoding: "utf8",
      timeout: 30000,
      windowsHide: true,
      env: {
        ...process.env,
        PROOF_ROOT: root,
        PROOF_SHA256: createHash("sha256").update(text).digest("hex"),
        CANDIDATE_SHA: revision,
        INSTALLER_MANIFEST: manifest,
        SELECTED_AGENT: "openclaw",
        GITHUB_RUN_ID: "123",
        GITHUB_RUN_ATTEMPT: "1",
      },
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(scenario.expectedStatus ?? 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it.skipIf(process.platform !== "win32")(
  "accepts only a complete successful MSI Python test result",
  () => {
    const root = mkdtempSync(join(tmpdir(), "windows-msi-result-"));
    const script = join(root, "result-controls.ps1");
    const run = step(
      sources().workflow.jobs["windows-runtime-controls"],
      "Check MSI manifest controls",
    ).run!;
    try {
      mkdirSync(join(root, "windows-runtime-controls"));
      writeFileSync(
        script,
        `
$ErrorActionPreference = 'Stop'
$gate = {
${run}
}
function python {
  $global:LASTEXITCODE = $case.ExitCode
  Write-Output $case.Text
}
foreach ($case in @(
  @{ ExitCode = 0; Text = "Ran 130 tests in 1.2s\nOK"; Reject = $false },
  @{ ExitCode = 1; Text = "Ran 130 tests in 1.2s\nOK"; Reject = $true },
  @{ ExitCode = 0; Text = "Ran 89 tests in 1.2s\nOK"; Reject = $true },
  @{ ExitCode = 0; Text = "Ran 130 tests in 1.2s\nOK (skipped=1)"; Reject = $true },
  @{ ExitCode = 0; Text = "Ran 130 tests in 1.2s\nFAILED"; Reject = $true },
  @{ ExitCode = 0; Text = "Ran 1300 tests in 1.2s\nOK"; Reject = $true },
  @{ ExitCode = 0; Text = ''; Reject = $true }
)) {
  $rejected = $false
  try { & $gate | Out-Null } catch { $rejected = $true }
  if ($rejected -ne $case.Reject) { throw 'MSI test result was misclassified.' }
}
Write-Output '7 result controls passed'
`,
      );
      const result = spawnSync("pwsh.exe", ["-NoProfile", "-NonInteractive", "-File", script], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 30000,
        env: { ...process.env, RUNNER_TEMP: root, GITHUB_WORKSPACE: repoRoot },
      });
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(result.stdout).toContain("7 result controls passed");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

it.skipIf(process.platform !== "win32")(
  "rejects a manifest-valid extra publication executable",
  () => {
    const root = mkdtempSync(join(tmpdir(), "windows-native-transfer-"));
    const packageDirectory = join(root, "package");
    const revision = "a".repeat(40);
    const expectedNames = [
      "NemoClaw-0.1.10-windows-arm64.msi",
      "NemoClawSetup-0.1.10-windows-arm64.exe",
    ];
    const allNames = [...expectedNames, "unaccepted-extra.exe"];
    const transferScript = join(repoRoot, "scripts/checks/windows-native-transfer.ps1");
    try {
      mkdirSync(packageDirectory, { recursive: true });
      const files = allNames.map((name, index) => {
        const bytes = Buffer.from(`publication-fixture-${index}`, "utf8");
        writeFileSync(join(packageDirectory, name), bytes);
        return {
          file: name,
          bytes: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        };
      });
      writeFileSync(
        join(packageDirectory, "immutable-package-build.json"),
        JSON.stringify({
          sourceRevision: revision,
          status: "candidate-built-for-installed-qualification",
          files,
        }),
      );
      const create = spawnSync(
        "pwsh.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-File",
          transferScript,
          "-Mode",
          "Create",
          "-Root",
          root,
          "-Kind",
          "finished-installer",
          "-SourceRevision",
          revision,
          "-Agent",
          "openclaw",
          "-RunId",
          "123",
          "-RunAttempt",
          "1",
        ],
        { encoding: "utf8", windowsHide: true },
      );
      expect(create.status, create.stderr).toBe(0);
      const manifestSha256 = create.stdout.trim();
      const verify = spawnSync(
        "pwsh.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          String.raw`& $env:TRANSFER_SCRIPT -Mode Verify -Root $env:TRANSFER_ROOT -Kind finished-installer -SourceRevision $env:SOURCE_REVISION -Agent openclaw -RunId 123 -RunAttempt 1 -ExpectedManifestSha256 $env:MANIFEST_SHA256 -ExpectedPackageRunnables @('NemoClaw-0.1.10-windows-arm64.msi','NemoClawSetup-0.1.10-windows-arm64.exe')`,
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            MANIFEST_SHA256: manifestSha256,
            SOURCE_REVISION: revision,
            TRANSFER_ROOT: root,
            TRANSFER_SCRIPT: transferScript,
          },
          windowsHide: true,
        },
      );
      expect(verify.status).not.toBe(0);
      expect(verify.stdout + verify.stderr).toContain(
        "package runnable inventory differs from the qualified publication allowlist",
      );
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  },
);

it.skipIf(process.platform !== "win32")(
  "rejects PE content disguised as allowlisted evidence",
  () => {
    const root = mkdtempSync(join(tmpdir(), "windows-native-evidence-"));
    const input = join(root, "candidate-evidence.json");
    const output = join(root, "staged");
    const evidenceScript = join(repoRoot, "scripts/checks/stage-windows-native-evidence.ps1");
    try {
      writeFileSync(input, Buffer.from([0x4d, 0x5a, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]));
      const result = spawnSync(
        "pwsh.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-File",
          evidenceScript,
          "-SourceBase",
          root,
          "-InputPath",
          input,
          "-OutputRoot",
          output,
        ],
        { encoding: "utf8", windowsHide: true },
      );
      expect(result.status).not.toBe(0);
      expect(result.stdout + result.stderr).toContain(
        "Evidence input contains PE or MSI/OLE runnable content",
      );
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  },
);
