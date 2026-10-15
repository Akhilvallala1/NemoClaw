// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import {
  customAttachmentFromPrepared,
  prepareNativeCustomProfile,
} from "../../../src/lib/inference/native-custom/index.ts";
import type { SandboxClient } from "../fixtures/clients/sandbox.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";
import {
  PUBLIC_NVIDIA_SWITCH_ATTACHMENT_EVIDENCE,
  PUBLIC_NVIDIA_SWITCH_MODEL,
  PUBLIC_NVIDIA_SWITCH_PROVIDER,
  readPublicNvidiaSwitchAttachmentEvidence,
  requirePublicNvidiaSwitchKey,
  readNativeCustomAttachmentEvidence,
  NATIVE_CUSTOM_ATTACHMENT_EVIDENCE,
} from "../live/public-nvidia-switch-provider.ts";

describe("public NVIDIA inference switch provider", () => {
  it.each(["matching", "replaced", "detached"])(
    "checks native custom identity and attachment: %s",
    async (state) => {
      const prepared = await prepareNativeCustomProfile({
        sandboxName: "e2e-full",
        provider: "compatible-endpoint",
        endpointUrl: "https://api.example.com/v1",
        api: "openai-completions",
        lookup: async () => [{ address: "8.8.8.8", family: 4 }],
      });
      const receipt = customAttachmentFromPrepared(prepared, {
        schemaVersion: 1,
        profileId: prepared.profile.id,
        providerName: prepared.providerName,
        providerId: "provider-id",
      });
      const openshell = vi
        .fn()
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: [
            `Name: ${receipt.providerName}`,
            `Id: ${state === "replaced" ? "other-id" : receipt.providerId}`,
            `Type: ${receipt.profileId}`,
            "Resource version: 1",
            "Credential keys: COMPATIBLE_API_KEY",
            "Config keys: <none>",
          ].join("\n"),
        })
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: state === "detached" ? "" : receipt.providerName,
        });
      const input = {
        artifactName: "custom",
        env: { OPENSHELL_GATEWAY: "owned-gateway" },
        receipt,
        sandbox: { openshell } as unknown as SandboxClient,
        sandboxName: "e2e-full",
      };
      const evidence = await readNativeCustomAttachmentEvidence(input);
      expect(evidence === NATIVE_CUSTOM_ATTACHMENT_EVIDENCE).toBe(state === "matching");
      expect(openshell.mock.calls[0][0]).toEqual([
        "provider",
        "get",
        "-g",
        "owned-gateway",
        receipt.providerName,
      ]);
      expect(await readNativeCustomAttachmentEvidence({ ...input, receipt: undefined })).not.toBe(
        NATIVE_CUSTOM_ATTACHMENT_EVIDENCE,
      );
      expect(
        await readNativeCustomAttachmentEvidence({ ...input, sandboxName: "another-sandbox" }),
      ).not.toBe(NATIVE_CUSTOM_ATTACHMENT_EVIDENCE);
    },
  );
  it("inspects the declared Launchable gateway instead of the default gateway", async () => {
    const openshell = vi.fn().mockResolvedValue({ exitCode: 1, stdout: "", stderr: "" });
    await readPublicNvidiaSwitchAttachmentEvidence({
      artifactName: "launchable-provider",
      env: { OPENSHELL_GATEWAY: "nemoclaw-18080" },
      logicalProvider: PUBLIC_NVIDIA_SWITCH_PROVIDER,
      receipt: undefined,
      sandbox: { openshell } as unknown as SandboxClient,
      sandboxName: "e2e-staging",
    });
    expect(openshell.mock.calls.map(([args]) => args)).toEqual([
      ["provider", "get", "-g", "nemoclaw-18080", "nemoclaw-nvidia-prod-v1"],
      ["sandbox", "provider", "list", "-g", "nemoclaw-18080", "e2e-staging"],
    ]);
  });
  it("pins the healthy public provider and model", () => {
    expect(PUBLIC_NVIDIA_SWITCH_PROVIDER).toBe("nvidia-prod");
    expect(PUBLIC_NVIDIA_SWITCH_MODEL).toBe("nvidia/nemotron-3-super-120b-a12b");
    expect(requirePublicNvidiaSwitchKey("nvapi-public-key")).toBe("nvapi-public-key");
    expect(() => requirePublicNvidiaSwitchKey("sk-hosted-key")).toThrow(/nvapi-\*/u);
  });

  it("rejects live provider metadata whose revision differs from the durable receipt", async () => {
    const openshell = vi
      .fn()
      .mockResolvedValueOnce({
        exitCode: 0,
        stderr: "",
        stdout: [
          "Name: nemoclaw-nvidia-prod-v1",
          "Id: provider-revision-2",
          "Type: nemoclaw-nvidia-inference-v1",
          "Resource version: 2",
          "Credential keys: NVIDIA_INFERENCE_API_KEY",
          "Config keys: <none>",
        ].join("\n"),
      } as ShellProbeResult)
      .mockResolvedValueOnce({
        exitCode: 0,
        stderr: "",
        stdout: "nemoclaw-nvidia-prod-v1\n",
      } as ShellProbeResult);

    const evidence = await readPublicNvidiaSwitchAttachmentEvidence({
      artifactName: "native-nvidia-provider-attachment",
      env: { OPENSHELL_GATEWAY: "nemoclaw" },
      logicalProvider: PUBLIC_NVIDIA_SWITCH_PROVIDER,
      receipt: {
        schemaVersion: 1,
        profileId: "nemoclaw-nvidia-inference-v1",
        providerName: "nemoclaw-nvidia-prod-v1",
        providerId: "provider-revision-1",
      },
      sandbox: { openshell } as unknown as SandboxClient,
      sandboxName: "e2e-hm-inf-switch",
    });

    expect(evidence).not.toBe(PUBLIC_NVIDIA_SWITCH_ATTACHMENT_EVIDENCE);
    expect(evidence).toContain("provider-id=mismatch");
    expect(openshell).toHaveBeenNthCalledWith(
      1,
      ["provider", "get", "-g", "nemoclaw", "nemoclaw-nvidia-prod-v1"],
      expect.objectContaining({ captureLimitBytes: 16 * 1024, persistArtifacts: true }),
    );
  });

  it("retains bounded redacted diagnostics when provider inspection fails", async () => {
    const credential = "nvapi-must-not-enter-provider-diagnostics";
    const providerFailure = {
      artifacts: {
        stdout: "shell/native-nvidia-provider-attachment-provider-metadata.stdout.txt",
        stderr: "shell/native-nvidia-provider-attachment-provider-metadata.stderr.txt",
        result: "shell/native-nvidia-provider-attachment-provider-metadata.result.json",
      },
      command: ["openshell", "provider", "get"],
      exitCode: 1,
      signal: null,
      stderr: "provider lookup failed for [REDACTED]",
      stdout: "",
      timedOut: false,
    } satisfies ShellProbeResult;
    const openshell = vi
      .fn()
      .mockResolvedValueOnce(providerFailure)
      .mockResolvedValueOnce({
        artifacts: { stdout: "", stderr: "", result: "" },
        command: ["openshell", "sandbox", "provider", "list"],
        exitCode: 0,
        signal: null,
        stderr: "",
        stdout: "nemoclaw-nvidia-prod-v1\n",
        timedOut: false,
      } satisfies ShellProbeResult);

    const evidence = await readPublicNvidiaSwitchAttachmentEvidence({
      artifactName: "native-nvidia-provider-attachment",
      env: {
        NVIDIA_INFERENCE_API_KEY: credential,
        OPENSHELL_GATEWAY: "nemoclaw",
      },
      logicalProvider: PUBLIC_NVIDIA_SWITCH_PROVIDER,
      receipt: {
        schemaVersion: 1,
        profileId: "nemoclaw-nvidia-inference-v1",
        providerName: "nemoclaw-nvidia-prod-v1",
        providerId: "provider-revision-1",
      },
      sandbox: { openshell } as unknown as SandboxClient,
      sandboxName: "e2e-hm-inf-switch",
    });

    expect(evidence).toContain("provider-inspection=1");
    expect(Object.values(providerFailure.artifacts).every((value) => value.length > 0)).toBe(true);
    expect(JSON.stringify(providerFailure)).not.toContain(credential);
    expect(openshell).toHaveBeenNthCalledWith(
      1,
      ["provider", "get", "-g", "nemoclaw", "nemoclaw-nvidia-prod-v1"],
      expect.objectContaining({
        captureLimitBytes: 16 * 1024,
        persistArtifacts: true,
        redactionValues: [credential],
      }),
    );
  });
});
