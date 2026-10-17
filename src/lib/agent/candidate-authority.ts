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
    "8781cc611b547421511f0fbf352aa02a13c9cd93aac9ede2316cb619a3c25e48",
    "dedbba9119ca4deacb38d8a913d4c2ed151c93bbf4caafa31a2aa34c0b90ba46",
    "1900249b823ef7ab9a20cf35780e94b378fcd71931f62ec38346d84797164b06",
    "7a2555a63e36c8e37ac91d1d0d821a4da43528065129295f390dd02b6a0ae955",
  ]),
});

export function acceptedCandidateReceiptDigests(agent: string): readonly string[] {
  return CANDIDATE_QUALIFICATION_RECEIPT_DIGESTS[agent as CandidateManagedImageAgent] ?? [];
}
