// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isNativeCustomCredentialReference } from "./inference/native-custom/credential-reference.ts";
import { nativeHostedAgentConfig } from "./inference/native-provider/agent-config.ts";
import {
  NATIVE_NVIDIA_SCOPED_HANDLE_PATTERN,
  managedInferenceApiKey,
  NVIDIA_INFERENCE_PLACEHOLDER,
} from "./inference-credential.ts";

// The inference.local route replaces this non-secret sentinel at egress.
// Native NVIDIA routing instead expands the supervisor-issued environment handle.
export const HERMES_PROXY_REWRITE_SENTINEL = "sk-OPENSHELL-PROXY-REWRITE";

type HermesManagedProvider = {
  name: string;
  api_key: string;
  discover_models: true;
  api?: string;
  base_url?: string;
  default_model?: string;
  transport?: string;
  api_mode?: string;
};

export type HermesManagedRouting = {
  _nemoclaw_upstream: {
    provider: string;
    provider_key: string;
    model: string;
    native_custom_credential_env?: string;
  };
  model: {
    default: string;
    provider: "custom";
    base_url: string;
    api_key: string;
    api_mode?: string;
    context_length?: number;
  };
  providers: Record<string, HermesManagedProvider>;
  custom_providers: HermesManagedProvider[];
};

export type HermesManagedRoute = {
  model: string;
  baseUrl: string;
  upstreamProvider: string;
  inferenceApi: string;
  contextWindow?: number | null;
  credentialReference?: string;
  /** Attachment-derived, non-secret native-route authority marker. */
  nativeCustomCredentialEnv?: string;
  nativeCredentialHandle?: string;
};

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function hermesApiMode(inferenceApi: string): string | null {
  switch (inferenceApi) {
    case "":
    case "openai-completions":
      return null;
    case "anthropic-messages":
      return "anthropic_messages";
    case "openai-responses":
      return "codex_responses";
    default:
      throw new Error(`Unsupported Hermes inference API: ${inferenceApi}`);
  }
}

export function hermesProviderKey(provider: string): string {
  const normalized = provider
    .trim()
    .toLowerCase()
    .replaceAll(" ", "-")
    .replace(/[()]/gu, "")
    .replace(/-+/gu, "-")
    .replace(/^-|-$/gu, "");
  return normalized || "nemoclaw-inference";
}

/** Apply the complete NemoClaw-owned Hermes route to an existing config. */
export function applyHermesManagedRoute(
  config: Record<string, unknown>,
  route: HermesManagedRoute,
): asserts config is Record<string, unknown> & HermesManagedRouting {
  const providerName = route.upstreamProvider || "nemoclaw-inference";
  const providerKey = hermesProviderKey(providerName);
  const apiMode = hermesApiMode(route.inferenceApi);
  const nativeCustomKey =
    route.upstreamProvider === "compatible-endpoint"
      ? "COMPATIBLE_API_KEY"
      : route.upstreamProvider === "compatible-anthropic-endpoint"
        ? "COMPATIBLE_ANTHROPIC_API_KEY"
        : null;
  const nativeCustom =
    route.credentialReference !== undefined || route.nativeCustomCredentialEnv !== undefined;
  if (
    nativeCustom &&
    (!nativeCustomKey ||
      (route.nativeCustomCredentialEnv !== undefined &&
        route.nativeCustomCredentialEnv !== nativeCustomKey) ||
      new URL(route.baseUrl).hostname === "inference.local")
  ) {
    throw new Error("Hermes native custom inference requires its matching attached route.");
  }
  const nativeHosted = nativeHostedAgentConfig(route.upstreamProvider, route.baseUrl);
  let apiKey = nativeCustom
    ? `sk-OPENSHELL-RESOLVE-ENV-${nativeCustomKey}`
    : nativeHosted
      ? `\${${nativeHosted.credentialEnv}}`
      : managedInferenceApiKey(route.baseUrl, HERMES_PROXY_REWRITE_SENTINEL);
  if (route.credentialReference !== undefined) {
    if (
      !nativeCustomKey ||
      !isNativeCustomCredentialReference(route.credentialReference, nativeCustomKey)
    )
      throw new Error(
        "Hermes native custom inference requires its matching issued credential reference.",
      );
    apiKey =
      "sk-OPENSHELL-RESOLVE-ENV-" +
      route.credentialReference.slice("openshell:resolve:env:".length);
  }
  if (route.nativeCredentialHandle !== undefined) {
    if (
      route.upstreamProvider !== "nvidia-prod" ||
      apiKey !== NVIDIA_INFERENCE_PLACEHOLDER ||
      !NATIVE_NVIDIA_SCOPED_HANDLE_PATTERN.test(route.nativeCredentialHandle)
    ) {
      throw new Error("Hermes native NVIDIA route requires a provider-bound credential handle.");
    }
    apiKey = route.nativeCredentialHandle;
  }
  const previousUpstream = isObjectRecord(config._nemoclaw_upstream)
    ? config._nemoclaw_upstream
    : {};
  const previousProviderKey =
    typeof previousUpstream.provider_key === "string" ? previousUpstream.provider_key : "";

  const modelConfig: Record<string, unknown> = {
    default: route.model,
    provider: "custom",
    base_url: route.baseUrl,
    api_key: apiKey,
    ...(nativeHosted?.headers ? { default_headers: nativeHosted.headers } : {}),
  };
  if (apiMode) modelConfig.api_mode = apiMode;
  if (route.contextWindow !== null && route.contextWindow !== undefined) {
    // Hermes reads context_length before endpoint discovery and model metadata.
    modelConfig.context_length = route.contextWindow;
  }

  const providerConfig: Record<string, unknown> = {
    name: providerName,
    api: route.baseUrl,
    api_key: apiKey,
    ...(nativeHosted?.headers ? { default_headers: nativeHosted.headers } : {}),
    default_model: route.model,
    discover_models: true,
  };
  if (apiMode) providerConfig.transport = apiMode;

  const customProvider: Record<string, unknown> = {
    name: providerName,
    base_url: route.baseUrl,
    api_key: apiKey,
    ...(nativeHosted?.headers ? { default_headers: nativeHosted.headers } : {}),
    discover_models: true,
  };
  if (apiMode) customProvider.api_mode = apiMode;

  const providers = isObjectRecord(config.providers) ? { ...config.providers } : {};
  if (previousProviderKey && previousProviderKey !== providerKey) {
    delete providers[previousProviderKey];
  }
  providers[providerKey] = providerConfig;

  const customProviders = Array.isArray(config.custom_providers)
    ? config.custom_providers.filter(
        (entry) =>
          !isObjectRecord(entry) ||
          (entry.name !== previousUpstream.provider && entry.name !== providerName),
      )
    : [];
  customProviders.push(customProvider);

  config._nemoclaw_upstream = {
    provider: providerName,
    provider_key: providerKey,
    model: route.model,
    ...(nativeCustom ? { native_custom_credential_env: nativeCustomKey } : {}),
  };
  config.model = modelConfig;
  config.providers = providers;
  config.custom_providers = customProviders;
}
