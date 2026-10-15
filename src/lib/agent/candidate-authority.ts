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
    "6bb9974250172ede14e67e36e9c528e5d530bc3df98e9d0be012abaaa786ad93",
    "3825258d7aa3759f81db06a5346141564e6eb88b74a8beb96d2e0b0d6775f11f",
    "001bc67c3e46cb7916709dd159f230abdf6f52dd74dc0573b4eb7d089e6c6984",
    "239043cc0620eb5110d45e830a8b6a9da11bb4ee875023468d44e9a4f2ab6739",
  ]),
});

export function acceptedCandidateReceiptDigests(agent: string): readonly string[] {
  return CANDIDATE_QUALIFICATION_RECEIPT_DIGESTS[agent as CandidateManagedImageAgent] ?? [];
}
