// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  normalizeNativeCustomProviderAttachment,
  type NativeCustomProviderAttachment,
} from "../../inference/native-custom";
import { isValidName, isValidProviderName } from "../../name-validation";
import { withLock } from "./lock";
import { load, save } from "./persistence";
import { readNativeCustomAuthoritiesAt, clearNativeCustomAuthorityAt } from "./cross-port";

export function listNativeCustomProviderAuthorities(
  gatewayName: string,
  sandboxName?: string,
  registryFile?: string,
): NativeCustomProviderAttachment[] {
  if (!isValidName(gatewayName) || (sandboxName !== undefined && !isValidName(sandboxName)))
    throw new Error("Invalid native custom provider authority scope");
  const authorities = registryFile
    ? readNativeCustomAuthoritiesAt(registryFile)
    : load().nativeCustomProviderAuthorities;
  return Object.values(authorities?.[gatewayName] ?? {})
    .map((value) => normalizeNativeCustomProviderAttachment(value, sandboxName))
    .filter((value): value is NativeCustomProviderAttachment => value !== undefined);
}

export function getNativeCustomProviderAuthority(
  gatewayName: string,
  providerName: string,
): NativeCustomProviderAttachment | undefined {
  if (!isValidName(gatewayName) || !isValidProviderName(providerName)) return undefined;
  return normalizeNativeCustomProviderAttachment(
    load().nativeCustomProviderAuthorities?.[gatewayName]?.[providerName],
  );
}

export function setNativeCustomProviderAuthority(
  gatewayName: string,
  value: NativeCustomProviderAttachment,
): void {
  const receipt = normalizeNativeCustomProviderAttachment(value);
  if (!isValidName(gatewayName) || !receipt)
    throw new Error("Cannot record invalid native custom provider authority");
  withLock(() => {
    const data = load();
    data.nativeCustomProviderAuthorities = {
      ...data.nativeCustomProviderAuthorities,
      [gatewayName]: {
        ...data.nativeCustomProviderAuthorities?.[gatewayName],
        [receipt.providerName]: receipt,
      },
    };
    save(data);
  });
}

export function clearNativeCustomProviderAuthority(
  gatewayName: string,
  expected: NativeCustomProviderAttachment,
  registryFile?: string,
): void {
  if (registryFile) {
    clearNativeCustomAuthorityAt(registryFile, gatewayName, expected);
    return;
  }
  withLock(() => {
    const data = load();
    const current = data.nativeCustomProviderAuthorities?.[gatewayName]?.[expected.providerName];
    if (!current || current.providerId !== expected.providerId) return;
    delete data.nativeCustomProviderAuthorities![gatewayName][expected.providerName];
    if (!Object.keys(data.nativeCustomProviderAuthorities![gatewayName]).length)
      delete data.nativeCustomProviderAuthorities![gatewayName];
    if (!Object.keys(data.nativeCustomProviderAuthorities!).length)
      delete data.nativeCustomProviderAuthorities;
    save(data);
  });
}

/** Require the sandbox receipt and gateway-scoped ownership to describe the same provider. */
export function getMatchingNativeCustomProviderAuthority(
  gatewayName: string,
  sandboxName: string,
  value: unknown,
  getAuthority = getNativeCustomProviderAuthority,
): NativeCustomProviderAttachment {
  const receipt = normalizeNativeCustomProviderAttachment(value, sandboxName);
  if (!receipt) throw new Error("Recorded native custom selection cannot authorize resume.");
  const authority = normalizeNativeCustomProviderAttachment(
    getAuthority(gatewayName, receipt.providerName),
    sandboxName,
  );
  if (!authority || JSON.stringify(authority) !== JSON.stringify(receipt))
    throw new Error("Native custom sandbox and gateway authority disagree during resume.");
  return receipt;
}
