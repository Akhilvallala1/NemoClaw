// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import type { PodmanBoundContainerEngine } from "../../adapters/podman";
import { createHermesStateVolumeDockerHarness } from "../../onboard/__test-helpers__/hermes-state-volume";
import { createDockerRuntimeProviderBundle } from "../../onboard/runtime-provider/docker";
import { createPodmanRuntimeProviderBundle } from "../../onboard/runtime-provider/podman";
import { createRuntimeProviderBundleRegistry } from "../../onboard/runtime-provider/registry";
import {
  managedAgentStateVolumeContext,
  removeManagedStateVolumesForUninstall,
} from "./managed-state-uninstall-cleanup";
import { managedStartupStateRoots } from "../../onboard/managed-startup/state-roots";
import { prepareManagedStateVolumes } from "../../onboard/managed-workload/managed-state-volumes";
import {
  createMigrationHarness,
  cleanupMigrationHarness,
} from "../../onboard/managed-workload/managed-state-volume-migration.test-fixture";
import * as sandboxProviderCleanup from "../../onboard/sandbox-provider-cleanup";
import { withSuccessfulPreUninstallBackup } from "../../../../test/support/uninstall-managed-gateway-test-support";

import {
  type RunResult,
  runUninstallPlanProduction as runUninstallPlanBase,
  type UninstallRunDeps,
  type UninstallRunOptions,
} from "./run-plan";

afterEach(cleanupMigrationHarness);

function ok(stdout = ""): RunResult {
  return { status: 0, stdout, stderr: "" };
}

async function runUninstallPlan(options: UninstallRunOptions, deps: UninstallRunDeps) {
  return await runUninstallPlanBase(
    options,
    withSuccessfulPreUninstallBackup({
      resolveGatewayTeardownAuthority: ({ gatewayName, gatewayPort }) => ({
        gatewayName,
        gatewayPort,
        mode: "nemoclaw-managed",
        source: gatewayPort === 8080 ? "packaged-service" : "standalone",
        endpoint: null,
        stateDir: null,
        supervisor: null,
        requiredCapabilities: [],
      }),
      ...deps,
    }),
  );
}

