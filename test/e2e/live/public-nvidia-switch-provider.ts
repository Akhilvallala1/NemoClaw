// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  normalizeNativeNvidiaProviderAttachment,
  NVIDIA_HOSTED_CREDENTIAL_ENV,
  NVIDIA_HOSTED_NATIVE_PROFILE_ID,
  NVIDIA_HOSTED_NATIVE_PROVIDER,
} from "../../../src/lib/inference/native-nvidia/index.ts";
import { parseCliOpenShellProviderMetadata } from "../../../src/lib/adapters/openshell/provider-metadata-cli.ts";
import type { SandboxClient } from "../fixtures/clients/sandbox.ts";
import { normalizeNativeCustomProviderAttachment } from "../../../src/lib/inference/native-custom/index.ts";
export { requirePublicNvidiaSwitchKey } from "../fixtures/hosted-inference.ts";

export const PUBLIC_NVIDIA_SWITCH_PROVIDER = "nvidia-prod";
export const PUBLIC_NVIDIA_SWITCH_MODEL = "nvidia/nemotron-3-super-120b-a12b";
export const PUBLIC_NVIDIA_SWITCH_ATTACHMENT_EVIDENCE =
  "provider-inspection=0;provider-name=match;provider-profile=match;provider-id=match;attachment-inspection=0;attached=true;schema=1;profile=nemoclaw-nvidia-inference-v1;provider=nemoclaw-nvidia-prod-v1";

export const NATIVE_CUSTOM_ATTACHMENT_EVIDENCE =
  "provider-inspection=0;provider-name=match;provider-profile=match;provider-id=match;attachment-inspection=0;attached=true";

export async function readNativeCustomAttachmentEvidence(options: {
  artifactName: string;
  env: NodeJS.ProcessEnv;
  receipt: unknown;
  sandbox: SandboxClient;
  sandboxName: string;
}): Promise<string> {
  return (
    (await readPublicNvidiaSwitchAttachmentEvidence({
      ...options,
      logicalProvider: "compatible-endpoint",
    })) ?? "missing native custom attachment"
  );
}

export async function readPublicNvidiaSwitchAttachmentEvidence(options: {
  readonly artifactName: string;
  readonly env: NodeJS.ProcessEnv;
  readonly logicalProvider: string;
  readonly receipt: unknown;
  readonly sandbox: SandboxClient;
  readonly sandboxName: string;
}): Promise<string | null> {
  const custom = options.logicalProvider === "compatible-endpoint";
  if (options.logicalProvider !== PUBLIC_NVIDIA_SWITCH_PROVIDER && !custom) return null;
  const gatewayName = options.env.OPENSHELL_GATEWAY || "nemoclaw";
  const customReceipt = custom
    ? normalizeNativeCustomProviderAttachment(options.receipt, options.sandboxName, {
        provider: options.logicalProvider,
      })
    : undefined;
  const receipt = custom ? customReceipt : normalizeNativeNvidiaProviderAttachment(options.receipt);
  if (custom && !receipt) return "invalid native custom attachment";
  const expectedCredential = customReceipt?.credentialEnv ?? NVIDIA_HOSTED_CREDENTIAL_ENV;
  const expectedProvider = receipt?.providerName ?? NVIDIA_HOSTED_NATIVE_PROVIDER;
  const providerRedactionValues = [
    options.env.NVIDIA_API_KEY,
    options.env[NVIDIA_HOSTED_CREDENTIAL_ENV],
    options.env.COMPATIBLE_API_KEY,
  ].filter((value): value is string => typeof value === "string" && value.length > 0);
  const provider = await options.sandbox.openshell(
    ["provider", "get", "-g", gatewayName, expectedProvider],
    {
      artifactName: `${options.artifactName}-provider-metadata`,
      captureLimitBytes: 16 * 1024,
      env: options.env,
      persistArtifacts: true,
      redactionValues: providerRedactionValues,
      timeoutMs: 60_000,
    },
  );
  const metadata =
    provider.exitCode === 0 ? parseCliOpenShellProviderMetadata(provider.stdout) : null;
  const attachments = await options.sandbox.openshell(
    ["sandbox", "provider", "list", "-g", gatewayName, options.sandboxName],
    {
      artifactName: options.artifactName,
      env: options.env,
      timeoutMs: 60_000,
    },
  );
  const evidence = [
    `provider-inspection=${String(provider.exitCode)}`,
    `provider-name=${metadata?.name === receipt?.providerName && (!customReceipt?.transport || customReceipt.transport.gatewayName === gatewayName) ? "match" : "mismatch"}`,
    `provider-profile=${
      metadata?.type === receipt?.profileId &&
      metadata?.credentialKeys.length === 1 &&
      metadata.credentialKeys[0] === expectedCredential &&
      metadata.configKeys.length === 0 &&
      (custom ? Boolean(customReceipt) : metadata.type === NVIDIA_HOSTED_NATIVE_PROFILE_ID)
        ? "match"
        : "mismatch"
    }`,
    `provider-id=${metadata?.revision?.id === receipt?.providerId ? "match" : "mismatch"}`,
    `attachment-inspection=${String(attachments.exitCode)}`,
    `attached=${String(attachments.stdout.split(/\s+/u).includes(expectedProvider))}`,
  ];
  if (custom) return evidence.join(";");
  return [
    ...evidence,
    `schema=${String(receipt?.schemaVersion ?? "missing")}`,
    `profile=${receipt?.profileId ?? "missing"}`,
    `provider=${receipt?.providerName ?? "missing"}`,
  ].join(";");
}
