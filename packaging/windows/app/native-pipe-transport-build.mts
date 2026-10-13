// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import type ts from "typescript";

const listenerModule = "dist/server-start-yuOHTviK.js";
const clientModule = "dist/client-I-RoP1Al.js";
const providerModule = "dist/provider-transport-fetch-DGSx4u4m.js";
const callModule = "dist/call-BWR5pPgw.js";
const portHelper = String.raw`
function __nemoPipePort() {
  const value = process.env.NEMOCLAW_MXC_GATEWAY_PIPE_PORT;
  if (value === undefined) return undefined;
  if (process.platform !== "win32" || !/^[1-9][0-9]{0,4}$/.test(value) || Number(value) > 65535)
    throw Error("Invalid native gateway pipe port");
  return Number(value);
}
function __nemoPipeName(port) { return "\\\\.\\pipe\\LOCAL\\OpenShell-Loopback-" + port; }
`;
const listenerHelper = String.raw`
function __nemoListenGateway(httpServer, port, bindHost) {
  const selected = __nemoPipePort();
  if (selected === undefined) return httpServer.listen(port, bindHost);
  if (selected !== port || !["127.0.0.1", "::1"].includes(bindHost))
    throw Error("Native gateway pipe requires the declared loopback port");
  return httpServer.listen({ path: __nemoPipeName(port) });
}
`;
const clientHelper = String.raw`
import { connect as __nemoConnectPipe } from "node:net";
function __nemoGatewaySocketOptions(url, options) {
  const selected = __nemoPipePort();
  if (selected === undefined) return options;
  const target = new URL(url);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(target.hostname) || Number(target.port) !== selected)
    return options;
  if (target.protocol !== "ws:") throw Error("Native gateway pipe requires local ws transport");
  return { ...options, createConnection: () => __nemoConnectPipe(__nemoPipeName(selected)) };
}
`;
const providerHelper = String.raw`
function __nemoBrokerFetchOptions(model, options) {
  const value = process.env.NEMOCLAW_MXC_BROKER_PIPE_PORT;
  if (value === undefined || typeof model.provider !== "string" || model.provider.toLowerCase() !== "nemoclawnative") return options;
  if (process.platform !== "win32" || !/^[1-9][0-9]{0,4}$/.test(value) || Number(value) > 65535)
    throw Error("Invalid native broker pipe port");
  const base = new URL(model.baseUrl);
  const origin = "http://127.0.0.1:" + value;
  if (base.origin !== origin || base.username || base.password || base.pathname !== "/v1" || base.search || base.hash)
    throw Error("Native broker requires its declared local origin");
  if (options.dispatcherPolicy || options.resolveDispatcherPolicy || process.env.OPENCLAW_PROXY_ACTIVE === "1")
    throw Error("Native broker has conflicting transport settings");
  const selected = { mode: "direct", connect: { socketPath: __nemoPipeName(Number(value)) } };
  const resolveDispatcherPolicy = (target) => {
    if (target.origin !== origin || target.username || target.password ||
        !["/v1/models", "/v1/chat/completions"].includes(target.pathname) || target.search || target.hash)
      throw Error("Native broker request escaped its declared endpoint");
    return selected;
  };
  resolveDispatcherPolicy(new URL(options.url));
  return { ...options, dispatcherPolicy: selected, resolveDispatcherPolicy };
}
`;
const identityHelper = String.raw`
function __nemoPipeRequiresIdentity(url) {
  const selected = __nemoPipePort();
  if (selected === undefined) return false;
  const target = new URL(url);
  return ["127.0.0.1", "localhost", "[::1]"].includes(target.hostname) && Number(target.port) === selected;
}
`;

/** Change only the pinned gateway listener/client call sites, never Node prototypes. */
export function compileNativePipeTransport(relative: string, text: string, syntax?: typeof ts) {
  if (
    relative !== listenerModule &&
    relative !== clientModule &&
    relative !== providerModule &&
    relative !== callModule
  )
    return text;
  if (!syntax) throw new Error("Native gateway compilation requires the syntax parser.");
  const file = syntax.createSourceFile(
    relative,
    text,
    syntax.ScriptTarget.Latest,
    true,
    syntax.ScriptKind.JS,
  );
  const edits: { start: number; end: number; replacement: string }[] = [];
  const visit = (node: ts.Node) => {
    if (
      relative === callModule &&
      syntax.isFunctionDeclaration(node) &&
      node.name?.text === "shouldOmitDeviceIdentityForGatewayCall" &&
      node.body &&
      node.parameters.length === 1 &&
      node.parameters[0]?.name.getText(file) === "params"
    )
      edits.push({
        start: node.body.getStart(file) + 1,
        end: node.body.getStart(file) + 1,
        replacement: "\nif (__nemoPipeRequiresIdentity(params.url)) return false;\n",
      });
    if (
      relative === listenerModule &&
      syntax.isCallExpression(node) &&
      syntax.isPropertyAccessExpression(node.expression) &&
      node.expression.expression.getText(file) === "httpServer" &&
      node.expression.name.text === "listen" &&
      node.arguments.length === 2 &&
      node.arguments[0]?.getText(file) === "port" &&
      node.arguments[1]?.getText(file) === "bindHost"
    )
      edits.push({
        start: node.getStart(file),
        end: node.end,
        replacement: "__nemoListenGateway(httpServer, port, bindHost)",
      });
    if (
      relative === clientModule &&
      syntax.isNewExpression(node) &&
      node.expression.getText(file) === "WebSocket" &&
      node.arguments?.length === 2 &&
      node.arguments[0]?.getText(file) === "url" &&
      node.arguments[1]?.getText(file) === "transport.options"
    )
      edits.push({
        start: node.arguments[1].getStart(file),
        end: node.arguments[1].end,
        replacement: "__nemoGatewaySocketOptions(url, transport.options)",
      });
    if (
      relative === providerModule &&
      syntax.isCallExpression(node) &&
      node.expression.getText(file) === "fetchWithSsrFGuard" &&
      node.arguments.length === 1 &&
      node.arguments[0]?.getText(file) ===
        "useEnvProxy ? withTrustedEnvProxyGuardedFetchMode(guardedFetchOptions) : guardedFetchOptions"
    )
      edits.push({
        start: node.arguments[0].getStart(file),
        end: node.arguments[0].end,
        replacement: "__nemoBrokerFetchOptions(model, " + node.arguments[0].getText(file) + ")",
      });
    syntax.forEachChild(node, visit);
  };
  visit(file);
  if (edits.length !== 1) throw new Error(`Pinned native gateway call site changed: ${relative}`);
  const edit = edits[0]!;
  return (
    portHelper +
    (relative === listenerModule
      ? listenerHelper
      : relative === clientModule
        ? clientHelper
        : relative === callModule
          ? identityHelper
          : providerHelper) +
    text.slice(0, edit.start) +
    edit.replacement +
    text.slice(edit.end)
  );
}
