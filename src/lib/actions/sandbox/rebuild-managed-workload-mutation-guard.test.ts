// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { managedStartupE2eProfile } from "../../../../scripts/checks/generate-managed-startup-profile-fixture.mts";
import {
  customAttachmentFromPrepared,
  prepareNativeCustomProfile,
} from "../../inference/native-custom";
import { mapManagedStartupProfileToAgentEnvironment } from "../../onboard/managed-startup/agent-environment";
import * as managedWorkload from "../../onboard/workload/rebuild";
import * as registry from "../../state/registry";
import type { SandboxEntry } from "../../state/registry/types";
import {
  managedRebuildProfileDependencies,
  prepareManagedRebuildProfileHandoff,
} from "./agents/managed-workload-rebuild-profile";
import type { RebuildRecreateOnboardOpts } from "./rebuild-gpu-opt-out";
import { revalidateManagedWorkloadRebuildBeforeDelete } from "./rebuild-preflight-guards";
import type { RebuildTargetConfig } from "./rebuild-target-preflight";

const entry = {
  name: "alpha",
  openshellDriver: "docker",
} as SandboxEntry;
const handoff = {
  providerId: "docker",
} as managedWorkload.ManagedWorkloadRebuildHandoff;

describe("managed workload rebuild mutation guard", () => {
  it.each([
    {
      agent: "hermes",
      anthropicApi: "openai-completions",
      anthropicBaseUrl: "https://messages.example.com/v1",
    },
    {
      agent: "openclaw",
      anthropicApi: "anthropic-messages",
      anthropicBaseUrl: "https://messages.example.com",
    },
  ] as const)(
    "refreshes $agent native custom route authority on rebuild and removes it for a shared route",
    async ({ agent, anthropicApi, anthropicBaseUrl }) => {
      const previousProfile = managedStartupE2eProfile(agent);
      vi.spyOn(managedRebuildProfileDependencies, "resolveContextWindowForModel").mockReturnValue(
        131_072,
      );
      const catalogHandoff = {
        agent,
        previousProfile,
        previousReceipt: { credentialProxyReplayRequired: false },
        corporateCa: null,
      } as unknown as managedWorkload.ManagedWorkloadRebuildCatalogHandoff;
      const recreateOptions = {
        controlUiPort: 29_443,
        toolDisclosure: "progressive",
        dcodeAutoApprovalMode: "disabled",
        observabilityEnabled: false,
      } as unknown as RebuildRecreateOnboardOpts;
      const attachmentFor = async (
        provider: "compatible-endpoint" | "compatible-anthropic-endpoint",
        endpointUrl: string,
        api = "openai-completions",
      ) => {
        const prepared = await prepareNativeCustomProfile({
          sandboxName: "alpha",
          provider,
          endpointUrl,
          api,
          lookup: async () => [{ address: "8.8.8.8", family: 4 }],
        });
        return customAttachmentFromPrepared(prepared, {
          schemaVersion: 1,
          profileId: prepared.profile.id,
          providerName: prepared.providerName,
          providerId: "native-provider-id",
        });
      };
      const replacement = (
        provider: "compatible-endpoint" | "compatible-anthropic-endpoint",
        nativeCustomProviderAttachment?: Awaited<ReturnType<typeof attachmentFor>>,
        prior = previousProfile,
      ) =>
        prepareManagedRebuildProfileHandoff({
          catalogHandoff: { ...catalogHandoff, previousProfile: prior },
          targetConfig: {
            agentDefinition: {},
            resumeConfig: {
              provider,
              model: "test-model",
              preferredInferenceApi:
                provider === "compatible-endpoint" ? "openai-completions" : "anthropic-messages",
              nativeCustomProviderAttachment,
            },
            durableConfig: { webSearchConfig: null },
            hermesToolGateways: [],
          } as unknown as RebuildTargetConfig,
          recreateOptions,
          messagingPlan: null,
          environment: {},
        }).replacementProfile.profile;

      const openai = await attachmentFor("compatible-endpoint", "https://api.example.com/v1");
      const anthropic = await attachmentFor(
        "compatible-anthropic-endpoint",
        "https://messages.example.com/v1",
        anthropicApi,
      );
      const first = replacement("compatible-endpoint", openai);
      expect(first.inference).toMatchObject({
        routedBaseUrl: "https://api.example.com/v1",
        nativeCustomCredentialEnv: "COMPATIBLE_API_KEY",
      });
      const changed = replacement("compatible-anthropic-endpoint", anthropic, first);
      expect(changed.inference).toMatchObject({
        routedBaseUrl: anthropicBaseUrl,
        nativeCustomCredentialEnv: "COMPATIBLE_ANTHROPIC_API_KEY",
      });
      expect(replacement("compatible-endpoint", undefined, changed).inference).not.toHaveProperty(
        "nativeCustomCredentialEnv",
      );
    },
  );

  it("blocks deletion when durable workload authority changes", () => {
    vi.spyOn(registry, "getSandbox").mockReturnValue(entry);

    expect(revalidateManagedWorkloadRebuildBeforeDelete("alpha", handoff)).toEqual({
      ok: false,
      message: "Managed workload authority changed before sandbox deletion.",
    });
  });

  it("blocks deletion when the sandbox entry disappeared", () => {
    vi.spyOn(registry, "getSandbox").mockReturnValue(null);

    expect(revalidateManagedWorkloadRebuildBeforeDelete("alpha", handoff)).toEqual({
      ok: false,
      message: "Managed workload authority changed before sandbox deletion.",
    });
  });

  it("blocks deletion when the recorded runtime provider is unknown", () => {
    vi.spyOn(registry, "getSandbox").mockReturnValue({
      ...entry,
      openshellDriver: "not-a-provider",
    } as SandboxEntry);

    expect(revalidateManagedWorkloadRebuildBeforeDelete("alpha", handoff)).toEqual({
      ok: false,
      message: "Managed workload authority changed before sandbox deletion.",
    });
  });

  it("does not alter legacy rebuild validation", () => {
    expect(revalidateManagedWorkloadRebuildBeforeDelete("alpha", undefined)).toBeNull();
  });

  it("rejects a changed compatible endpoint without selected-route context evidence", () => {
    const catalogHandoff = {
      agent: "openclaw",
      previousProfile: {
        inference: { model: "previous-model", upstreamProvider: "nvidia-prod" },
        dashboard: { agent: "openclaw", bindAddress: "127.0.0.1", wslExposure: false },
        tuning: { contextWindow: 16_384 },
      },
    } as unknown as managedWorkload.ManagedWorkloadRebuildCatalogHandoff;
    const targetConfig = {
      agentDefinition: {},
      resumeConfig: {
        provider: "compatible-endpoint",
        model: "reasoning-model",
        preferredInferenceApi: "openai-completions",
        endpointUrl: "https://inference.example.test/v1",
        compatibleEndpointReasoning: "true",
        compatibleEndpointReasoningEffort: "high",
      },
      durableConfig: { webSearchConfig: null },
      hermesToolGateways: [],
    } as unknown as RebuildTargetConfig;
    const stage = vi
      .spyOn(managedWorkload, "stageManagedWorkloadRebuildProfile")
      .mockReturnValue(handoff);
    vi.spyOn(managedRebuildProfileDependencies, "resolveContextWindowForModel").mockReturnValue(
      null,
    );

    expect(() =>
      prepareManagedRebuildProfileHandoff({
        catalogHandoff,
        targetConfig,
        recreateOptions: {
          controlUiPort: 18_789,
          toolDisclosure: "progressive",
          dcodeAutoApprovalMode: "disabled",
          observabilityEnabled: false,
        } as unknown as RebuildRecreateOnboardOpts,
        messagingPlan: null,
        environment: {},
      }),
    ).toThrow(
      "Cannot determine a context window for the current OpenClaw target 'compatible-endpoint/reasoning-model'.",
    );
    expect(stage).not.toHaveBeenCalled();

    vi.spyOn(
      managedRebuildProfileDependencies,
      "resolveManagedStartupInferenceRoute",
    ).mockReturnValue({
      providerKey: "compatible-endpoint",
      primaryModelRef: "reasoning-model",
      inferenceBaseUrl: "http://127.0.0.1:8080/v1",
      inferenceApi: "unsupported-api",
      inferenceCompat: null,
    });
    vi.spyOn(managedRebuildProfileDependencies, "resolveContextWindowForModel").mockReturnValue(
      16_384,
    );
    expect(() =>
      prepareManagedRebuildProfileHandoff({
        catalogHandoff,
        targetConfig,
        recreateOptions: {
          controlUiPort: 18_789,
          toolDisclosure: "progressive",
          dcodeAutoApprovalMode: "disabled",
          observabilityEnabled: false,
        } as unknown as RebuildRecreateOnboardOpts,
        messagingPlan: null,
        environment: {},
      }),
    ).toThrow("Unsupported managed startup inference API 'unsupported-api'.");
  });

  it("rejects a legacy Hermes dashboard before retaining a recorded browser host", () => {
    const previousProfile = managedStartupE2eProfile("hermes");
    const previousDashboard = previousProfile.dashboard as Extract<
      typeof previousProfile.dashboard,
      { readonly agent: "hermes" }
    >;
    expect(previousDashboard.agent).toBe("hermes");
    const browserUrl = "https://secure-link.example/dashboard";
    const catalogHandoff = {
      agent: "hermes",
      previousProfile: {
        ...previousProfile,
        dashboard: { ...previousDashboard, browserUrl },
      },
      previousReceipt: { credentialProxyReplayRequired: false },
      corporateCa: null,
    } as unknown as managedWorkload.ManagedWorkloadRebuildCatalogHandoff;
    const targetConfig = {
      agentDefinition: {},
      resumeConfig: {
        provider: "nvidia",
        model: previousProfile.inference!.model,
        preferredInferenceApi: "openai-completions",
        endpointUrl: null,
        compatibleEndpointReasoning: null,
        compatibleEndpointReasoningEffort: null,
      },
      durableConfig: { webSearchConfig: null },
      hermesToolGateways: [],
    } as unknown as RebuildTargetConfig;
    vi.spyOn(
      managedRebuildProfileDependencies,
      "resolveManagedStartupInferenceRoute",
    ).mockReturnValue({
      providerKey: "inference",
      primaryModelRef: "inference/unused-for-hermes",
      inferenceBaseUrl: "https://inference.local/v1",
      inferenceApi: "openai-completions",
      inferenceCompat: null,
    });
    const recreateOptions = {
      controlUiPort: 29_443,
      toolDisclosure: "progressive",
      dcodeAutoApprovalMode: "disabled",
      observabilityEnabled: false,
    } as unknown as RebuildRecreateOnboardOpts;
    const environment = {
      NEMOCLAW_HERMES_DASHBOARD: "1",
      NEMOCLAW_HERMES_DASHBOARD_INTERNAL_PORT: "19443",
    };
    const { browserUrl: _browserUrl, ...legacyDashboard } = previousDashboard;
    expect(() =>
      prepareManagedRebuildProfileHandoff({
        catalogHandoff: {
          ...catalogHandoff,
          previousProfile: {
            ...catalogHandoff.previousProfile,
            dashboard: legacyDashboard,
          },
        },
        targetConfig,
        recreateOptions,
        messagingPlan: null,
        environment,
      }),
    ).toThrow(
      "Cannot rebuild the Hermes dashboard because its managed startup profile has no recorded browser URL. Rerun onboarding, then rebuild the sandbox.",
    );

    const prepared = prepareManagedRebuildProfileHandoff({
      catalogHandoff,
      targetConfig,
      recreateOptions,
      messagingPlan: null,
      environment,
    });

    expect(prepared.replacementProfile.profile.dashboard).toMatchObject({
      agent: "hermes",
      browserUrl,
      publicPort: 29_443,
      url: "http://127.0.0.1:29443",
    });
    expect(
      mapManagedStartupProfileToAgentEnvironment(prepared.replacementProfile.profile, {})
        .runtimeEnvironment.CHAT_UI_URL,
    ).toBe(browserUrl);

    const loopbackBrowserUrl = "http://127.0.0.2:18789/dashboard";
    const loopbackPrepared = prepareManagedRebuildProfileHandoff({
      catalogHandoff: {
        ...catalogHandoff,
        previousProfile: {
          ...catalogHandoff.previousProfile,
          dashboard: { ...previousDashboard, browserUrl: loopbackBrowserUrl },
        },
      },
      targetConfig,
      recreateOptions,
      messagingPlan: null,
      environment,
    });

    expect(loopbackPrepared.replacementProfile.profile.dashboard).toMatchObject({
      browserUrl: "http://127.0.0.2:29443/dashboard",
      publicPort: 29_443,
    });
    expect(
      mapManagedStartupProfileToAgentEnvironment(loopbackPrepared.replacementProfile.profile, {})
        .runtimeEnvironment.CHAT_UI_URL,
    ).toBe("http://127.0.0.2:29443/dashboard");
  });
});
