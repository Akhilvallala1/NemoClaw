// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";

import {
  createDestroyHarness,
  resetDestroyModuleCache,
} from "../../../../test/helpers/destroy-flow-test-harness";

import { resolveNemoclawStateDir } from "../../state/paths";
import { prepareManagedStateVolumes } from "../../onboard/managed-workload/managed-state-volumes";
import { removeManagedAgentStateVolumes } from "../../onboard/managed-workload/hermes-state-volume";
import {
  createMigrationHarness,
  cleanupMigrationHarness,
} from "../../onboard/managed-workload/managed-state-volume-migration.test-fixture";
import type { SandboxWorkloadReceipt } from "../../state/registry";

const managedHermesWorkload = {
  schemaVersion: 1,
  kind: "managed-image",
  reference: `ghcr.io/nvidia/nemoclaw/hermes@sha256:${"a".repeat(64)}`,
  platform: "linux/amd64",
  release: "v0.0.0",
  sourceRevision: "a".repeat(40),
  sourceCohort: "test-cohort",
  capabilityContractVersion: 1,
  startupProfileContractVersion: 1,
  encodedProfile: "e30",
  startupProfileSha256: "b".repeat(64),
  credentialProxyReplayRequired: true,
  shared: true,
} satisfies SandboxWorkloadReceipt;

