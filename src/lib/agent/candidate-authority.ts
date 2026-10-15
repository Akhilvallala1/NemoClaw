// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { CandidateManagedImageAgent } from "../onboard/managed-image/contract";

/**
 * Repository-controlled qualification authority for release candidates. A
 * candidate is reachable only through a qualification receipt whose SHA-256
 * appears here, so a caller can neither mint an accepted digest nor replace one
 * through environment configuration.
 */
export const CANDIDATE_QUALIFICATION_RECEIPT_DIGESTS: Readonly<
  Record<CandidateManagedImageAgent, readonly string[]>
> = Object.freeze({
  pi: Object.freeze([
    "b090a30a0f7709fb559091ce8a27edb3b22ea299d9643b0a5222360f4cf3f336",
    "b008b301b4e78372b4982148b8d767b6e3580fae1f31adf6390e80a3fdcf7bed",
  ]),
});

export function acceptedCandidateReceiptDigests(agent: string): readonly string[] {
  return CANDIDATE_QUALIFICATION_RECEIPT_DIGESTS[agent as CandidateManagedImageAgent] ?? [];
}
