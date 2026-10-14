// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { resolveOnboardOptions } from "./command";
import { type OnboardFlags, resolveDashboardOriginInputs } from "./command-support";

function resolve(flags: OnboardFlags, env: NodeJS.ProcessEnv = {}) {
  const error = vi.fn();
  const options = () =>
    resolveOnboardOptions(flags, {
      env,
      resolveDashboardOrigins: resolveDashboardOriginInputs,
      error,
      exit: (code: number): never => {
        throw new Error(`exit:${code}`);
      },
    });
  return { options, error };
}

describe("onboard --dashboard-origin (#13177)", () => {
  it("combines the flag with NEMOCLAW_DASHBOARD_ORIGINS", () => {
    const { options } = resolve(
      { "dashboard-origin": ["https://launchpad.example.test:8443"] },
      { NEMOCLAW_DASHBOARD_ORIGINS: "http://localhost:9000,https://launchpad.example.test:8443" },
    );

    expect(options().dashboardOrigins).toEqual([
      "https://launchpad.example.test:8443",
      "http://localhost:9000",
    ]);
  });

  it("leaves the option unset when no origin is requested", () => {
    expect(resolve({}).options()).not.toHaveProperty("dashboardOrigins");
  });

  it("fails before onboarding on an invalid origin", () => {
    const { options, error } = resolve({ "dashboard-origin": ["http://launchpad.example.test"] });

    expect(options).toThrow("exit:1");
    expect(error).toHaveBeenCalledWith(expect.stringMatching(/Dashboard origin must use https/));
  });
});
