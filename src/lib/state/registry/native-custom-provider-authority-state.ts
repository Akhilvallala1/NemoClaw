// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { normalizeNativeCustomProviderAttachment } from "../../inference/native-custom";
import { isValidName } from "../../name-validation";
import type { SandboxRegistry } from "./types";

type Authorities = NonNullable<SandboxRegistry["nativeCustomProviderAuthorities"]>;

function invalidAuthority(): never {
  throw new Error(
    "Invalid native custom provider authority. Reconcile the retained ownership records before continuing.",
  );
}

export function normalizeNativeCustomProviderAuthorities(value: unknown): Authorities | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) invalidAuthority();
  const result: Authorities = Object.create(null);
  for (const [gateway, candidates] of Object.entries(value)) {
    if (
      !isValidName(gateway) ||
      !candidates ||
      typeof candidates !== "object" ||
      Array.isArray(candidates)
    )
      invalidAuthority();
    for (const [name, candidate] of Object.entries(candidates)) {
      const receipt = normalizeNativeCustomProviderAttachment(candidate);
      if (!receipt || receipt.providerName !== name) invalidAuthority();
      (result[gateway] ??= Object.create(null))[name] = receipt;
    }
  }
  return Object.keys(result).length ? result : undefined;
}
