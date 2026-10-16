// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

vi.mock("../../../state/registry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../state/registry")>()),
  getSandbox: vi.fn(() => null),
}));

import { createSession } from "../../../state/onboard-session";
import type { SandboxEntry } from "../../../state/registry";
import { handleProviderInferenceState } from "./provider-inference";
import { baseOptions, createDeps } from "./provider-inference.test-support";

describe("Pi local inference route", () => {
  it("selects a native provider for fresh Pi local onboarding", async () => {
    const { deps, calls } = createDeps({
      setupNim: vi.fn(async () => ({
        model: "qwen3:8b",
        provider: "ollama-local",
        endpointUrl: "http://host.openshell.internal:11435/v1",
        credentialEnv: "NEMOCLAW_OLLAMA_PROXY_TOKEN",
        hermesAuthMethod: null,
        hermesToolGateways: [],
        preferredInferenceApi: "openai-completions",
        compatibleEndpointReasoning: null,
        compatibleEndpointReasoningEffort: null,
        nimContainer: null,
      })),
    });
    await handleProviderInferenceState({
      ...baseOptions(deps, null),
      agent: { name: "pi" },
      sandboxName: "my-assistant",
    });
    expect(calls.setupInference.mock.calls[0]?.at(-1)).not.toMatchObject({
      preserveLegacyPiSharedLocalRoute: true,
    });
    expect(calls.preflightGatewayRouteDiscovery).toHaveBeenCalledWith(
      expect.objectContaining({ nativeLocalSelection: true }),
    );
  });

  it("resumes the exact published Pi shared route without native attachment", async () => {
    const session = createSession({
      agent: "pi",
      sandboxName: "my-assistant",
      provider: "ollama-local",
      model: "qwen3:8b",
      endpointUrl: "http://host.openshell.internal:11435/v1",
      credentialEnv: "NEMOCLAW_OLLAMA_PROXY_TOKEN",
      preferredInferenceApi: "openai-completions",
    });
    session.steps.provider_selection.status = "complete";
    const recorded = {
      name: "my-assistant",
      agent: "pi",
      gatewayName: "nemoclaw",
      createdAt: "2026-09-01T00:00:00Z",
      provider: session.provider,
      model: session.model,
      endpointUrl: session.endpointUrl,
      credentialEnv: session.credentialEnv,
      preferredInferenceApi: session.preferredInferenceApi,
    } as SandboxEntry;
    const { deps, calls } = createDeps({ getSandboxRegistryEntry: () => recorded });

    await handleProviderInferenceState({
      ...baseOptions(deps, session),
      resume: true,
      agent: { name: "pi" },
      sandboxName: "my-assistant",
    });

    expect(calls.setupNim).not.toHaveBeenCalled();
    expect(calls.setupInference.mock.calls[0]?.at(-1)).toMatchObject({
      preserveLegacyPiSharedLocalRoute: true,
    });
    expect(calls.preflightGatewayRouteDiscovery).not.toHaveBeenCalledWith(
      expect.objectContaining({ nativeLocalSelection: true }),
    );
  });
});
