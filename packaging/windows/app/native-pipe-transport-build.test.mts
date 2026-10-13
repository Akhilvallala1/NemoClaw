// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import syntax from "typescript";
import { transformSync } from "esbuild";
import { compileNativePipeTransport } from "./native-pipe-transport-build.mts";

const listenerPath = "dist/server-start-yuOHTviK.js";
const listener =
  "module.exports = function(httpServer, port, bindHost) { return httpServer.listen(port, bindHost); };";
const clientPath = "dist/client-I-RoP1Al.js";
const client =
  "module.exports = function(url, transport) { return new WebSocket(url, transport.options); };";
const providerPath = "dist/provider-transport-fetch-DGSx4u4m.js";
const provider =
  "module.exports = function(model, guardedFetchOptions, useEnvProxy) { return fetchWithSsrFGuard(useEnvProxy ? withTrustedEnvProxyGuardedFetchMode(guardedFetchOptions) : guardedFetchOptions); };";
const callPath = "dist/call-BWR5pPgw.js";
const call =
  "function shouldOmitDeviceIdentityForGatewayCall(params) { return params.original; } module.exports = shouldOmitDeviceIdentityForGatewayCall;";
function load(
  relative: string,
  text: string,
  selected?: string,
  platform = "win32",
  broker?: string,
) {
  const code = transformSync(compileNativePipeTransport(relative, text, syntax), {
    format: "cjs",
  }).code;
  const context = {
    module: { exports: undefined as unknown },
    process: {
      platform,
      env: {
        ...(selected === undefined ? {} : { NEMOCLAW_MXC_GATEWAY_PIPE_PORT: selected }),
        ...(broker === undefined ? {} : { NEMOCLAW_MXC_BROKER_PIPE_PORT: broker }),
      },
    },
    fetchWithSsrFGuard: (options: unknown) => options,
    withTrustedEnvProxyGuardedFetchMode: (options: object) => ({
      ...options,
      mode: "trusted_env_proxy",
    }),
    URL,
    require: (name: string) => {
      assert.equal(name, "node:net");
      return { connect: (pipe: string) => ({ pipe }) };
    },
    WebSocket: function (url: string, options: Record<string, unknown>) {
      return { url, options };
    },
  };
  vm.runInNewContext(code, context);
  return context.module.exports as (...args: unknown[]) => unknown;
}

test("declared gateway listener uses only its sandbox-local pipe", () => {
  const listen = load(listenerPath, listener, "18789");
  const server = { listen: (...args: unknown[]) => args };
  const [options] = listen(server, 18789, "127.0.0.1") as { path: string }[];
  assert.equal(options?.path, String.raw`\\.\pipe\LOCAL\OpenShell-Loopback-18789`);
  assert.equal((listen(server, 18789, "::1") as { path: string }[])[0]?.path, options?.path);
  assert.throws(() => listen(server, 18790, "127.0.0.1"), /declared loopback port/);
  assert.throws(() => listen(server, 18789, "0.0.0.0"), /declared loopback port/);
  assert.deepEqual(load(listenerPath, listener)(server, 18789, "127.0.0.1"), [18789, "127.0.0.1"]);
});

