// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { expect, it, vi } from "vitest";
import { customNativeProvider } from "../inference/native-provider/custom";
import {
  HOSTED_NATIVE_PROVIDERS,
  type HostedProviderDefinition,
} from "../inference/native-provider/hosted";
import { nativeHostedOnboardFixture } from "../../../test/support/native-hosted-onboard-fixture";

vi.mock("./sandbox-lifecycle", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./sandbox-lifecycle")>()),
  releaseAbandonedRouteReservation: vi.fn(() => false),
}));

const providers: HostedProviderDefinition[] = [
  ...HOSTED_NATIVE_PROVIDERS,
  ...[
    ["compatible-endpoint", "openai-completions", "https://custom.example/v1"],
    ["compatible-endpoint", "openai-responses", "https://custom.example/v1"],
    ["compatible-anthropic-endpoint", "anthropic-messages", "https://custom.example"],
    ["compatible-anthropic-endpoint", "openai-completions", "https://custom.example"],
    ["compatible-anthropic-endpoint", "openai-responses", "https://custom.example"],
  ].map(([provider, api, endpointUrl]) =>
    customNativeProvider({
      provider,
      api,
      endpointUrl,
      credentialEnv: "HOST_KEY",
      allowedIps: ["8.8.8.8"],
    }),
  ),
];

const cases = providers.flatMap((provider) =>
  (provider.custom
    ? [
        "explicit",
        "previous-provider",
        "retained",
        ...(provider.api ===
        (provider.logicalProvider === "compatible-anthropic-endpoint"
          ? "anthropic-messages"
          : "openai-completions")
          ? ["default-api"]
          : []),
      ]
    : ["explicit", "omitted"]
  ).map((endpointMode) => ({ provider, endpointMode })),
);

it.each(
  cases.filter(({ provider, endpointMode }) => provider.custom && endpointMode !== "retained"),
)(
  "creates scoped custom authority for $provider.logicalProvider $provider.api $endpointMode",
  async ({ provider, endpointMode }) => {
    const {
      run,
      nativeCustom,
      createProvider,
      updateSandbox,
      writeAuthority,
      recordMigratedProviderCredential,
      verifyOnboardInferenceSmoke,
      verifyInferenceRoute,
      runOpenshell,
    } = nativeHostedOnboardFixture(provider, endpointMode);
    await expect(run()).resolves.toMatchObject({ ok: true });
    expect(nativeCustom.providerAdapter.createProvider).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        target: { kind: "named", gatewayName: "gateway" },
        name: expect.stringMatching(/^nemoclaw-custom-/),
        credentials: [
          {
            name:
              provider.logicalProvider === "compatible-endpoint"
                ? "COMPATIBLE_API_KEY"
                : "COMPATIBLE_ANTHROPIC_API_KEY",
            value: expect.stringMatching(/^token-/),
          },
        ],
      }),
    );
    expect(createProvider).not.toHaveBeenCalled();
    expect(updateSandbox).toHaveBeenCalledWith(
      "alpha",
      expect.objectContaining({
        nativeCustomProviderAttachment: expect.objectContaining({
          sandboxName: "alpha",
          api: provider.api,
          transport: expect.objectContaining({ sourceEndpointUrl: provider.custom!.endpointUrl }),
        }),
      }),
    );
    expect(recordMigratedProviderCredential.mock.calls).toEqual([
      [
        provider.logicalProvider,
        provider.custom!.credentialEnv,
        "host-secret",
        expect.any(Function),
      ],
    ]);
    expect(writeAuthority).not.toHaveBeenCalled();
    expect(verifyOnboardInferenceSmoke.mock.calls).toEqual([
      [
        expect.objectContaining({
          provider: provider.logicalProvider,
          endpointUrl: provider.custom!.endpointUrl,
        }),
      ],
    ]);

    expect(verifyInferenceRoute).not.toHaveBeenCalled();
    expect(runOpenshell).not.toHaveBeenCalled();
    expect(JSON.stringify(updateSandbox.mock.calls)).not.toContain("host-secret");
  },
);
it.each(cases.filter(({ endpointMode }) => endpointMode === "retained"))(
  "retains existing custom authority for $provider.logicalProvider $provider.api",
  async ({ provider, endpointMode }) => {
    const {
      run,
      receipt,
      createProvider,
      getProvider,
      updateSandbox,
      writeAuthority,
      recordMigratedProviderCredential,
      verifyOnboardInferenceSmoke,
      verifyInferenceRoute,
      runOpenshell,
    } = nativeHostedOnboardFixture(provider, endpointMode);
    await expect(run()).resolves.toMatchObject({ ok: true });
    expect(createProvider).not.toHaveBeenCalled();
    expect(getProvider).toHaveBeenCalled();
    expect(writeAuthority).toHaveBeenCalledWith("gateway", provider.logicalProvider, receipt);
    expect(updateSandbox).toHaveBeenCalledWith(
      "alpha",
      expect.objectContaining({
        nativeHostedProviderAttachment: receipt,
        provider: provider.logicalProvider,
        preferredInferenceApi: provider.api,
      }),
    );
    expect(recordMigratedProviderCredential.mock.calls).toEqual([]);
    expect(verifyOnboardInferenceSmoke.mock.calls).toEqual([]);

    expect(verifyInferenceRoute).not.toHaveBeenCalled();
    expect(runOpenshell).not.toHaveBeenCalled();
    expect(JSON.stringify(updateSandbox.mock.calls)).not.toContain("host-secret");
  },
);
it.each(cases.filter(({ provider }) => !provider.custom))(
  "creates fixed native authority for $provider.logicalProvider $endpointMode",
  async ({ provider, endpointMode }) => {
    const {
      run,
      receipt,
      createProvider,
      updateSandbox,
      writeAuthority,
      recordMigratedProviderCredential,
      verifyOnboardInferenceSmoke,
      verifyInferenceRoute,
      runOpenshell,
    } = nativeHostedOnboardFixture(provider, endpointMode);
    await expect(run()).resolves.toMatchObject({ ok: true });
    expect(createProvider).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        name: provider.providerName,
        credentials: [{ name: provider.credentialEnv, value: "host-secret" }],
        type: provider.profileId,
      }),
    );
    expect(writeAuthority).toHaveBeenCalledWith("gateway", provider.logicalProvider, receipt);
    expect(updateSandbox).toHaveBeenCalledWith(
      "alpha",
      expect.objectContaining({
        nativeHostedProviderAttachment: receipt,
        provider: provider.logicalProvider,
        preferredInferenceApi: provider.api,
      }),
    );
    expect(recordMigratedProviderCredential.mock.calls).toEqual([]);
    expect(verifyOnboardInferenceSmoke.mock.calls).toEqual(
      provider.logicalProvider === "hermes-provider"
        ? []
        : [
            [
              expect.objectContaining({
                provider: provider.logicalProvider,
                endpointUrl: provider.endpoint,
              }),
            ],
          ],
    );

    expect(verifyInferenceRoute).not.toHaveBeenCalled();
    expect(runOpenshell).not.toHaveBeenCalled();
    expect(JSON.stringify(updateSandbox.mock.calls)).not.toContain("host-secret");
  },
);
