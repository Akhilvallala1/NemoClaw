// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  completeOrdinaryOnboardSandboxCreation,
  createOnboardCreatedSandboxRegistration,
} from "./created-sandbox-finalization";
import type { HermesPortableConfiguredReceipt } from "./experimental/hermes-portable-receipt";

afterEach(() => vi.restoreAllMocks());

describe("created sandbox registration authority", () => {
  it("refuses legacy Hermes resume without an in-process verified create checkpoint (#9833)", async () => {
    const complete = vi.fn();
    const cleanupBuildContext = vi.fn();
    const register = createOnboardCreatedSandboxRegistration({
      completion: { complete },
      createdLifecycle: {} as never,
      cleanupBuildContext,
      manageDashboard: false,
      sandboxGpuEnabled: false,
    });

    await expect(
      register(
        null,
        {
          lifecycleGeneration: "generation-1",
        } as HermesPortableConfiguredReceipt,
        "a".repeat(64),
        vi.fn(),
      ),
    ).rejects.toThrow(/without a verified create checkpoint from this process/u);

    expect(cleanupBuildContext).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });
});

describe("new sandbox cancellation recovery", () => {
  it("preserves recovery guidance when the durable identity is unavailable (#9833)", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const runFile = vi.fn();
    const armCancelRollback = vi.fn();
    const markCancellationRecovery = vi.fn();

    await expect(
      completeOrdinaryOnboardSandboxCreation(
        {
          sandboxName: "new-sandbox",
          sandboxWasLiveDefault: false,
          gatewayPort: 8080,
          runtimeFields: { openshellDriver: "docker" } as never,
          messagingProviders: [],
          liveExists: false,
        },
        {
          setDefault: vi.fn(),
          runFile,
          scriptsDir: "/repo/scripts",
          gatewayName: "nemoclaw",
          providerExistsInGateway: () => true,
          armCancelRollback,
          markCancellationRecovery,
          dockerInfoFormat: () => "",
          runCapture: () => "",
          revalidateSandboxIdentity: vi.fn(),
          applyVmDnsMonkeypatch: vi.fn(),
        },
      ),
    ).rejects.toThrow("Sandbox 'new-sandbox' has no exact identity for cancel recovery.");

    const guidance = error.mock.calls.flat().join("\n");
    expect(guidance).toContain("Sandbox 'new-sandbox' was created on gateway 'nemoclaw'");
    expect(guidance).toContain("registry entry and onboarding session were preserved");
    expect(guidance).toContain("Do not delete the sandbox by mutable sandbox name");
    expect(guidance).toContain("can clear retained recovery only after OpenShell confirms");
    expect(guidance).toContain("use a different explicit sandbox name");
    expect(guidance).not.toContain("administrator");
    expect(runFile).not.toHaveBeenCalled();
    expect(armCancelRollback).not.toHaveBeenCalled();
    expect(markCancellationRecovery).toHaveBeenCalledOnce();
    expect(markCancellationRecovery).toHaveBeenCalledWith("new-sandbox");
  });
});
