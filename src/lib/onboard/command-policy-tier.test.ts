// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { resolveOnboardOptions, runOnboardCommand } from "./command";
import { ONBOARD_POLICY_TIER_VALUES, type OnboardFlags } from "./command-support";

function exitWithCode(code: number): never {
  throw new Error(`exit:${code}`);
}

function resolve(
  flags: OnboardFlags,
  overrides: Partial<Parameters<typeof resolveOnboardOptions>[1]> = {},
) {
  return resolveOnboardOptions(flags, {
    env: {},
    error: () => {},
    exit: exitWithCode,
    listPolicyTiers: () => ONBOARD_POLICY_TIER_VALUES,
    ...overrides,
  });
}

describe("onboard --policy-tier (#13180)", () => {
  it("normalizes --policy-tier and rejects unknown, Portable, or resumed use (#13180)", () => {
    expect(resolve({ "policy-tier": " Restricted " }).requestedPolicyTier).toBe("restricted");
    expect(resolve({}).requestedPolicyTier).toBeNull();

    const errors: string[] = [];
    const error = (message?: string) => errors.push(String(message));
    expect(() => resolve({ "policy-tier": "locked" }, { error })).toThrow("exit:1");
    expect(() =>
      resolve({ "policy-tier": "open", "experimental-profile": "portable" }, { error }),
    ).toThrow("exit:1");
    expect(() => resolve({ "policy-tier": "open", resume: true }, { error })).toThrow("exit:1");
    expect(errors).toEqual([
      "  Unknown policy tier: locked. Valid: restricted, balanced, open, personal",
      "  --policy-tier cannot be used with the Portable profile.",
      "  --policy-tier cannot be used when resuming onboarding; use --fresh to choose a new tier.",
    ]);
  });

  it("carries --policy-tier on the run options without mutating the environment (#13180)", async () => {
    const env: NodeJS.ProcessEnv = { NEMOCLAW_POLICY_TIER: "open" };
    const seen: Array<string | null> = [];
    await runOnboardCommand({
      flags: { "policy-tier": "restricted" },
      env,
      listPolicyTiers: () => ONBOARD_POLICY_TIER_VALUES,
      runOnboard: async (options) => {
        seen.push(options.requestedPolicyTier);
        expect(env.NEMOCLAW_POLICY_TIER).toBe("open");
      },
    });
    expect(seen).toEqual(["restricted"]);
    expect(env).toEqual({ NEMOCLAW_POLICY_TIER: "open" });
  });

  it("leaves the tier prompt in charge when the flag is absent", async () => {
    await runOnboardCommand({
      flags: {},
      env: { NEMOCLAW_POLICY_TIER: "open" },
      runOnboard: async (options) => {
        expect(options.requestedPolicyTier).toBeNull();
      },
    });
  });
});
