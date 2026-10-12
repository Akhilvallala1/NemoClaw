// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  type CompositeAction,
  readYaml,
  type WorkflowJob,
  type WorkflowStep,
} from "../../helpers/e2e-workflow-contract";

type PrWorkflow = { jobs: Record<string, WorkflowJob> };

const workflow = readYaml<PrWorkflow>(".github/workflows/pr.yaml");
const action = readYaml<CompositeAction>(".github/actions/ci-static-checks/action.yaml");
const docsStep = workflow.jobs["docs-only-checks"].steps?.find(
  (step) => step.name === "Install hadolint",
);
const staticStep = action.runs.steps.find((step) => step.name === "Install hadolint");
const checkedInPin = readFileSync(".github/hadolint.env", "utf8");
const checkedInVersion = checkedInPin.match(/^HADOLINT_VERSION=(.+)$/m)?.[1];
const changedVersion = checkedInVersion === "9.9.9" ? "9.9.8" : "9.9.9";
const changedVersionPin = checkedInPin.replace(
  /^HADOLINT_VERSION=.+$/m,
  `HADOLINT_VERSION=${changedVersion}`,
);

function exerciseInstall(
  step: WorkflowStep,
  trustedAction: boolean,
  pin: string,
  checksumOverride?: string,
) {
  const root = mkdtempSync(join(tmpdir(), "nemoclaw-hadolint-pin-"));
  try {
    const bin = join(root, "bin");
    const target = join(root, "hadolint");
    const curlArgs = join(root, "curl-args");
    const untrustedMarker = join(root, "untrusted-pin-ran");
    const workspace = join(root, "workspace");
    const actionPath = join(root, "trusted", ".github", "actions", "ci-static-checks");
    const version = pin.match(/^HADOLINT_VERSION=(.+)$/m)?.[1];
    const expectedChecksum = pin.match(/^HADOLINT_LINUX_X86_64_SHA256=(.+)$/m)?.[1];
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(expectedChecksum).toMatch(/^[a-f0-9]{64}$/);
    const reportedChecksum = checksumOverride ?? expectedChecksum;
    const sparseCheckout = String(
      workflow.jobs["static-checks"].steps?.find(
        (candidate) => candidate.name === "Checkout trusted CI actions",
      )?.with?.["sparse-checkout"] ?? "",
    );

    mkdirSync(bin);
    mkdirSync(join(root, ".github"));
    mkdirSync(join(workspace, ".github"), { recursive: true });
    mkdirSync(actionPath, { recursive: true });
    writeFileSync(join(root, ".github", "hadolint.env"), pin);
    writeFileSync(
      join(root, "trusted", ".github", "hadolint.env"),
      trustedAction &&
        sparseCheckout
          .split("\n")
          .map((line) => line.trim())
          .includes(".github/hadolint.env")
        ? pin
        : "",
    );
    writeFileSync(
      join(workspace, ".github", "hadolint.env"),
      'touch "$HADOLINT_UNTRUSTED_MARKER"\nHADOLINT_VERSION=0.0.0\n',
    );
    writeFileSync(
      join(bin, "curl"),
      '#!/bin/sh\nprintf "%s\\n" "$*" > "$HADOLINT_CURL_ARGS"\nprintf fake > "$HADOLINT_TARGET"\n',
      { mode: 0o755 },
    );
    writeFileSync(
      join(bin, "sha256sum"),
      `#!/bin/sh\nprintf "%s  %s\\n" ${reportedChecksum} "$1"\n`,
      { mode: 0o755 },
    );

    const result = spawnSync(
      "/bin/bash",
      ["-c", step.run?.replaceAll("/usr/local/bin/hadolint", target) ?? ""],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          GITHUB_ACTION_PATH: actionPath,
          GITHUB_WORKSPACE: workspace,
          HADOLINT_CURL_ARGS: curlArgs,
          HADOLINT_TARGET: target,
          HADOLINT_UNTRUSTED_MARKER: untrustedMarker,
          HOME: root,
          PATH: `${bin}:/opt/homebrew/bin:/usr/bin:/bin`,
        },
        timeout: 5_000,
      },
    );

    const curlInvocation = readFileSync(curlArgs, "utf8");
    expect(curlInvocation).toContain(
      `https://github.com/hadolint/hadolint/releases/download/v${version}/hadolint-linux-x86_64`,
    );
    expect(curlInvocation).toContain("--retry 3 --retry-all-errors --retry-delay 2");
    expect(readFileSync(target, "utf8")).toBe("fake");
    expect(existsSync(untrustedMarker)).toBe(false);
    return {
      status: result.status,
      output: String(result.stdout) + String(result.stderr),
      executable: (statSync(target).mode & 0o111) !== 0,
    };
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}

describe("Hadolint CI pin", () => {
  const callers = [
    ["docs-only", docsStep, false],
    ["base-trusted static action", staticStep, true],
  ] as const;

  it.each(callers)("installs the checked-in pin in %s", (_name, step, trustedAction) => {
    expect(step).toBeDefined();
    const result = exerciseInstall(step!, trustedAction, checkedInPin);
    expect(result.status, result.output).toBe(0);
    expect(result.executable).toBe(true);
  });

  it.each(callers)("tracks a changed pin in %s", (_name, step, trustedAction) => {
    expect(step).toBeDefined();
    const result = exerciseInstall(step!, trustedAction, changedVersionPin);
    expect(result.status, result.output).toBe(0);
    expect(result.executable).toBe(true);
  });

  it.each(callers)("rejects a checksum mismatch in %s", (_name, step, trustedAction) => {
    expect(step).toBeDefined();
    const result = exerciseInstall(step!, trustedAction, checkedInPin, "0".repeat(64));
    expect(result.status).toBe(1);
    expect(result.output).toContain("hadolint checksum mismatch");
    expect(result.executable).toBe(false);
  });
});
