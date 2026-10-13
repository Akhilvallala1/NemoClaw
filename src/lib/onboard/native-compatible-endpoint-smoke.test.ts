// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import * as nativeCustom from "../inference/native-custom";
import * as providerAdapterCli from "../adapters/openshell/provider-adapter-cli";
import type { OpenShellSandboxBufferedCommandRequest } from "../adapters/openshell/sandbox-command";
import {
  createCompatibleEndpointSmoke,
  verifyCompatibleEndpointSandboxSmoke,
} from "./compatible-endpoint-smoke";

describe("native custom onboarding inference verification", () => {
  it.each([
    { agentName: "openclaw", command: "sh", home: undefined },
    { agentName: "hermes", command: "sh", home: undefined },
    {
      agentName: "langchain-deepagents-code",
      command: "/usr/local/lib/nemoclaw/dcode-managed-exec",
      home: "/usr/local/lib/nemoclaw",
    },
  ])(
    "verifies attached native inference for $agentName without the shared route",
    async ({ agentName, command: expectedCommand, home: expectedHome }) => {
      const prepared = await nativeCustom.prepareNativeCustomProfile({
        sandboxName: "smoke-sandbox",
        provider: "compatible-endpoint",
        endpointUrl: "https://api.example.com/v1",
        api: "openai-completions",
        lookup: async () => [{ address: "8.8.8.8", family: 4 }],
      });
      const receipt = nativeCustom.customAttachmentFromPrepared(prepared, {
        schemaVersion: 1,
        profileId: prepared.profile.id,
        providerName: prepared.providerName,
        providerId: "native-id",
      });
      const verify = vi
        .spyOn(nativeCustom, "verifyNativeCustomProviderAttachment")
        .mockResolvedValue(receipt);
      const adapterFactory = vi.spyOn(providerAdapterCli, "createCliOpenShellProviderAdapter");
      const executor = {
        runBuffered: vi.fn(async (_request: OpenShellSandboxBufferedCommandRequest) => ({
          outcome: { kind: "completed" as const, exitCode: 0 },
          stdout: '200\n{"choices":[{"message":{"content":"OK"}}]}',
          stderr: "",
        })),
      };
      try {
        await verifyCompatibleEndpointSandboxSmoke({
          sandboxName: "smoke-sandbox",
          provider: "compatible-endpoint",
          model: "example-model",
          gatewayName: "gateway",
          nativeCustomProviderAttachment: receipt,
          runOpenshell: vi.fn(),
          sandboxCommandExecutor: executor,
          redact: (value) => value,
          agent: { name: agentName },
        });
        expect(verify).toHaveBeenCalledWith(
          expect.objectContaining({
            sandboxName: "smoke-sandbox",
            expected: receipt,
            target: { kind: "named", gatewayName: "gateway" },
          }),
        );
        expect(executor.runBuffered).toHaveBeenCalledOnce();
        const command = executor.runBuffered.mock.calls[0]?.[0] as
          | OpenShellSandboxBufferedCommandRequest
          | undefined;
        expect(command?.command.join(" ")).toContain("https://api.example.com/v1/chat/completions");
        expect(command?.command.join(" ")).not.toContain("inference.local");
        expect(command?.target).toEqual({ kind: "named", gatewayName: "gateway" });
        expect(command?.command[0]).toBe(expectedCommand);
        expect(command?.sandboxEnvironment?.HOME).toBe(expectedHome);
        const environment = { HOME: "/rebuild-owner", NEMOCLAW_GATEWAY_PORT: "8642" };
        const smoke = createCompatibleEndpointSmoke(vi.fn(), executor, (value) => value);
        await smoke.verifyRebuilt({
          sandboxName: "smoke-sandbox",
          provider: "compatible-endpoint",
          model: "example-model",
          gatewayName: "gateway",
          nativeCustomProviderAttachment: receipt,
          environment,
        });
        expect(adapterFactory).toHaveBeenCalledWith({ environment });
        expect(executor.runBuffered).toHaveBeenLastCalledWith(
          expect.objectContaining({
            environment,
            target: { kind: "named", gatewayName: "gateway" },
          }),
        );
        verify.mockRejectedValueOnce(new Error("attachment replaced"));
        executor.runBuffered.mockClear();
        await expect(
          verifyCompatibleEndpointSandboxSmoke({
            sandboxName: "smoke-sandbox",
            provider: "compatible-endpoint",
            model: "example-model",
            gatewayName: "gateway",
            nativeCustomProviderAttachment: receipt,
            runOpenshell: vi.fn(),
            sandboxCommandExecutor: executor,
            redact: (value) => value,
            onFailure: () => {
              throw new Error("verification failed");
            },
          }),
        ).rejects.toThrow("verification failed");
        expect(executor.runBuffered).not.toHaveBeenCalled();
      } finally {
        verify.mockRestore();
        adapterFactory.mockRestore();
      }
    },
  );
});
