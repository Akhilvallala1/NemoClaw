// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  buildE2eWorkflowPlan,
  validateE2eWorkflowPlan,
} from "../../../tools/e2e/workflow-plan.mts";

describe("native custom lifecycle workflow planning", () => {
  it.each([
    "src/lib/inference/native-custom/transport.ts",
    "src/lib/actions/inference-set/native-custom.ts",
    "src/lib/state/registry/native-custom-provider-authority.ts",
    "src/lib/onboard/resume/native-custom.ts",
  ])("selects native custom lifecycle evidence when %s changes (#12636)", (changedFile) => {
    const plan = buildE2eWorkflowPlan(
      {},
      { changedFiles: [changedFile], gatewayRuntimes: ["docker"] },
    );
    expect(
      Object.values(plan.catalogueMatrices)
        .flat()
        .map((row) => row.id),
    ).toContain("inference-routing-custom-hosted");
  });

  it("includes native custom lifecycle in the existing inference-routing selector (#12636)", () => {
    const plan = buildE2eWorkflowPlan(
      { targets: "inference-routing" },
      { gatewayRuntimes: ["docker", "podman"] },
    );
    const lifecycle = Object.values(plan.catalogueMatrices)
      .flat()
      .filter((row) => row.id === "inference-routing-custom-hosted");
    expect(lifecycle.map((row) => [row.runtime_provider, row.agent_runtime, row.shard])).toEqual([
      ["docker", "openclaw + hermes + langchain-deepagents-code + pi", "custom-hosted"],
      ["podman", "openclaw + hermes + langchain-deepagents-code", "custom-hosted"],
    ]);
    expect(validateE2eWorkflowPlan(plan)).toEqual(plan);
    lifecycle.find((row) => row.runtime_provider === "podman")!.agent_runtime =
      "openclaw + hermes + langchain-deepagents-code + pi";
    expect(() => validateE2eWorkflowPlan(plan)).toThrow("invalid output schema");
  });
});
