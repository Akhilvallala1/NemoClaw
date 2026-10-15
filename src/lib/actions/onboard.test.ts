// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listAgents: vi.fn(() => ["openclaw"]),
  onboard: vi.fn().mockResolvedValue(undefined),
  runOnboardCommand: vi.fn(),
}));

vi.mock("../agent/defs", () => ({ listAgents: mocks.listAgents }));
vi.mock("../onboard", () => ({ onboard: mocks.onboard }));
vi.mock("../onboard/command", () => ({ runOnboardCommand: mocks.runOnboardCommand }));

import { readRequestedPolicyTier } from "../onboard/policy-tier-env";
import { runOnboardAction } from "./onboard";

describe("onboard action runtime composition", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.runOnboardCommand.mockImplementation(
      async (deps: { runOnboard(options: unknown): Promise<void> }) => {
        await deps.runOnboard({ nonInteractive: true, resume: false });
      },
    );
  });

  it("passes host-only Google Chat dependencies into legacy onboarding", async () => {
    const googlechatTunnelRuntime = {
      loadServices: vi.fn(),
      loadWebhookProxy: vi.fn(),
    };

    await runOnboardAction({ "non-interactive": true }, { googlechatTunnelRuntime });

    expect(mocks.onboard).toHaveBeenCalledWith({
      nonInteractive: true,
      resume: false,
      googlechatTunnelRuntime,
    });
  });

  it("scopes --policy-tier to one legacy onboarding run (#13180)", async () => {
    let observed: string | null = null;
    mocks.runOnboardCommand.mockImplementation(
      async (deps: {
        listPolicyTiers(): readonly string[];
        runOnboard(options: unknown): Promise<void>;
      }) => {
        expect(deps.listPolicyTiers()).toEqual(["restricted", "balanced", "open", "personal"]);
        await deps.runOnboard({ requestedPolicyTier: "restricted" });
      },
    );
    mocks.onboard.mockImplementationOnce(async () => {
      observed = readRequestedPolicyTier();
      throw new Error("boom");
    });

    await expect(runOnboardAction({ "policy-tier": "restricted" })).rejects.toThrow("boom");

    expect(observed).toBe("restricted");
    expect(readRequestedPolicyTier()).toBeNull();
  });
});
