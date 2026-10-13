// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { NAME_MAX_LENGTH } from "../../../src/lib/name-validation.ts";
import { inferenceSandboxName } from "../live/inference-routing-helpers.ts";

describe("inference routing sandbox names", () => {
  it("bounds generated names without dropping the unique suffix (#12636)", () => {
    const suffix = process.pid.toString(36);
    const name = inferenceSandboxName(`e2e${"x".repeat(NAME_MAX_LENGTH)}`);

    expect(name.length).toBeLessThanOrEqual(NAME_MAX_LENGTH);
    expect(name.length).toBeGreaterThan(suffix.length + 1);
    expect(name).toMatch(new RegExp(`-${suffix}$`, "u"));
  });
});
