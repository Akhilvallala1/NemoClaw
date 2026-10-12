// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostCliClient } from "../fixtures/clients/host.ts";
import { SandboxClient } from "../fixtures/clients/sandbox.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";
import { cleanupSandbox } from "../live/inference-routing-helpers.ts";

const state = vi.hoisted(() => ({ gatewayName: null as string | null }));
vi.mock("../../../src/lib/state/registry.ts", () => ({
  getSandbox: () => (state.gatewayName ? { gatewayName: state.gatewayName } : null),
}));

function result(patch: Partial<ShellProbeResult> = {}): ShellProbeResult {
  return {
    command: [],
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: "",
    stderr: "",
    artifacts: { stdout: "", stderr: "", result: "" },
    ...patch,
  };
}

function fixture(destroy: ShellProbeResult, observation: ShellProbeResult) {
  const run = vi.fn().mockResolvedValue(observation).mockResolvedValueOnce(destroy);
  const cleared = vi.spyOn(fs, "rmSync").mockImplementation(() => undefined);
  return { run, cleared, host: new HostCliClient({ run }), sandbox: new SandboxClient({ run }) };
}

afterEach(() => vi.restoreAllMocks());
beforeEach(() => {
  state.gatewayName = null;
});

describe("strict inference routing cleanup", () => {
  it("keeps recovery authority when the CLI refuses retained sandbox destruction (#12636)", async () => {
    const f = fixture(
      result({
        exitCode: 1,
        stderr: "Refusing to destroy retained sandbox because recovery authority conflicts.",
      }),
      result(),
    );
    await expect(cleanupSandbox(f.host, f.sandbox, "e2e-peer", { strict: true })).rejects.toThrow(
      "recovery authority conflicts",
    );
    expect(f.run).toHaveBeenCalledOnce();
    expect(f.cleared).not.toHaveBeenCalled();
  });

  it.each([
    [
      "unsupported command",
      result({ exitCode: 2, stderr: "error: unrecognized subcommand 'status'" }),
    ],
    ["gateway failure", result({ exitCode: 1, stderr: "Unknown gateway 'nemoclaw'" })],
    ["timeout", result({ exitCode: 1, timedOut: true, stderr: "sandbox not found" })],
    ["still present", result({ stdout: "sandbox exists" })],
  ])("refuses %s as sandbox absence evidence (#12636)", async (_label, observation) => {
    const f = fixture(result(), observation);
    await expect(cleanupSandbox(f.host, f.sandbox, "e2e-peer", { strict: true })).rejects.toThrow(
      "absence was not confirmed",
    );
    expect(f.cleared).not.toHaveBeenCalled();
  });

  it.each([
    ["nemoclaw", null],
    ["nemoclaw-8090", "nemoclaw-8090"],
  ] as const)(
    "confirms absence on gateway %s without clearing unrelated recovery state (#12636)",
    async (gatewayName, registeredGateway) => {
      state.gatewayName = registeredGateway;
      const f = fixture(result(), result({ exitCode: 1, stderr: "Error: sandbox not found" }));
      await cleanupSandbox(f.host, f.sandbox, "e2e-peer", {
        strict: true,
        env: { OPENSHELL_GATEWAY: "nemoclaw" },
      });
      expect(f.run.mock.calls.map(([command]) => command.args)).toEqual([
        expect.arrayContaining(["e2e-peer", "destroy", "--yes", "--no-cleanup-gateway"]),
        ["sandbox", "get", "e2e-peer", "-g", gatewayName],
      ]);
      expect(f.cleared).not.toHaveBeenCalled();
    },
  );
});
