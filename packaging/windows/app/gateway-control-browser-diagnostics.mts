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