describe("native agent destroy state cleanup", { timeout: 15_000 }, () => {
  let testHome: string;

  beforeEach(() => {
    testHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-destroy-dcode-home-"));
    vi.stubEnv("HOME", testHome);
    vi.spyOn(process, "exit").mockImplementation(((code?: number | string | null) => {
      throw new Error(`process.exit(${code ?? 0})`);
    }) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    resetDestroyModuleCache();
    fs.rmSync(testHome, { force: true, recursive: true });
  });

  it("clears sandbox-owned native state before sandbox deletion", async () => {
    const harness = createDestroyHarness({
      agent: "langchain-deepagents-code",
    });

    await expect(harness.destroySandbox("alpha", { yes: true })).resolves.toBeUndefined();

    const wipeCall = harness.runOpenshellSpy.mock.calls.findIndex(
      ([args]) =>
        Array.isArray(args) &&
        args[0] === "sandbox" &&
        args[1] === "exec" &&
        args[2] === "--name" &&
        args[3] === "alpha",
    );
    const deleteCall = harness.runOpenshellSpy.mock.calls.findIndex(
      ([args]) => Array.isArray(args) && args[0] === "sandbox" && args[1] === "delete",
    );
    expect(wipeCall).toBeGreaterThanOrEqual(0);
    expect(deleteCall).toBeGreaterThan(wipeCall);
    const wipeArgs = harness.runOpenshellSpy.mock.calls[wipeCall]![0] as string[];
    const wipeScript = wipeArgs[wipeArgs.indexOf("-c") + 1]!;
    expect(wipeScript).toContain("root='/sandbox'");
    expect(wipeScript).toContain('[ ! -d "$root" ] || [ -L "$root" ]');
    expect(wipeScript).toContain("is_exact_keep()");
    expect(wipeScript).toContain("is_keep_parent()");
    expect(wipeScript).toContain('rm -rf -- "$entry"');
    expect(wipeScript).toContain('clean_dir "$root" "$@"');
    expect(wipeScript).toContain('verify_dir "$root" "$@"');
    expect(wipeScript).toContain("agent native root retains sandbox-owned state");
    expect(wipeScript).toContain(
      'echo "agent native root retains sandbox-owned state" >&2\n  exit 22',
    );
    expect(wipeScript).not.toContain('find "$entry"');
    expect(wipeArgs.slice(wipeArgs.indexOf("-c") + 3)).toEqual([
      "/sandbox/.deepagents/.env",
      "/sandbox/.deepagents/.mcp.json",
    ]);
    expect(harness.removeSandboxSpy).toHaveBeenCalledWith("alpha");
  });

  it("preserves registered host-mount targets during native-root cleanup", async () => {
    const harness = createDestroyHarness({
      agent: "langchain-deepagents-code",
      registryEntryOverrides: {
        hostMounts: [
          {
            source: "/host/project",
            target: "/sandbox/project/source",
            readOnly: true,
            sourceIdentity: { device: "1", inode: "2" },
          },
        ],
      },
    });

    await expect(harness.destroySandbox("alpha", { yes: true })).resolves.toBeUndefined();

    const wipeArgs = harness.runOpenshellSpy.mock.calls.find(
      ([args]) => Array.isArray(args) && args[0] === "sandbox" && args[1] === "exec",
    )![0] as string[];
    const commandIndex = wipeArgs.indexOf("-c");
    const wipeScript = wipeArgs[commandIndex + 1]!;
    expect(wipeArgs.slice(commandIndex + 3)).toEqual([
      "/sandbox/.deepagents/.env",
      "/sandbox/.deepagents/.mcp.json",
      "/sandbox/project/source",
    ]);
    expect(wipeScript).toContain('[ "$candidate" != "$keep" ] || return 0');
    expect(wipeScript).toContain('[ "${keep#"$candidate"/}" = "$keep" ] || return 0');
    expect(wipeScript).toContain('if [ ! -d "$entry" ] || [ -L "$entry" ]');
    expect(harness.removeSandboxSpy).toHaveBeenCalledWith("alpha");
  });

  it("clears OpenClaw's complete native home before deletion", async () => {
    const harness = createDestroyHarness({ agent: "openclaw" });

    await expect(harness.destroySandbox("alpha", { yes: true })).resolves.toBeUndefined();

    const wipeArgs = harness.runOpenshellSpy.mock.calls.find(
      ([args]) => Array.isArray(args) && args[0] === "sandbox" && args[1] === "exec",
    )![0] as string[];
    const commandIndex = wipeArgs.indexOf("-c");
    expect(wipeArgs[commandIndex + 1]).toContain("root='/sandbox/.openclaw'");
    expect(wipeArgs.slice(commandIndex + 3)).toEqual([]);
    expect(harness.removeSandboxSpy).toHaveBeenCalledWith("alpha");
  });

  it("treats a legacy registry row without an agent as OpenClaw", async () => {
    const harness = createDestroyHarness({ registryEntryOverrides: { agent: null } });

    await expect(harness.destroySandbox("alpha", { yes: true })).resolves.toBeUndefined();

    const wipeArgs = harness.runOpenshellSpy.mock.calls.find(
      ([args]) => Array.isArray(args) && args[0] === "sandbox" && args[1] === "exec",
    )![0] as string[];
    expect(wipeArgs[wipeArgs.indexOf("-c") + 1]).toContain("root='/sandbox/.openclaw'");
  });

  it("clears Hermes native state while preserving its user-managed environment", async () => {
    const harness = createDestroyHarness({ agent: "hermes" });

    await expect(harness.destroySandbox("alpha", { yes: true })).resolves.toBeUndefined();

    const wipeArgs = harness.runOpenshellSpy.mock.calls.find(
      ([args]) => Array.isArray(args) && args[0] === "sandbox" && args[1] === "exec",
    )![0] as string[];
    const commandIndex = wipeArgs.indexOf("-c");
    expect(wipeArgs[commandIndex + 1]).toContain("root='/sandbox/.hermes'");
    expect(wipeArgs.slice(commandIndex + 3)).toEqual(["/sandbox/.hermes/.env"]);
    expect(harness.removeSandboxSpy).toHaveBeenCalledWith("alpha");
  });

  it("preserves ownership when complete native-root cleanup fails", async () => {
    const harness = createDestroyHarness({
      agent: "langchain-deepagents-code",
    });
    const defaultRun = harness.runOpenshellSpy.getMockImplementation()!;
    harness.runOpenshellSpy.mockImplementation((args: string[], options?: object) =>
      args[0] === "sandbox" && args[1] === "exec"
        ? {
            status: 21,
            stdout: "",
            stderr: "agent native root retains sandbox-owned state",
          }
        : defaultRun(args, options),
    );

    await expect(harness.destroySandbox("alpha", { yes: true })).rejects.toThrow("process.exit(1)");

    expect(
      harness.runOpenshellSpy.mock.calls.some(
        ([args]) => Array.isArray(args) && args[0] === "sandbox" && args[1] === "delete",
      ),
    ).toBe(false);
    expect(harness.removeSandboxSpy).not.toHaveBeenCalled();
    expect(harness.errorSpy.mock.calls.flat().join("\n")).toContain("registry entry was preserved");
  });
  it.each([
    ["removed", undefined],
    ["removed", "nemoclaw-hermes-state-v1-alpha"],
    ["absent", "nemoclaw-hermes-state-v1-alpha"],
  ] as const)(
    "finishes owned Hermes cleanup with selected volume %s and retained source %s",
    { timeout: 30_000 },
    async (status, retainedVolumeName) => {
      const harness = createDestroyHarness({
        agent: "hermes",
        openshellDriver: "docker",
        workload: managedHermesWorkload,
        managedAgentStateVolumeCleanupResults: [{ status, retainedVolumeName }],
      });

      await expect(harness.destroySandbox("alpha", { yes: true })).resolves.toBeUndefined();

      expect(harness.removeManagedAgentStateVolumesSpy).toHaveBeenCalledWith(
        {
          agentName: "hermes",
          runtimeProviderId: "docker",
          sandboxName: "alpha",
          workloadKind: "managed-image",
        },
        {
          runtimeProviders: expect.any(Object),
          workspace: "default",
          migrationStateDir: resolveNemoclawStateDir(),
        },
      );
      expect(harness.removeManagedAgentStateVolumesSpy.mock.invocationCallOrder[0]).toBeLessThan(
        harness.removeSandboxSpy.mock.invocationCallOrder[0],
      );
      const warnings = harness.warnSpy.mock.calls.map((call) => String(call[0])).join("\n");
      expect(warnings.match(/Retained pre-migration state volume '([^']+)'/u)?.[1]).toBe(
        retainedVolumeName,
      );
      expect(harness.removeSandboxSpy).toHaveBeenCalledWith("alpha");
    },
  );

  it.each([
    {
      authority: "selected-runtime",
      selected: true,
      observedWorkspace: "default",
      ambient: "unrelated-workspace",
      rejected: false,
    },
    {
      authority: "observed-container",
      selected: false,
      observedWorkspace: "selected-workspace",
      ambient: "unrelated-workspace",
      rejected: false,
    },
    {
      authority: "selected-command",
      selected: false,
      observedWorkspace: null,
      ambient: "selected-workspace",
      rejected: false,
    },
    {
      authority: "unproven-workspace",
      selected: false,
      observedWorkspace: null,
      ambient: "unrelated-workspace",
      rejected: true,
    },
  ])(
    "retains original state during destroy with $authority",
    async ({ selected, observedWorkspace, ambient, rejected }) => {
      const h = createMigrationHarness("hermes");
      onTestFinished(cleanupMigrationHarness);
      const workspace = "selected-workspace";
      const migrationStateDir = resolveNemoclawStateDir(testHome, 19080);
      const scope = prepareManagedStateVolumes(h.input, {
        ...h.deps,
        workspace,
        migrationStateDir,
      })!;
      scope.commit();
      const destination = scope.mounts[0]!.source;
      const sourceBefore = JSON.stringify(h.source);
      const harness = createDestroyHarness({
        agent: "hermes",
        openshellDriver: "docker",
        workload: managedHermesWorkload,
        registryGatewayPort: 19080,
        executeSandboxDestroyResult: {
          ok: true,
          alreadyGone: false,
          deleteOutput: "",
          deleteResult: { kind: "accepted", diagnostic: "", exitCode: 0 },
          detachOutcome: { detached: [], failures: [] },
          forcedLocalCleanup: false,
          ...(selected ? { runtimeSelection: { gatewayName: "nemoclaw-19080", workspace } } : {}),
        },
      });
      harness.assertDestroyIdentitySpy.mockReturnValue({
        identities: observedWorkspace
          ? [
              {
                id: "a".repeat(64),
                managedBy: "openshell",
                workspace: observedWorkspace,
                sandboxId: "sb-alpha",
              },
            ]
          : [],
      });
      harness.removeManagedAgentStateVolumesSpy.mockImplementation((context, deps) =>
        removeManagedAgentStateVolumes(context, {
          ...deps,
          runtimeProvider: {
            ...deps.runtimeProviders.docker,
            containerEngine: {
              ...deps.runtimeProviders.docker.containerEngine,
              capture: (_operation: string, args: readonly string[]) => h.run(args),
            },
          },
        }),
      );
      vi.stubEnv("OPENSHELL_WORKSPACE", ambient);
      const result = await harness
        .destroySandbox("alpha", { yes: true, cleanupGateway: false })
        .then(
          () => null,
          (error: Error) => error.message,
        );
      expect(result).toEqual(rejected ? expect.stringContaining("another scope") : null);
      expect(h.volumes.has(destination)).toBe(rejected);
      expect(h.volumes.get(h.source.Name)).toBe(h.source);
      expect(JSON.stringify(h.source)).toBe(sourceBefore);
      expect(h.calls).not.toContainEqual(["volume", "rm", h.source.Name]);
      expect(harness.removeSandboxSpy.mock.calls).toEqual(rejected ? [] : [["alpha"]]);
    },
  );

  it("preserves the registry when owned managed Hermes state-volume cleanup fails", async () => {
    const harness = createDestroyHarness({
      agent: "hermes",
      openshellDriver: "docker",
      workload: managedHermesWorkload,
      managedAgentStateVolumeCleanupResults: [
        {
          status: "failed",
          detail: "volume is still in use",
          volumeName: "nemoclaw-hermes-state-v1-alpha",
        },
      ],
    });

    await expect(harness.destroySandbox("alpha", { yes: true })).rejects.toThrow("process.exit(1)");

    expect(harness.removeSandboxSpy).not.toHaveBeenCalled();
    expect(harness.errorSpy.mock.calls.map((call) => String(call[0])).join("\n")).toContain(
      "volume is still in use",
    );
  });

  it("leaves a foreign same-name Hermes volume untouched and completes registry cleanup", async () => {
    const harness = createDestroyHarness({
      agent: "hermes",
      openshellDriver: "docker",
      workload: managedHermesWorkload,
      managedAgentStateVolumeCleanupResults: [
        {
          status: "not-owned",
          detail: "the exact NemoClaw ownership labels are absent or changed",
          volumeName: "nemoclaw-hermes-state-v1-alpha",
        },
      ],
    });

    await expect(harness.destroySandbox("alpha", { yes: true })).resolves.toBeUndefined();

    expect(harness.warnSpy.mock.calls.map((call) => String(call[0])).join("\n")).toContain(
      "Left managed state volume 'nemoclaw-hermes-state-v1-alpha' untouched",
    );
    expect(harness.removeSandboxSpy).toHaveBeenCalledWith("alpha");
  });
});
