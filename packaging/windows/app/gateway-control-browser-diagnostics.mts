// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

// Preserve only routing predicates, never device tokens, request IDs or configuration.
export function summarizeGatewayHello(value: unknown) {
  const message = record(value);
  const payload = record(message.payload);
  if (message.type !== "res" || message.ok !== true || payload.type !== "hello-ok") return null;
  const defaults = record(record(payload.snapshot).sessionDefaults);
  const methods = record(payload.features).methods;
  const scopes = record(payload.auth).scopes;
  return {
    defaultAgentIsMain: defaults.defaultAgentId === "main",
    soleAgent: defaults.ownership === "sole",
    modelConfigured:
      typeof defaults.modelConfigured === "boolean" ? defaults.modelConfigured : null,
    selectionRequired:
      typeof defaults.selectionRequired === "boolean" ? defaults.selectionRequired : null,
    setupDetectionAvailable: Array.isArray(methods) && methods.includes("openclaw.setup.detect"),
    adminScope: Array.isArray(scopes) && scopes.includes("operator.admin"),
  };
}

export function gatewayBrowserRoute(value: string) {
  try {
    const pathname = new URL(value).pathname;
    if (pathname === "/settings/model-setup") return "model-setup";
    if (pathname === "/settings/plugins") return "plugins";
    if (pathname === "/chat") return "chat-root";
    if (pathname.startsWith("/chat/")) return "chat-session";
    return "other";
  } catch {
    return "unavailable";
  }
}

export function gatewayBrowserMajorVersion(value: string) {
  const match = /^(\d+)\./u.exec(value);
  const major = match ? Number(match[1]) : NaN;
  return Number.isSafeInteger(major) && major > 0 ? major : null;
}

// Playwright serializes this function. Keep it independent of module scope.
export function installGatewayBrowserRouteTrace() {
  const scope = globalThis as typeof globalThis & {
    __nemoclawRouteTrace?: { routes: string[]; truncated: boolean };
  };
  const trace = { routes: [] as string[], truncated: false };
  scope.__nemoclawRouteTrace = trace;
  const observe = () => {
    const pathname = scope.location.pathname;
    const route =
      pathname === "/settings/model-setup"
        ? "model-setup"
        : pathname === "/settings/plugins"
          ? "plugins"
          : pathname === "/chat"
            ? "chat-root"
            : pathname.startsWith("/chat/")
              ? "chat-session"
              : "other";
    if (trace.routes.at(-1) === route) return;
    if (trace.routes.length >= 64) trace.truncated = true;
    else trace.routes.push(route);
  };
  for (const method of ["pushState", "replaceState"] as const) {
    const original = scope.history[method].bind(scope.history);
    scope.history[method] = (...args) => {
      const result = original(...args);
      observe();
      return result;
    };
  }
  scope.addEventListener("popstate", observe);
  observe();
}

// Read only categorical state from the pinned dashboard's public context getter.
export function readGatewayBrowserRouteTrace() {
  const scope = globalThis as typeof globalThis & { __nemoclawRouteTrace?: unknown };
  const app = scope.document.querySelector("openclaw-app") as
    | (Element & {
        context?: {
          gateway?: {
            snapshot?: {
              phase?: string;
              client?: unknown;
              hello?: {
                auth?: { role?: string };
                snapshot?: { sessionDefaults?: { defaultAgentId?: string } };
              };
            };
          };
          agentSelection?: { state?: { selectedId?: string } };
        };
      })
    | null;
  const snapshot = app?.context?.gateway?.snapshot;
  const selected = app?.context?.agentSelection?.state?.selectedId?.trim();
  const defaultAgent = snapshot?.hello?.snapshot?.sessionDefaults?.defaultAgentId?.trim();
  return {
    trace: scope.__nemoclawRouteTrace,
    connected: snapshot?.phase === "connected",
    hasClient: Boolean(snapshot?.client),
    operatorRole: snapshot?.hello?.auth?.role === "operator",
    selectedIsDefault: defaultAgent ? !selected || selected === defaultAgent : null,
  };
}

export function summarizeGatewayBrowserRouteTrace(value: unknown) {
  const state = record(value);
  const trace = record(state.trace);
  const allowed = new Set(["model-setup", "plugins", "chat-root", "chat-session", "other"]);
  return {
    routes: Array.isArray(trace.routes)
      ? trace.routes
          .slice(0, 64)
          .filter((route): route is string => typeof route === "string" && allowed.has(route))
      : [],
    truncated:
      trace.truncated === true || (Array.isArray(trace.routes) && trace.routes.length > 64),
    connected: state.connected === true,
    hasClient: state.hasClient === true,
    operatorRole: state.operatorRole === true,
    selectedIsDefault:
      typeof state.selectedIsDefault === "boolean" ? state.selectedIsDefault : null,
  };
}
