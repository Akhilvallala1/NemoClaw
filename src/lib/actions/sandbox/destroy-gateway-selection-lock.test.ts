// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const gatewaySelection = vi.hoisted(() => ({ active: "original" }));

vi.mock("../../adapters/openshell/gateway-lifecycle-cli", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../adapters/openshell/gateway-lifecycle-cli")>();
  return {
    ...actual,
    createCliOpenShellGatewayLifecycleFromRunnerWithoutAmbientGateway: () => ({
      listGateways: async () => ({
        ok: true as const,
        names: ["original", "gateway-a", "gateway-b"],
        activeGateway: gatewaySelection.active,
      }),
      selectGateway: async ({ target }: { target: { gatewayName: string } }) => {
        gatewaySelection.active = target.gatewayName;
        return { ok: true as const, state: "completed" as const };
      },
    }),
  };
});

import { destroyWithActiveGatewayRestored } from "./destroy-gateway";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("destroy active-gateway selection lock", () => {
  beforeEach(() => {
    gatewaySelection.active = "original";
  });

  it("serializes overlapping destroys across sandbox names", async () => {
    const firstGate = deferred();
    const secondGate = deferred();
    const firstEntered = deferred();
    const secondEntered = deferred();

    const first = destroyWithActiveGatewayRestored("alpha", "gateway-a", false, async () => {
      gatewaySelection.active = "gateway-a";
      firstEntered.resolve();
      await firstGate.promise;
    });
    await firstEntered.promise;

    let secondOperationEntered = false;
    const second = destroyWithActiveGatewayRestored("beta", "gateway-b", false, async () => {
      gatewaySelection.active = "gateway-b";
      secondOperationEntered = true;
      secondEntered.resolve();
      await secondGate.promise;
    });

    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(secondOperationEntered).toBe(false);

    firstGate.resolve();
    await first;
    await secondEntered.promise;
    expect(gatewaySelection.active).toBe("gateway-b");

    secondGate.resolve();
    await second;
    expect(gatewaySelection.active).toBe("original");
  });
});