async function runManagedHermesVolumeUninstall(
  mode: "foreign" | "owned" | "remove-fails" | "remove-fails-once",
  destroyUserData: boolean,
  containerMode: "absent" | "foreign" | "owned" = "absent",
  agent: "hermes" | "openclaw" = "hermes",
) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-hermes-volume-"));
  const stateDir = path.join(home, ".nemoclaw");
  const registryFile = path.join(stateDir, "sandboxes.json");
  const root = managedStartupStateRoots({
    agent,
    sandboxName: "hermes",
    agentIdentity: { uid: 1000, gid: 1000 },
  })[0]!;
  const volumeName = root.resourceIdentity;
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    registryFile,
    JSON.stringify({
      defaultSandbox: "hermes",
      sandboxes: {
        hermes: {
          agent,
          gatewayName: "nemoclaw",
          gatewayPort: 8080,
          name: "hermes",
          openshellDriver: "docker",
          workload: { kind: "managed-image" },
        },
      },
    }),
  );

  const dockerCalls: string[][] = [];
  const errors: string[] = [];
  const events: string[] = [];
  const logs: string[] = [];
  const containerId = "hermes-sandbox-container";
  let containerPresent = containerMode !== "absent";
  let gatewayRegistered = true;
  let volumeRemovalAttempts = 0;
  let volumePresent = true;
  const run = vi.fn((command: string, args: string[]) => {
    events.push(`${command} ${args.join(" ")}`);
    switch (`${command} ${args.join(" ")}`) {
      case "openshell gateway list":
      case "openshell gateway list -o json":
        return ok(JSON.stringify(gatewayRegistered ? [{ name: "nemoclaw" }] : []));
      case "openshell gateway remove nemoclaw":
        gatewayRegistered = false;
        return ok();
      case "openshell sandbox delete --all":
        return gatewayRegistered
          ? ok()
          : { status: 1, stdout: "", stderr: "Unknown gateway 'nemoclaw'" };
      default:
        return ok();
    }
  });
  const runDocker = vi.fn((args: string[]) => {
    dockerCalls.push(args);
    events.push(`docker ${args.join(" ")}`);
    switch (args.join(" ")) {
      case "ps -a --format {{.ID}} {{.Image}} {{.Names}}":
        switch (containerPresent ? containerMode : "absent") {
          case "owned":
            return ok(
              `${containerId} ghcr.io/nvidia/nemoclaw/hermes-sandbox:latest openshell-default--hermes-runtime-id\n`,
            );
          case "foreign":
            return ok(`${containerId} redis:7 foreign-service\n`);
          default:
            return ok();
        }
      case `rm -f ${containerId}`:
        containerPresent = false;
        return ok(`${containerId}\n`);
      case `volume inspect --format {{json .}} ${volumeName}`:
        return volumePresent
          ? ok(
              `${JSON.stringify({
                Labels:
                  mode === "foreign" ? { "com.example.owner": "foreign" } : root.ownershipLabels,
                Name: volumeName,
              })}\n`,
            )
          : { status: 1, stdout: "", stderr: `Error: no such volume: ${volumeName}` };
      case `volume rm ${volumeName}`:
        switch (containerPresent ? "attached" : mode) {
          case "attached":
          case "remove-fails":
            return { status: 1, stdout: "", stderr: "volume is still in use" };
          case "remove-fails-once":
            volumeRemovalAttempts += 1;
            switch (volumeRemovalAttempts) {
              case 1:
                return { status: 1, stdout: "", stderr: "volume is still in use" };
              default:
                volumePresent = false;
                return ok(`${volumeName}\n`);
            }
          default:
            volumePresent = false;
            return ok(`${volumeName}\n`);
        }
      case "volume inspect openshell-cluster-nemoclaw":
        return { status: 1, stdout: "", stderr: "Error: no such volume" };
      default:
        return ok();
    }
  });

  const execute = () =>
    runUninstallPlan(
      { assumeYes: true, deleteModels: false, destroyUserData, keepOpenShell: false },
      {
        commandExists: () => true,
        env: { HOME: home } as NodeJS.ProcessEnv,
        error: (line) => errors.push(line),
        existsSync: (target) => target.startsWith(home) && fs.existsSync(target),
        hasPortableRuntimeCleanup: () => false,
        isTty: false,
        kill: () => true,
        log: (line) => logs.push(line),
        rmSync: fs.rmSync,
        run,
        runDocker,
        runtimeProviders: createRuntimeProviderBundleRegistry([
          [
            "docker",
            createDockerRuntimeProviderBundle({
              captureHostCommand: (_command, args) => {
                const result = runDocker(args);
                return {
                  status: result.status ?? 1,
                  stdout: result.stdout,
                  stderr: result.stderr,
                };
              },
            }),
          ],
        ]),
      },
    );
  const result = await execute();

  return {
    cleanup: () => fs.rmSync(home, { force: true, recursive: true }),
    containerId,
    containerPresent: () => containerPresent,
    dockerCalls,
    errors,
    events,
    gatewayRegistered: () => gatewayRegistered,
    logs,
    registryFile,
    result,
    retry: execute,
    volumeName,
    volumePresent: () => volumePresent,
  };
}

