// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isValidName } from "../../name-validation";
import type { OpenShellProviderAdapter } from "../../adapters/openshell/provider-adapter";
import { createManagedProviderAdapter } from "../../adapters/openshell/managed-provider-adapter";
import {
  runOpenshellProviderCommand,
  type OpenShellRuntimeSelection,
} from "../../adapters/openshell/provider-command";
import {
  clearNativeCustomProviderAuthority,
  listNativeCustomProviderAuthorities,
} from "../../state/registry/native-custom-provider-authority";
import { computeHttpsPinRouteId } from "../https-pin-runtime";
import { revokeHttpsPinRuntimeAdapterRoute } from "../https-pin-runtime-adapter";
import {
  normalizeNativeCustomProviderAttachment,
  profileFromCustomAttachment,
  withNativeCustomLifecycle,
  type NativeCustomProviderAttachment,
} from "./index";

/** Keep provider retirement on the runtime whose sandbox deletion was confirmed. */
export function nativeCustomCleanupAdapter(runtimeSelection?: OpenShellRuntimeSelection) {
  return createManagedProviderAdapter((args, options) =>
    runOpenshellProviderCommand(args, { ...options, runtimeSelection }),
  );
}

/** Bind native cleanup reads and retirement to the registry selected by destroy preflight. */
export function nativeCustomCleanupAuthority(registryFile?: string) {
  return {
    listNativeCustomProviderAuthorities: (gateway: string, sandboxName?: string) =>
      listNativeCustomProviderAuthorities(gateway, sandboxName, registryFile),
    clearNativeCustomProviderAuthority: (
      gateway: string,
      receipt: NativeCustomProviderAttachment,
    ) => clearNativeCustomProviderAuthority(gateway, receipt, registryFile),
  };
}

/** Delete only proven-owned, detached registrations; retain receipts until all cleanup is observed. */
export async function retireNativeCustomProviders(input: {
  gatewayName: string;
  sandboxName: string;
  keepProviderName?: string;
  adapter?: OpenShellProviderAdapter;
  receipts?: readonly NativeCustomProviderAttachment[];
  attachment?: NativeCustomProviderAttachment;
  clearAuthority?: typeof clearNativeCustomProviderAuthority;
  revokeRoute?: typeof revokeHttpsPinRuntimeAdapterRoute;
}): Promise<void> {
  if (!isValidName(input.gatewayName) || !isValidName(input.sandboxName))
    throw new Error("Invalid native custom cleanup scope.");
  const receipts =
    input.receipts ?? listNativeCustomProviderAuthorities(input.gatewayName, input.sandboxName);
  const validated = new Map<string, NativeCustomProviderAttachment>();
  for (const receipt of [
    ...receipts,
    ...(input.attachment === undefined ? [] : [input.attachment]),
  ]) {
    const normalized = normalizeNativeCustomProviderAttachment(receipt, input.sandboxName);
    if (
      !normalized ||
      (normalized.transport && normalized.transport.gatewayName !== input.gatewayName)
    )
      throw new Error(
        "Native custom cleanup authority does not match the selected sandbox and gateway.",
      );
    const existing = validated.get(normalized.providerName);
    if (existing && JSON.stringify(existing) !== JSON.stringify(normalized))
      throw new Error("Native custom sandbox and gateway cleanup authority disagree.");
    validated.set(normalized.providerName, normalized);
  }
  const adapter = input.adapter ?? createManagedProviderAdapter();
  const keep = input.keepProviderName ? validated.get(input.keepProviderName) : undefined;
  const routeId = (receipt: NativeCustomProviderAttachment | undefined): string | null =>
    receipt?.transport?.kind === "https-pin"
      ? computeHttpsPinRouteId(
          input.gatewayName,
          receipt.credentialEnv === "COMPATIBLE_API_KEY"
            ? "compatible-endpoint"
            : "compatible-anthropic-endpoint",
          receipt.transport.sourceEndpointUrl,
          receipt.sandboxName,
          receipt.api === "anthropic-messages" ? "anthropic" : "openai",
        )
      : null;
  for (const receipt of validated.values()) {
    if (receipt.providerName === input.keepProviderName) continue;
    await withNativeCustomLifecycle(profileFromCustomAttachment(receipt), (lifecycle) =>
      lifecycle.removeNewNativeProvider({
        adapter,
        target: { kind: "named", gatewayName: input.gatewayName },
        expected: receipt,
      }),
    );
    const route = routeId(receipt);
    if (route && route !== routeId(keep)) {
      if (!(await (input.revokeRoute ?? revokeHttpsPinRuntimeAdapterRoute)(route)))
        throw new Error(
          "Native custom HTTPS adapter route revocation was not confirmed; cleanup authority is retained.",
        );
    }
    (input.clearAuthority ?? clearNativeCustomProviderAuthority)(input.gatewayName, receipt);
  }
}