test("provider pipe retains guarded fetch and refuses origin or transport changes", () => {
  const fetch = load(providerPath, provider, undefined, "win32", "18790");
  const model = { provider: "nemoclawNative", baseUrl: "http://127.0.0.1:18790/v1" };
  const policy = { allowedOrigins: [model.baseUrl] };
  const init = { method: "POST", headers: { authorization: "fixture" } };
  const options = { url: model.baseUrl + "/chat/completions", timeoutMs: 10000, policy, init };
  const guarded = fetch(model, options, true) as typeof options & {
    dispatcherPolicy: { connect: { socketPath: string } };
    resolveDispatcherPolicy(url: URL): unknown;
  };
  assert.equal(guarded.policy, policy);
  assert.equal(guarded.init, init);
  assert.equal(guarded.timeoutMs, options.timeoutMs);
  assert.equal(
    guarded.dispatcherPolicy.connect.socketPath,
    String.raw`\\.\pipe\LOCAL\OpenShell-Loopback-18790`,
  );
  assert.equal(
    guarded.resolveDispatcherPolicy(new URL(model.baseUrl + "/models")),
    guarded.dispatcherPolicy,
  );
  for (const url of [
    "http://example.invalid:18790/v1/models",
    "http://127.0.0.1:18791/v1/models",
    "http://127.0.0.1:18790/private",
    "https://127.0.0.1:18790/v1/models",
    model.baseUrl + "/models?key=other",
  ])
    assert.throws(() => guarded.resolveDispatcherPolicy(new URL(url)), /escaped/);
  assert.throws(() => fetch(model, { ...options, dispatcherPolicy: {} }), /conflicting/);
  assert.throws(
    () => fetch({ ...model, baseUrl: "https://127.0.0.1:18790/v1" }, options),
    /declared local origin/,
  );
  assert.throws(
    () => load(providerPath, provider, undefined, "win32", "018790")(model, options),
    /Invalid native broker/,
  );
  assert.equal(fetch({ ...model, provider: "other" }, options), options);
  assert.equal(load(providerPath, provider)(model, options), options);
});

test("pipe activation rejects invalid ports and non-Windows execution", () => {
  const server = { listen: () => assert.fail("Invalid configuration reached listen") };
  for (const port of ["", "0", "018789", "65536", "-1", "18789/other", " 18789"])
    assert.throws(
      () => load(listenerPath, listener, port)(server, 18789, "127.0.0.1"),
      /Invalid native gateway pipe port/,
    );
  assert.throws(
    () => load(listenerPath, listener, "18789", "linux")(server, 18789, "127.0.0.1"),
    /Invalid native gateway pipe port/,
  );
});

test("normal gateway client retains options and uses the declared pipe only", () => {
  const connect = load(clientPath, client, "18789");
  const options = { handshakeTimeout: 3000, headers: { authorization: "fixture-token" } };
  for (const host of ["127.0.0.1", "localhost", "[::1]"]) {
    const socket = connect(`ws://${host}:18789`, { options }) as {
      options: typeof options & { createConnection(): { pipe: string } };
    };
    assert.equal(socket.options.headers, options.headers);
    assert.equal(socket.options.handshakeTimeout, options.handshakeTimeout);
    assert.equal(
      socket.options.createConnection().pipe,
      String.raw`\\.\pipe\LOCAL\OpenShell-Loopback-18789`,
    );
  }
  for (const url of ["ws://example.invalid:18789", "ws://127.0.0.1:12345"])
    assert.equal((connect(url, { options }) as { options: unknown }).options, options);
  assert.equal(
    (load(clientPath, client)("ws://127.0.0.1:18789", { options }) as { options: unknown }).options,
    options,
  );
  assert.throws(() => connect("wss://127.0.0.1:18789", { options }), /requires local ws transport/);
});

test("pipe clients retain device identity instead of assuming TCP loopback trust", () => {
  const omit = load(callPath, call, "18789");
  for (const host of ["127.0.0.1", "localhost", "[::1]"])
    assert.equal(omit({ url: `ws://${host}:18789`, original: true }), false);
  for (const url of ["ws://example.invalid:18789", "ws://127.0.0.1:12345"])
    assert.equal(omit({ url, original: true }), true);
  assert.equal(load(callPath, call)({ url: "ws://127.0.0.1:18789", original: true }), true);
  assert.throws(
    () => load(callPath, call, "0")({ url: "ws://127.0.0.1:18789" }),
    /Invalid native gateway/,
  );
});

test("compiler rejects missing or duplicated pinned transport sites", () => {
  assert.equal(compileNativePipeTransport("unrelated.js", listener), listener);
  assert.throws(() => compileNativePipeTransport(listenerPath, listener), /syntax parser/);
  for (const [relative, code] of [
    [listenerPath, listener],
    [clientPath, client],
    [providerPath, provider],
    [callPath, call],
  ]) {
    assert.throws(
      () => compileNativePipeTransport(relative!, "unrelated();", syntax),
      /call site changed/,
    );
    assert.throws(
      () => compileNativePipeTransport(relative!, code! + code!, syntax),
      /call site changed/,
    );
  }
});
