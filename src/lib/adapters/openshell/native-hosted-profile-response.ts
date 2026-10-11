// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { requireHermesPublicPins } from "../../inference/native-provider/hermes-pins";
import {
  HOSTED_NATIVE_PROVIDERS,
  type HostedProviderDefinition,
  hostedNativeProvider,
} from "../../inference/native-provider/hosted";
import {
  isManagedNativeProfileResponse,
  type NativeProfileBoundary,
} from "./native-nvidia-profile-response";

export type HostedNativeProfileId =
  | (typeof HOSTED_NATIVE_PROVIDERS)[number]["profileId"]
  | `nemoclaw-hermes-inference-${string}-v1`;

export function hostedNativeProfile(
  profileId: string,
  endpointUrl?: string,
): HostedProviderDefinition | undefined {
  if (endpointUrl) {
    const bound = hostedNativeProvider("hermes-provider", endpointUrl);
    return bound?.profileId === profileId ? bound : undefined;
  }
  return HOSTED_NATIVE_PROVIDERS.find((definition) => definition.profileId === profileId);
}

export function hostedNativeProfileBoundary(
  profileId: string,
  endpointUrl?: string,
  allowedIps?: readonly string[],
): NativeProfileBoundary | undefined {
  const definition = hostedNativeProfile(profileId, endpointUrl);
  if (!definition) return undefined;
  const endpoint = new URL(definition.endpoint);
  const prefix =
    definition.api === "anthropic-messages" ? "/v1" : endpoint.pathname.replace(/\/+$/, "");
  let paths = ["chat/completions"];
  if (definition.api === "anthropic-messages") paths = ["messages", "messages/count_tokens"];
  else if (definition.logicalProvider === "openai-api") paths.push("responses");
  return {
    id: definition.profileId,
    allowedIps: definition.endpointUrl ? requireHermesPublicPins(allowedIps) : [],
    credentialEnv: definition.credentialEnv,
    authStyle: definition.api === "anthropic-messages" ? "header" : "bearer",
    headerName: definition.api === "anthropic-messages" ? "x-api-key" : "authorization",
    host: endpoint.hostname,
    port: Number(endpoint.port || 443),
    path: "",
    rules: [
      { method: "GET", path: `${prefix}/models` },
      ...paths.map((path) => ({ method: "POST" as const, path: `${prefix}/${path}` })),
    ],
    binaries: [
      "/usr/local/bin/node",
      "/usr/bin/node",
      "/opt/hermes/.venv/bin/python",
      "/opt/hermes/.venv/bin/python3",
      "/opt/venv/bin/python3",
      "/usr/local/bin/curl",
      "/usr/bin/curl",
    ],
  };
}

export function isManagedNativeHostedProfileResponse(
  value: unknown,
  profileId: string,
  endpointUrl?: string,
  allowedIps?: readonly string[],
) {
  let boundary;
  try {
    boundary = hostedNativeProfileBoundary(profileId, endpointUrl, allowedIps);
  } catch {
    return undefined;
  }
  return boundary && isManagedNativeProfileResponse(value, boundary) ? value : undefined;
}
