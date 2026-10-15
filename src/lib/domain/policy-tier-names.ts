// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Canonical policy tier names. Mirrors nemoclaw-blueprint/policies/tiers.yaml
 * without loading the runtime tier registry, so command help, session parsing,
 * and create-time planning can share it. A unit test keeps the two aligned.
 */
export const POLICY_TIER_NAMES = ["restricted", "balanced", "open", "personal"] as const;

export type PolicyTierName = (typeof POLICY_TIER_NAMES)[number];

export function isPolicyTierName(value: unknown): value is PolicyTierName {
  return typeof value === "string" && (POLICY_TIER_NAMES as readonly string[]).includes(value);
}
