// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  prepareNativeCustomProfile,
  customAttachmentFromPrepared,
} from "../../inference/native-custom";
import { hostedNativeProvider } from "../../inference/native-provider/hosted";
import { nativeLocalIdentity } from "../../inference/native-local/contract";

import { resolveDcodeRebuildTarget } from "./rebuild-dcode-target";

describe("resolveDcodeRebuildTarget", () => {
  it("resolves the terminal DCode target without importing dashboard metadata (#6195)", () => {
    const entry = {
      name: "dcode-workspace",
      agent: "langchain-deepagents-code",
      dashboardPort: 0,
      gatewayName: "nemoclaw",
      gatewayPort: 8080,
    } as Parameters<typeof resolveDcodeRebuildTarget>[0];
    const resumeConfig = {
      provider: "compatible-endpoint",
      model: "nvidia/nemotron-3-super-120b-a12b",
      preferredInferenceApi: "openai-completions",
    } as Parameters<typeof resolveDcodeRebuildTarget>[1];

    const target = resolveDcodeRebuildTarget(entry, resumeConfig, 8080);

    expect(target).toEqual({
      agent: "langchain-deepagents-code",
      gatewayName: "nemoclaw",
      gatewayPort: 8080,
      provider: "compatible-endpoint",
      model: "nvidia/nemotron-3-super-120b-a12b",
      preferredInferenceApi: "openai-completions",
    });
    expect(target).not.toHaveProperty("dashboardPort");
  });
});

it("carries the exact native custom endpoint authority into DCode rebuild probes (#12636)", async () => {
  const prepared = await prepareNativeCustomProfile({
    sandboxName: "alpha",
    provider: "compatible-endpoint",
    endpointUrl: "http://8.8.8.8/v1",
    api: "openai-completions",
  });
  const receipt = customAttachmentFromPrepared(prepared, {
    schemaVersion: 1,
    profileId: prepared.profile.id,
    providerName: prepared.providerName,
    providerId: "custom-id",
  });
  const entry = {
    name: "alpha",
    agent: "langchain-deepagents-code",
    gatewayName: "nemoclaw",
    gatewayPort: 8080,
    nativeCustomProviderAttachment: receipt,
  };
  const selection = {
    provider: "compatible-endpoint",
    model: "model",
    preferredInferenceApi: "openai-completions",
  };
  expect(resolveDcodeRebuildTarget(entry, selection).nativeCustomProviderAttachment).toEqual(
    receipt,
  );
  expect(() => resolveDcodeRebuildTarget({ ...entry, name: "peer" }, selection)).toThrow(
    "malformed",
  );
});

it("preserves an endpoint-bound Hermes receipt in DCode rebuild probes (#12636)", () => {
  const endpointUrl = "https://staging.nous.example/api/v1";
  const definition = hostedNativeProvider("hermes-provider", endpointUrl)!;
  const receipt = {
    schemaVersion: 1 as const,
    profileId: definition.profileId,
    providerName: definition.providerName,
    providerId: "owned-hermes-id",
    endpointUrl,
    allowedIps: ["8.8.8.8"],
  };
  const target = resolveDcodeRebuildTarget(
    {
      name: "dcode-workspace",
      agent: "langchain-deepagents-code",
      gatewayName: "nemoclaw",
      gatewayPort: 8080,
      nativeHostedProviderAttachment: receipt,
    },
    {
      provider: "hermes-provider",
      model: "test-model",
      preferredInferenceApi: "openai-completions",
    },
    8080,
  );
  expect(target).toMatchObject({
    nativeProvider: true,
    nativeEndpointUrl: endpointUrl,
    provider: "hermes-provider",
  });
});

describe("DCode native local rebuild authority", () => {
  const binding = {
    provider: "vllm-local",
    endpointUrl: "http://host.openshell.internal:8000/v1",
    credentialEnv: "NEMOCLAW_LOCAL_INFERENCE_TOKEN",
    authMode: "sentinel",
    gatewayName: "nemoclaw",
    sandboxName: "alpha",
  } as const;
  const attachment = {
    ...binding,
    ...nativeLocalIdentity(binding),
    schemaVersion: 1,
    providerId: "owned",
  };
  const entry = {
    name: "alpha",
    agent: "langchain-deepagents-code",
    gatewayName: "nemoclaw",
    gatewayPort: 8080,
  };
  const config = { provider: binding.provider, model: "model", preferredInferenceApi: null };
  it.each([null, {}, { ...attachment, providerId: "" }, { ...attachment, schemaVersion: 2 }])(
    "rejects malformed local authority before selecting a target (%j)",
    (receipt) => {
      expect(() =>
        resolveDcodeRebuildTarget(
          { ...entry, nativeLocalProviderAttachment: receipt },
          config,
          8080,
        ),
      ).toThrow("Malformed native local provider attachment");
    },
  );
  it.each([attachment, undefined])(
    "preserves valid native local or absent legacy authority (%j)",
    (receipt) => {
      const result = resolveDcodeRebuildTarget(
        { ...entry, nativeLocalProviderAttachment: receipt },
        config,
        8080,
      );
      expect(result.nativeLocalProviderAttachment).toEqual(receipt);
    },
  );

  it("ignores a stale native attachment for an owned Local NIM rebuild", () => {
    const result = resolveDcodeRebuildTarget(
      {
        ...entry,
        nimContainer: "local-nim-container",
        nativeLocalProviderAttachment: attachment,
      },
      config,
      8080,
    );

    expect(result).not.toHaveProperty("nativeLocalProviderAttachment");
    expect(result).not.toHaveProperty("nativeProvider");
    expect(result).not.toHaveProperty("nativeEndpointUrl");
    expect(result.provider).toBe("vllm-local");
  });
});
