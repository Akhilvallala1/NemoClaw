// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { runInNewContext } from "node:vm";
import {
  gatewayBrowserMajorVersion,
  gatewayBrowserRoute,
  installGatewayBrowserRouteTrace,
  readGatewayBrowserRouteTrace,
  summarizeGatewayBrowserRouteTrace,
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

describe("compiled gateway navigation diagnostics", () => {
  it("observes route changes without changing history results or copying URLs", () => {
    const secret = "navigation-secret-never-publish";
    const location = { pathname: "/chat" };
    const events = new Map<string, () => void>();
    const historyCall = (data: unknown, _unused: string, url: string) => {
      location.pathname = new URL(url, "http://127.0.0.1").pathname;
      return data;
    };
    const scope = {
      location,
      history: { pushState: historyCall, replaceState: historyCall },
      addEventListener: (name: string, listener: () => void) => events.set(name, listener),
      document: { querySelector: () => null },
    };
    runInNewContext(`(${installGatewayBrowserRouteTrace.toString()})()`, scope);
    expect(scope.history.replaceState(42, secret, `/settings/model-setup#token=${secret}`)).toBe(
      42,
    );
    expect(scope.history.pushState(43, secret, `/chat/${secret}?token=${secret}`)).toBe(43);
    expect(() => scope.history.pushState(0, secret, "http://[")).toThrow(TypeError);
    location.pathname = "/private-path";
    events.get("popstate")?.();
    const summary = summarizeGatewayBrowserRouteTrace(
      runInNewContext(`(${readGatewayBrowserRouteTrace.toString()})()`, scope),
    );
    expect(summary.routes).toEqual(["chat-root", "model-setup", "chat-session", "other"]);
    expect(summary.truncated).toBe(false);
    expect(summary.selectedIsDefault).toBeNull();
    expect(JSON.stringify(summary)).not.toContain(secret);
  });

  it("bounds retained navigation history", () => {
    const scope = {
      location: { pathname: "/chat" },
      history: {
        pushState: () => {},
        replaceState: () => {},
      },
      addEventListener: () => {},
      document: { querySelector: () => null },
    };
    runInNewContext(`(${installGatewayBrowserRouteTrace.toString()})()`, scope);
    // Seed prior observations, then cross the limit through actual history calls.
    runInNewContext(
      'globalThis.__nemoclawRouteTrace.routes.push(...Array(62).fill("plugins"))',
      scope,
    );
    scope.location.pathname = "/settings/model-setup";
    scope.history.pushState();
    scope.location.pathname = "/chat";
    scope.history.pushState();
    const summary = summarizeGatewayBrowserRouteTrace(
      runInNewContext(`(${readGatewayBrowserRouteTrace.toString()})()`, scope),
    );
    expect(summary.routes).toHaveLength(64);
    expect(summary.truncated).toBe(true);
  });

  it.each([
    [undefined, true],
    ["main", true],
    [" main ", true],
    ["private-agent", false],
  ])(
    "projects selected-agent equality without copying the identity: %#",
    (selectedId, expected) => {
      const secret = "snapshot-secret-never-publish";
      const scope = {
        document: {
          querySelector: () => ({
            context: {
              gateway: {
                snapshot: {
                  phase: "connected",
                  client: { token: secret },
                  hello: {
                    auth: { role: "operator", token: secret },
                    snapshot: { sessionDefaults: { defaultAgentId: "main" } },
                  },
                },
              },
              agentSelection: { state: { selectedId } },
            },
          }),
        },
      };
      const summary = summarizeGatewayBrowserRouteTrace(
        runInNewContext(`(${readGatewayBrowserRouteTrace.toString()})()`, scope),
      );
      expect(summary).toMatchObject({
        connected: true,
        hasClient: true,
        operatorRole: true,
        selectedIsDefault: expected,
      });
      expect(JSON.stringify(summary)).not.toContain(secret);
      expect(JSON.stringify(summary)).not.toContain("private-agent");
    },
  );

  it("rejects unrecognized page-supplied trace values", () => {
    const summary = summarizeGatewayBrowserRouteTrace({
      trace: {
        routes: ["chat-root", "secret", { token: "secret" }, ...Array(100).fill("plugins")],
        truncated: "secret",
      },
      connected: "secret",
      hasClient: {},
      operatorRole: "secret",
      selectedIsDefault: "secret",
      token: "secret",
    });
    expect(summary.routes.length).toBeLessThanOrEqual(64);
    expect(summary.routes.every((route) => route === "chat-root" || route === "plugins")).toBe(
      true,
    );
    expect(summary.truncated).toBe(true);
    expect(summary).toMatchObject({
      connected: false,
      hasClient: false,
      operatorRole: false,
      selectedIsDefault: null,
    });
    expect(JSON.stringify(summary)).not.toContain("secret");
  });
});
