// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  hermesImageRef,
  dcodeImageRef,
  dcodeProfileInput,
  dcodeSnapshot,
  imageRef,
  profileInput,
  hermesProfileInput,
  managedWorkload,
  snapshot,
  hermesSnapshot,
  verify,
  changeRetainedProfile,
} from "./export-source-test-fixture";
import { verifyExportSource } from "./verify-export-source";
import {
  prepareNativeCustomProfile,
  customAttachmentFromPrepared,
} from "../../inference/native-custom";
import { resolveManagedStartupInferenceRoute } from "../../inference/gateway/route-contract";

function findings(result: ReturnType<typeof verifyExportSource>) {
  return result.kind === "verified" ? [] : result.findings;
}

describe("native custom config export source verification (#12636)", () => {
  it.each(["hermes", "openclaw", "langchain-deepagents-code"] as const)(
    "preserves recorded native custom %s authority when reconstructing the startup profile (#12636)",
    async (agent) => {
      const prepared = await prepareNativeCustomProfile({
        sandboxName: "alpha",
        provider: "compatible-endpoint",
        endpointUrl: "https://8.8.8.8/v1",
        api: "openai-completions",
      });
      const attachment = customAttachmentFromPrepared(prepared, {
        schemaVersion: 1,
        profileId: prepared.profile.id,
        providerName: prepared.providerName,
        providerId: "custom-provider-id",
      });
      const route = resolveManagedStartupInferenceRoute(
        agent,
        "compatible-endpoint",
        "gpt-5",
        "openai-completions",
        attachment,
      );
      const input =
        agent === "hermes"
          ? hermesProfileInput()
          : agent === "langchain-deepagents-code"
            ? dcodeProfileInput()
            : profileInput();
      const base =
        agent === "hermes"
          ? hermesSnapshot()
          : agent === "langchain-deepagents-code"
            ? dcodeSnapshot()
            : snapshot();
      const value = {
        ...base,
        sandbox: { ...base.sandbox, providerNames: [attachment.providerName] },
        inference: {
          ...base.inference,
          provider: "compatible-endpoint",
          api: "openai-completions",
          endpoint: attachment.endpointUrl,
          credentialEnv: attachment.credentialEnv,
          endpointEvidence: {
            endpoint: attachment.endpointUrl,
            provider: {
              ...base.inference.endpointEvidence!.provider,
              name: attachment.providerName,
              id: attachment.providerId,
            },
            source: { kind: "managed-profile" as const, profileId: attachment.profileId },
          },
        },
        registry: {
          ...base.registry,
          provider: "compatible-endpoint",
          preferredInferenceApi: "openai-completions",
          endpointUrl: attachment.endpointUrl,
          credentialEnv: attachment.credentialEnv,
          nativeCustomProviderAttachment: attachment,
          workload: managedWorkload(
            {
              ...input,
              inference: {
                ...input.inference!,
                routeProvider: route.providerKey,
                upstreamProvider: "compatible-endpoint",
                upstreamEndpointUrl:
                  agent === "langchain-deepagents-code" ? attachment.endpointUrl : null,
                routedBaseUrl: route.inferenceBaseUrl,
                nativeCustomCredentialEnv: attachment.credentialEnv,
                api: "openai-completions",
                primaryModelRef: agent === "openclaw" ? route.primaryModelRef : null,
                compatibility: agent === "openclaw" ? (route.inferenceCompat ?? {}) : null,
              },
            },
            agent === "hermes"
              ? hermesImageRef
              : agent === "langchain-deepagents-code"
                ? dcodeImageRef
                : imageRef,
          ),
        },
      };
      expect(findings(verify(value))).toEqual([]);
      const drifted = changeRetainedProfile(value, (profile) => {
        profile.inference!.nativeCustomCredentialEnv = "COMPATIBLE_ANTHROPIC_API_KEY";
      });
      expect(findings(verify(drifted))).toContainEqual(
        expect.objectContaining({ field: "source.workload", category: "missing-provenance" }),
      );
    },
  );
});