describe("managed agent state volume uninstall", () => {
  it.each(["removed", "absent"] as const)(
    "reports the retained migration source when the selected volume is %s",
    (status) => {
      const retainedVolumeName = "nemoclaw-hermes-state-v1-hermes";
      const remove = vi
        .spyOn(sandboxProviderCleanup, "removeManagedAgentStateVolumes")
        .mockReturnValue([{ status, retainedVolumeName }]);
      const warn = vi.fn();
      try {
        expect(
          removeManagedStateVolumesForUninstall(
            [
              {
                agentName: "hermes",
                runtimeProviderId: "docker",
                sandboxName: "hermes",
                workloadKind: "managed-image",
              },
            ],
            { env: {}, error: vi.fn(), log: vi.fn(), warn, runDocker: vi.fn() },
          ),
        ).toBe(true);
        expect(warn.mock.calls.map((call) => String(call[0])).join("\n")).toContain(
          `Retained pre-migration state volume '${retainedVolumeName}'`,
        );
      } finally {
        remove.mockRestore();
      }
    },
  );

  it("dispatches a Podman-owned volume through provider cleanup authority", () => {
    const volume = createHermesStateVolumeDockerHarness();
    volume.runDocker([
      "create",
      "--label",
      "io.nvidia.nemoclaw.hermes-state.managed=true",
      "--label",
      "io.nvidia.nemoclaw.hermes-state.sandbox=hermes",
      "--label",
      "io.nvidia.nemoclaw.hermes-state.schema=1",
      "--label",
      "io.nvidia.nemoclaw.hermes-state.target=/sandbox/.hermes",
      "nemoclaw-hermes-state-v1-hermes",
    ]);
    const capture = vi.fn((args: readonly string[]) => {
      const result = volume.runDocker(args.slice(1));
      return {
        status: result.status ?? 1,
        stdout: String(result.stdout ?? ""),
        stderr: String(result.stderr ?? ""),
      };
    });
    const engine = (
      operation: PodmanBoundContainerEngine["operation"],
      operationCapture = vi.fn(),
    ) =>
      ({
        operation,
        engineId: "podman",
        displayName: "Podman",
        authorityId: `podman:${operation}`,
        endpointAuthorityId: "podman:test-endpoint",
        capture: operationCapture,
        captureHost: operationCapture,
        assertAuthority: vi.fn(),
      }) satisfies PodmanBoundContainerEngine;
    const provider = createPodmanRuntimeProviderBundle({
      engines: {
        hostDoctor: engine("host-doctor"),
        sandboxLifecycle: engine("sandbox-lifecycle"),
        workloadCleanup: engine("workload-cleanup", capture),
      },
    });
    const runDocker = vi.fn(() => {
      throw new Error("Podman uninstall reached Docker");
    });

    expect(
      removeManagedStateVolumesForUninstall(
        [
          {
            agentName: "hermes",
            runtimeProviderId: "podman",
            sandboxName: "hermes",
            workloadKind: "managed-image",
          },
        ],
        {
          env: {},
          error: vi.fn(),
          log: vi.fn(),
          runDocker,
          runtimeProviders: createRuntimeProviderBundleRegistry([["podman", provider]]),
          warn: vi.fn(),
        },
      ),
    ).toBe(true);
    expect(capture).toHaveBeenCalledWith(
      ["volume", "rm", "nemoclaw-hermes-state-v1-hermes"],
      30_000,
    );
    expect(runDocker).not.toHaveBeenCalled();
  });

  it.each([
    ["hermes", false],
    ["hermes", true],
    ["openclaw", false],
    ["openclaw", true],
  ] as const)(
    "removes an owned %s volume with destroy-user-data=%s",
    async (agent, destroyUserData) => {
      const harness = await runManagedHermesVolumeUninstall(
        "owned",
        destroyUserData,
        "absent",
        agent,
      );
      try {
        expect(harness.result.exitCode, harness.errors.join("\n")).toBe(0);
        expect(harness.volumePresent()).toBe(false);
        expect(harness.dockerCalls).toContainEqual(["volume", "rm", harness.volumeName]);
        expect(harness.events.indexOf("openshell sandbox delete --all")).toBeLessThan(
          harness.events.indexOf(`docker volume rm ${harness.volumeName}`),
        );
        expect(harness.logs).toContain("Removed managed agent state volume for 'hermes'.");
      } finally {
        harness.cleanup();
      }
    },
  );

  it("uninstall retains migrated OpenClaw originals and foreign volumes", () => {
    const h = createMigrationHarness("openclaw");
    const scope = prepareManagedStateVolumes(h.input, h.deps)!;
    scope.commit();
    const selected = scope.mounts[0]!.source;
    const foreign = { ...h.source, Name: "foreign", Labels: { owner: "other" } };
    h.volumes.set(foreign.Name, foreign);
    const original = JSON.stringify(h.source);
    const warn = vi.fn();
    const capture = (_command: string, args: readonly string[]) => {
      const result = h.run(args);
      return {
        status: result.status ?? 1,
        stdout: String(result.stdout ?? ""),
        stderr: String(result.stderr ?? ""),
      };
    };
    expect(
      removeManagedStateVolumesForUninstall(
        [
          managedAgentStateVolumeContext("alpha", {
            agent: "openclaw",
            openshellDriver: "docker",
            workload: { kind: "managed-image" },
          }),
        ],
        {
          env: {},
          error: vi.fn(),
          log: vi.fn(),
          warn,
          runDocker: vi.fn(),
          runtimeProviders: createRuntimeProviderBundleRegistry([
            ["docker", createDockerRuntimeProviderBundle({ captureHostCommand: capture })],
          ]),
        },
        h.stateDir,
      ),
    ).toBe(true);
    expect(h.volumes.has(selected)).toBe(false);
    expect(JSON.stringify(h.volumes.get(h.source.Name))).toBe(original);
    expect(h.volumes.get(foreign.Name)).toEqual(foreign);
    expect(warn.mock.calls.flat().join("\n")).toContain(
      `Retained pre-migration state volume '${h.source.Name}'`,
    );
  });

  it("keeps a same-name foreign volume", async () => {
    const harness = await runManagedHermesVolumeUninstall("foreign", true);
    try {
      expect(harness.result.exitCode, harness.errors.join("\n")).toBe(0);
      expect(harness.volumePresent()).toBe(true);
      expect(harness.dockerCalls).not.toContainEqual(["volume", "rm", harness.volumeName]);
      expect(harness.errors.join("\n")).toContain(
        `Left managed state volume '${harness.volumeName}' untouched because the exact NemoClaw ownership labels are absent or changed.`,
      );
    } finally {
      harness.cleanup();
    }
  });

  it("preserves uninstall state when volume removal fails", async () => {
    const harness = await runManagedHermesVolumeUninstall("remove-fails", true);
    try {
      expect(harness.result.exitCode).toBe(1);
      expect(harness.volumePresent()).toBe(true);
      expect(fs.existsSync(harness.registryFile)).toBe(true);
      expect(harness.events.some((event) => event.startsWith("npm "))).toBe(false);
      expect(harness.errors).toContain(
        `Managed agent state volume '${harness.volumeName}' could not be removed.`,
      );
      expect(harness.errors).toContain("Preserved NemoClaw state so exact cleanup can be retried.");
    } finally {
      harness.cleanup();
    }
  });

  it("retries volume cleanup before removing the gateway registration", async () => {
    const harness = await runManagedHermesVolumeUninstall("remove-fails-once", true);
    try {
      expect(harness.result.exitCode).toBe(1);
      expect(harness.gatewayRegistered()).toBe(true);
      expect(harness.volumePresent()).toBe(true);
      expect(fs.existsSync(harness.registryFile)).toBe(true);

      const retry = await harness.retry();

      expect(retry.exitCode, harness.errors.join("\n")).toBe(0);
      expect(harness.gatewayRegistered()).toBe(false);
      expect(harness.volumePresent()).toBe(false);
      expect(fs.existsSync(harness.registryFile)).toBe(false);
    } finally {
      harness.cleanup();
    }
  });

  it("preserves a stopped sandbox and its state when the owning runtime leaves it behind", async () => {
    const harness = await runManagedHermesVolumeUninstall("owned", true, "owned");
    try {
      expect(harness.result.exitCode).toBe(1);
      expect(harness.containerPresent()).toBe(true);
      expect(harness.volumePresent()).toBe(true);
      expect(harness.dockerCalls).not.toContainEqual(["rm", "-f", harness.containerId]);
      expect(harness.dockerCalls).not.toContainEqual(["volume", "rm", harness.volumeName]);
      expect(fs.existsSync(harness.registryFile)).toBe(true);
      expect(harness.errors.join("\n")).toContain("sandboxes are absent: hermes");
    } finally {
      harness.cleanup();
    }
  });

  it("keeps a foreign container that prevents Hermes state volume removal", async () => {
    const harness = await runManagedHermesVolumeUninstall("owned", true, "foreign");
    try {
      expect(harness.result.exitCode).toBe(1);
      expect(harness.containerPresent()).toBe(true);
      expect(harness.volumePresent()).toBe(true);
      expect(harness.dockerCalls).not.toContainEqual(["rm", "-f", harness.containerId]);
      expect(fs.existsSync(harness.registryFile)).toBe(true);
    } finally {
      harness.cleanup();
    }
  });
});
