// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";

import {
  configureFailedGatewayRestoration,
  createDestroyHarness,
  resetDestroyModuleCache,
} from "../../../../test/helpers/destroy-flow-test-harness";

describe("destroySandbox gateway restoration telemetry", () => {
  let exitSpy: MockInstance;
  let originalGatewayEnv: string | undefined;
  let testHome: string;

  beforeEach(() => {
    testHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-destroy-telemetry-home-"));
    vi.stubEnv("HOME", testHome);
    originalGatewayEnv = process.env.OPENSHELL_GATEWAY;
    exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number | string | null) => {
      throw new Error(`process.exit(${code ?? 0})`);
    }) as never);
  });

  afterEach(() => {
    originalGatewayEnv === undefined
      ? delete process.env.OPENSHELL_GATEWAY
      : (process.env.OPENSHELL_GATEWAY = originalGatewayEnv);
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    resetDestroyModuleCache();
    fs.rmSync(testHome, { force: true, recursive: true });
  });

  it("records destroy as failed when active-gateway restoration fails after deletion", async () => {
    const harness = createDestroyHarness({ callThroughGatewaySelection: true });
    configureFailedGatewayRestoration(harness);

    await expect(
      harness.destroySandbox("alpha", { yes: true, cleanupGateway: false }),
    ).rejects.toThrow(/could not be restored/u);

    expect(harness.removeSandboxSpy).toHaveBeenCalledWith("alpha");
    expect(harness.runOpenshellSpy).toHaveBeenCalledWith(
      expect.arrayContaining(["gateway", "select", "beta"]),
      expect.anything(),
    );
    expect(harness.recordDestroyCompletionSpy).toHaveBeenCalledExactlyOnceWith(
      "alpha",
      "failed",
      undefined,
      "nemoclaw-19080",
      true,
    );
    expect(exitSpy).not.toHaveBeenCalled();
  });
});
