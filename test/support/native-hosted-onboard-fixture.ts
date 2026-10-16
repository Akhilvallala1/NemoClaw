// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { vi } from "vitest";
import type { OpenShellProviderAdapter } from "../../src/lib/adapters/openshell/provider-adapter";
import {
  HOSTED_NATIVE_PROVIDERS,
  type HostedProviderDefinition,
} from "../../src/lib/inference/native-provider/hosted";
import {
  createSetupInference,
  type SetupInferenceDeps,
} from "../../src/lib/onboard/setup-inference";
import { createNativeCustomSetupDependencies } from "./setup-inference-test-harness";
export function nativeHostedOnboardFixture(
  provider: HostedProviderDefinition,
  endpointMode: string,
) {
  const retained = endpointMode === "retained";
  const scoped = Boolean(provider.custom) && !retained;
  const nativeCustom = createNativeCustomSetupDependencies();
  const receipt = {
    schemaVersion: 1,
    profileId: provider.profileId,
    providerName: provider.providerName,
    providerId: "identity",
    ...(provider.endpointUrl ? { endpointUrl: provider.endpointUrl } : {}),
    ...(provider.allowedIps ? { allowedIps: provider.allowedIps } : {}),
    ...(provider.custom ? { custom: provider.custom } : {}),
  } as const;
  const getProvider = vi.fn<OpenShellProviderAdapter["getProvider"]>().mockResolvedValue({
    ok: true,
    value: {
      name: provider.providerName,
      type: provider.profileId,
      credentialKeys: [provider.credentialEnv],
      configKeys: [],
      revision: { id: "identity", resourceVersion: 1 },
    },
  });
  if (!retained)
    getProvider.mockResolvedValueOnce({
      ok: false,
      error: { kind: "command", reason: "not_found", message: "absent" },
    });
  const createProvider = vi.fn<OpenShellProviderAdapter["createProvider"]>(async () => ({
    ok: true,
  }));
  const providerAdapter = {
    getProvider,
    createProvider,
    importProviderProfile: vi.fn(async () => ({ ok: true })),
    ensureProviderPolicyComposition: vi.fn(async () => ({ ok: true, value: undefined })),
  } as unknown as OpenShellProviderAdapter;
  const runOpenshell = vi.fn(() => ({ status: 0, stdout: "", stderr: "" }));
  const verifyInferenceRoute = vi.fn();
  const verifyOnboardInferenceSmoke = vi.fn(async () => undefined);
  const updateSandbox = vi.fn(() => true);
  const writeAuthority = vi.fn();
  const recordMigratedProviderCredential = vi.fn();
  const setup = createSetupInference({
    checkGatewayRouteCompatibility: vi.fn(() => ({ ok: true })),
    withSandboxMutationLock: async <T>(_name: string, fn: () => T | Promise<T>) => await fn(),
    withGatewayRouteMutationLock: async <T>(_name: string, fn: () => T | Promise<T>) => await fn(),
    step: vi.fn(),
    getGatewayName: () => "gateway",
    runOpenshell,
    updateSandbox,
    localInference: { loadPendingOllamaModelCleanup: () => [] },
    withOllamaModelOwnershipLock: (operation: () => unknown) => operation(),
    getNativeHostedProviderAuthority: () => undefined,
    setNativeHostedProviderAuthority: writeAuthority,
    ...nativeCustom,
    getSandbox: () =>
      retained
        ? {
            name: "alpha",
            provider: provider.logicalProvider,
            nativeHostedProviderAttachment: receipt,
          }
        : endpointMode === "previous-provider"
          ? {
              name: "alpha",
              provider: "openai-api",
              pendingRouteReservation: true,
              nativeHostedProviderAttachment: {
                schemaVersion: 1,
                profileId: HOSTED_NATIVE_PROVIDERS[0].profileId,
                providerName: HOSTED_NATIVE_PROVIDERS[0].providerName,
                providerId: "previous-provider-id",
              },
            }
          : null,
    resolveEndpointHost: async () => [{ address: "8.8.8.8", family: 4 }],
    upsertProvider: vi.fn(),
    recordMigratedProviderCredential,
    verifyInferenceRoute,
    verifyOnboardInferenceSmoke,
    isNonInteractive: () => true,
    hermesProviderAuth: {
      HERMES_PROVIDER_NAME: "hermes-provider",
      isHermesProviderRegistered: async () => false,
      ensureHermesProviderApiKeyCredentials: async (
        _name: string,
        options: {
          registerInferenceCredential: (input: {
            apiKey: string;
            credentialEnv: string;
            baseUrl: string;
          }) => Promise<unknown>;
        },
      ) => {
        await options.registerInferenceCredential({
          apiKey: "host-secret",
          credentialEnv: "NOUS_API_KEY",
          baseUrl: provider.endpoint,
        });
        return {
          auth_method: "api_key",
          credential_env: "OPENAI_API_KEY",
          inference_base_url: provider.endpoint,
        };
      },
    },
    normalizeHermesAuthMethod: () => "api_key",
    checkHermesProviderStoreReachable: () => ({ ok: true }),
    resolveHermesNousApiKey: () => "host-secret",
    hermesConstants: {
      HERMES_NOUS_API_KEY_CREDENTIAL_ENV: "NOUS_API_KEY",
      HERMES_AUTH_METHOD_API_KEY: "api_key",
      HERMES_AUTH_METHOD_OAUTH: "oauth",
    },
    requireValue: (value: unknown) => value,

    providerAdapter: scoped ? nativeCustom.providerAdapter : providerAdapter,
    hydrateCredentialEnv: () => "host-secret",
    redact: (s: string) => s,
    compactText: (s: string) => s,
    log: vi.fn(),
    error: vi.fn(),
    exitProcess: (code: number): never => {
      throw new Error(`exit ${code}`);
    },
  } as unknown as SetupInferenceDeps);

  return {
    run: () =>
      setup(
        "alpha",
        "supported-model",
        provider.logicalProvider,
        endpointMode !== "omitted" ? (provider.custom?.endpointUrl ?? provider.endpoint) : null,
        provider.custom?.credentialEnv ?? provider.credentialEnv,
        null,
        [],
        {
          revalidateSandboxIdentity: () => undefined,
          preferredInferenceApi: endpointMode === "default-api" ? null : provider.api,
        },
      ),
    receipt,
    nativeCustom,
    createProvider,
    getProvider,
    updateSandbox,
    writeAuthority,
    recordMigratedProviderCredential,
    verifyOnboardInferenceSmoke,
    verifyInferenceRoute,
    runOpenshell,
  };
}
