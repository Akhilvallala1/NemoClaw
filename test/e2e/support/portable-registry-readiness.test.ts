// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  runPortableRegistryReadinessPolicy,
  type PortableRegistryReadinessObservation,
} from "../fixtures/portable-registry-readiness.ts";

describe("portable registry readiness policy", () => {
  it("records first-attempt readiness without sleeping", async () => {
    const sleep = vi.fn(async () => {});
    const onEvidence = vi.fn();

    const result = await runPortableRegistryReadinessPolicy({
      probe: async () => ({ kind: "ready", statusCode: 200 }),
      sleep,
      onEvidence,
    });

    expect(result.outcome).toBe("passed");
    expect(result.evidence.outcome).toBe("passed-first-attempt");
    expect(result.evidence.attempts).toEqual([
      { attempt: 1, outcome: "passed", retryScheduled: false },
    ]);
    expect(sleep).not.toHaveBeenCalled();
    expect(onEvidence).toHaveBeenCalledWith(result.evidence);
  });

  it("retries only the named transport startup failures", async () => {
    const observations: PortableRegistryReadinessObservation[] = [
      { kind: "transport", code: "connection-refused" },
      { kind: "transport", code: "connection-reset" },
      { kind: "ready", statusCode: 200 },
    ];
    const probe = vi.fn(async () => observations.shift()!);
    const sleep = vi.fn(async () => {});

    const result = await runPortableRegistryReadinessPolicy({ probe, sleep, delayMs: 25 });

    expect(result.outcome).toBe("passed");
    expect(result.evidence.outcome).toBe("passed-after-retry");
    expect(result.evidence.attempts).toEqual([
      {
        attempt: 1,
        outcome: "failed",
        failureClass: "transient-external",
        retryScheduled: true,
      },
      {
        attempt: 2,
        outcome: "failed",
        failureClass: "transient-external",
        retryScheduled: true,
      },
      { attempt: 3, outcome: "passed", retryScheduled: false },
    ]);
    expect(sleep).toHaveBeenNthCalledWith(1, 25);
    expect(sleep).toHaveBeenNthCalledWith(2, 25);
  });

  it.each([
    { kind: "http-status", statusCode: 503 } as const,
    { kind: "transport", code: "unexpected" } as const,
  ])("stops without retrying a deterministic $kind failure", async (observation) => {
    const probe = vi.fn(async () => observation);
    const sleep = vi.fn(async () => {});

    const result = await runPortableRegistryReadinessPolicy({ probe, sleep });

    expect(result.outcome).toBe("failed");
    expect(result.value).toEqual(observation);
    expect(result.evidence.outcome).toBe("failed-no-retry");
    expect(result.evidence.attempts).toEqual([
      {
        attempt: 1,
        outcome: "failed",
        failureClass: "deterministic",
        retryScheduled: false,
      },
    ]);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("retains exhausted timeout attempt evidence", async () => {
    const onEvidence = vi.fn();
    const result = await runPortableRegistryReadinessPolicy({
      probe: async () => ({ kind: "transport", code: "timeout" }),
      maxAttempts: 2,
      delayMs: 0,
      onEvidence,
    });

    expect(result.outcome).toBe("failed");
    expect(result.evidence.outcome).toBe("exhausted");
    expect(result.evidence.attempts).toEqual([
      {
        attempt: 1,
        outcome: "failed",
        failureClass: "transient-external",
        retryScheduled: true,
      },
      {
        attempt: 2,
        outcome: "failed",
        failureClass: "transient-external",
        retryScheduled: false,
      },
    ]);
    expect(onEvidence).toHaveBeenCalledWith(result.evidence);
  });
});
