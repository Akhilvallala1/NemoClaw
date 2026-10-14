// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { NativeProviderLifecycle } from "../native-provider/index";

import {
  NVIDIA_HOSTED_CREDENTIAL_ENV,
  NVIDIA_HOSTED_LOGICAL_PROVIDER,
  NVIDIA_HOSTED_NATIVE_PROFILE_ID,
  NVIDIA_HOSTED_NATIVE_PROVIDER,
} from "./contract";

export {
  NVIDIA_HOSTED_CREDENTIAL_ENV,
  NVIDIA_HOSTED_LOGICAL_PROVIDER,
  NVIDIA_HOSTED_NATIVE_ENDPOINT,
  NVIDIA_HOSTED_NATIVE_PROFILE_ID,
  NVIDIA_HOSTED_NATIVE_PROVIDER,
  normalizeNativeNvidiaProviderAttachment,
  type NativeNvidiaProviderAttachment,
} from "./contract";

export class NativeNvidiaProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NativeNvidiaProviderError";
  }
}

const lifecycle = new NativeProviderLifecycle(
  {
    profileId: NVIDIA_HOSTED_NATIVE_PROFILE_ID,
    providerName: NVIDIA_HOSTED_NATIVE_PROVIDER,
    credentialEnv: NVIDIA_HOSTED_CREDENTIAL_ENV,
    logicalProvider: NVIDIA_HOSTED_LOGICAL_PROVIDER,
    label: "NVIDIA",
  },
  NativeNvidiaProviderError,
);

export const nativeNvidiaProviderProfilePath = lifecycle.nativeProviderProfilePath.bind(lifecycle);
export const requireNativeNvidiaProviderProfileBoundary =
  lifecycle.requireNativeProviderProfileBoundary.bind(lifecycle);
export const isNativeNvidiaProvider = lifecycle.isNativeProvider.bind(lifecycle);
export const resolveGatewayNativeNvidiaProviderAuthority =
  lifecycle.resolveGatewayNativeProviderAuthority.bind(lifecycle);
export const nativeInferenceProviderForSandbox =
  lifecycle.nativeInferenceProviderForSandbox.bind(lifecycle);
export const nativeNvidiaProviderAttachmentFromMetadata =
  lifecycle.nativeProviderAttachmentFromMetadata.bind(lifecycle);
export const persistNativeNvidiaProviderAuthority =
  lifecycle.persistNativeProviderAuthority.bind(lifecycle);
export const ensureNativeNvidiaProvider = lifecycle.ensureNativeProvider.bind(lifecycle);
export const verifyNativeNvidiaProviderAttachment =
  lifecycle.verifyNativeProviderAttachment.bind(lifecycle);
export const ensureNativeNvidiaProviderAttached =
  lifecycle.ensureNativeProviderAttached.bind(lifecycle);
export const detachNativeNvidiaProvider = lifecycle.detachNativeProvider.bind(lifecycle);

export {
  isNativeNvidiaCredentialReference,
  resolveNativeNvidiaCredentialReference,
} from "./credential-reference";
