// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { captureResolvedOpenshellAsync } from "../../adapters/openshell/runtime";

export function isNativeProviderCredentialReference(value: string, key: string): boolean {
  return (
    ["COMPATIBLE_API_KEY", "COMPATIBLE_ANTHROPIC_API_KEY", "NVIDIA_INFERENCE_API_KEY"].includes(
      key,
    ) &&
    new RegExp(`^openshell:resolve:env:(?:v[0-9]{1,20}|s[a-f0-9]{64})_${key}$`, "u").test(value)
  );
}

/** Return only the issued reference; never return raw sandbox credential material. */
export async function resolveNativeProviderCredentialReference(
  input: {
    sandboxName: string;
    gatewayName: string;
    credentialEnv: string;
    replacedReference?: string;
  },
  capture?: typeof captureResolvedOpenshellAsync,
): Promise<string> {
  const { isValidName } = await import("../../name-validation.ts");
  if (
    !isValidName(input.sandboxName) ||
    !isValidName(input.gatewayName) ||
    !["COMPATIBLE_API_KEY", "COMPATIBLE_ANTHROPIC_API_KEY", "NVIDIA_INFERENCE_API_KEY"].includes(
      input.credentialEnv,
    )
  )
    throw new Error(
      `Invalid native ${input.credentialEnv === "NVIDIA_INFERENCE_API_KEY" ? "NVIDIA" : "custom"} credential scope.`,
    );
  const captureCredential =
    capture ?? (await import("../../adapters/openshell/runtime")).captureResolvedOpenshellAsync;
  const label = input.credentialEnv === "NVIDIA_INFERENCE_API_KEY" ? "NVIDIA" : "custom";
  if (
    input.replacedReference !== undefined &&
    !isNativeProviderCredentialReference(input.replacedReference, input.credentialEnv)
  )
    throw new Error(`Invalid native ${label} replacement credential reference.`);
  const script = `printf '%s' "\${${input.credentialEnv}}"`;
  // OpenShell projects attached provider credentials on its background poll.
  // Read fresh child environments for at most 30 seconds. Absence or the
  // recorded replaced reference can converge; unissued values remain errors.
  const deadline = performance.now() + 30_000;
  while (performance.now() < deadline) {
    const pending = captureCredential(
      [
        "sandbox",
        "exec",
        "-g",
        input.gatewayName,
        "--name",
        input.sandboxName,
        "--",
        "sh",
        "-lc",
        script,
      ],
      {
        ignoreError: true,
        includeStreams: true,
        timeout: Math.min(15_000, Math.max(1, Math.ceil(deadline - performance.now()))),
      },
    );
    const result = await pending.catch(() => {
      throw new Error(`Native ${label} credential reference could not be read.`);
    });
    const value = (result.stdout ?? "").trim();
    if (result.status !== 0) break;
    if (isNativeProviderCredentialReference(value, input.credentialEnv)) {
      if (value !== input.replacedReference) return value;
    } else if (value) break;
    const remaining = deadline - performance.now();
    if (remaining <= 0) break;
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(1_000, remaining)));
  }
  throw new Error(
    `Native ${label} inference has no matching supervisor-issued credential reference.`,
  );
}
