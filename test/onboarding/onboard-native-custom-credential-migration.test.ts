// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { expect, it, vi } from "vitest";
import { createCredentialProviderRegistration } from "../../src/lib/onboard/credential-provider-registration";
import type { SetupInference, SetupInferenceDeps } from "../../src/lib/onboard/setup-inference";
import {
  createDirectSetupInferenceHarnessFactory,
  withProcessEnv,
} from "../support/setup-inference-test-harness";

const onboard = require("../../src/lib/onboard") as {
  createSetupInference: (overrides?: Partial<SetupInferenceDeps>) => SetupInference;
};
const createHarness = createDirectSetupInferenceHarnessFactory(onboard.createSetupInference);
const legacyValue = "sk-TEST-NOT-A-REAL-LEGACY-KEY";

function migrationHarness(value: string, overrides: Partial<SetupInferenceDeps> = {}) {
  const migratedLegacyKeys = new Set<string>();
  const registration = createCredentialProviderRegistration({
    root: "/unused",
    runOpenshell: vi.fn(),
    getGatewayName: () => "nemoclaw",
    getCredential: () => value,
    updateSession: vi.fn(),
    stagedLegacyValues: new Map([
      ["COMPATIBLE_API_KEY", legacyValue],
      ["UNRELATED_API_KEY", legacyValue],
    ]),
    migratedLegacyKeys,
  });
  const recordMigratedProviderCredential = vi.fn(registration.recordMigratedProviderCredential);
  const harness = createHarness({ overrides: { recordMigratedProviderCredential, ...overrides } });
  return {
    migratedLegacyKeys,
    recordMigratedProviderCredential,
    setup: () =>
      harness.setupInference(
        "test-box",
        "test-model",
        "compatible-endpoint",
        "https://api.example.com/v1",
        "COMPATIBLE_API_KEY",
        null,
        [],
      ),
  };
}

it.each([
  { label: "matching staged credential", value: legacyValue, expected: ["COMPATIBLE_API_KEY"] },
  { label: "replacement credential", value: "sk-TEST-REPLACEMENT", expected: [] },
])("records verified native custom custody for $label (#12636)", async ({ value, expected }) => {
  await withProcessEnv({ COMPATIBLE_API_KEY: value }, async () => {
    const harness = migrationHarness(value);
    await expect(harness.setup()).resolves.toEqual({ ok: true });
    expect(harness.recordMigratedProviderCredential).toHaveBeenCalledExactlyOnceWith(
      "compatible-endpoint",
      "COMPATIBLE_API_KEY",
      value,
      expect.any(Function),
    );
    expect([...harness.migratedLegacyKeys]).toEqual(expected);
  });
});

it.each([
  {
    label: "authority persistence",
    overrides: {
      setNativeCustomProviderAuthority: () => {
        throw new Error("authority unavailable");
      },
    },
  },
  {
    label: "host verification",
    overrides: {
      verifyOnboardInferenceSmoke: async () => {
        throw new Error("smoke failed");
      },
    },
  },
])("retains staged credentials after failed $label (#12636)", async ({ overrides }) => {
  await withProcessEnv({ COMPATIBLE_API_KEY: legacyValue }, async () => {
    const harness = migrationHarness(legacyValue, overrides);
    await expect(harness.setup()).rejects.toThrow();
    expect(harness.recordMigratedProviderCredential).not.toHaveBeenCalled();
    expect([...harness.migratedLegacyKeys]).toEqual([]);
  });
});
