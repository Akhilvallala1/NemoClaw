// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  gatewayBrowserMajorVersion,
  gatewayBrowserRoute,
  summarizeGatewayHello,
} from "../../../packaging/windows/app/gateway-control-browser-diagnostics.mts";

describe("compiled gateway browser diagnostics", () => {
  it("retains routing predicates without copying tokens or configuration", () => {
    const secret = "fixture-secret-never-publish";
    const summary = summarizeGatewayHello({
      type: "res",
      ok: true,
      id: secret,
      payload: {
        type: "hello-ok",
        auth: { scopes: ["operator.admin"], deviceToken: secret },
        features: { methods: ["openclaw.setup.detect", secret] },
        snapshot: {
          configPath: secret,
          sessionDefaults: {
            defaultAgentId: "main",
            ownership: "sole",
            selectionRequired: false,
            modelConfigured: false,
            mainSessionKey: secret,
          },
        },
      },
    });
    expect(summary).toEqual({
      defaultAgentIsMain: true,
      soleAgent: true,
      modelConfigured: false,
      selectionRequired: false,
      setupDetectionAvailable: true,
      adminScope: true,
    });
    expect(JSON.stringify(summary)).not.toContain(secret);
  });

  it.each([null, [], "secret", { type: "res", ok: false }, { type: "req", ok: true }])(
    "ignores a non-hello message %#",
    (message) => expect(summarizeGatewayHello(message)).toBeNull(),
  );

  it("distinguishes omitted routing predicates from explicit false values", () => {
    expect(summarizeGatewayHello({ type: "res", ok: true, payload: { type: "hello-ok" } })).toEqual(
      {
        defaultAgentIsMain: false,
        soleAgent: false,
        modelConfigured: null,
        selectionRequired: null,
        setupDetectionAvailable: false,
        adminScope: false,
      },
    );
  });

  it.each([
    ["http://127.0.0.1/chat#token=secret", "chat-root"],
    ["http://127.0.0.1/chat/private-session?secret=1", "chat-session"],
    ["http://127.0.0.1/settings/model-setup?firstRun=1#token=secret", "model-setup"],
    ["http://127.0.0.1/settings/plugins", "plugins"],
    ["http://127.0.0.1/private-path", "other"],
    ["not a URL", "unavailable"],
  ])("classifies route %# without retaining the URL", (url, expected) => {
    expect(gatewayBrowserRoute(url)).toBe(expected);
  });

  it.each([
    ["151.0.7922.34", 151],
    ["0.1", null],
    ["999999999999999999999999.0", null],
    ["private browser message", null],
  ])("retains only the numeric browser major version %#", (input, expected) => {
    expect(gatewayBrowserMajorVersion(String(input))).toBe(expected);
  });
});
