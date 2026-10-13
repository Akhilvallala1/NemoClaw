// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  NATIVE_NODE_UI_POLICY,
  nativeQualificationLoopbackConfig,
  renderNativeGatewayConfig,
  writeNativeGatewayConfig,
  type NativeGatewayOptions,
} from "./native-security.mts";

const template =
  '[openshell.drivers.mxc]\nwxc_exec_path = "stock.exe"\nbackend = "process_container"\n[other]\nretained = true\n';
const render = (options: NativeGatewayOptions = {}) =>
  renderNativeGatewayConfig(template, "C:\\NemoClaw", undefined, options);

test("supervised OpenClaw configuration uses the current driver schema without direct network grants", () => {
  const rendered = render({ network: { kind: "supervised" } });
  assert.match(rendered, /pc_allow_local_network = false\n/u);
  for (const unsupported of ["pc_network_allow", "pc_host_console", "pc_loopback_ports"])
    assert(!rendered.includes(unsupported));
  assert.throws(
    () => render({ network: { kind: "supervised" }, hostConsole: true }),
    /cannot grant the host console/u,
  );
  assert.throws(
    () => render({ network: { kind: "supervised", ports: [80] } } as NativeGatewayOptions),
    /profile network/u,
  );
});

test("gateway profiles keep qualification networking separate from Personal preview", () => {
  const denied = render();
  assert.match(
    denied,
    /pc_network_allow = false\npc_allow_local_network = false\npc_host_console = false\npc_loopback_ports = \[\]/u,
  );
  const personal = render({ network: { kind: "personal" }, hostConsole: true });
  assert.match(
    personal,
    /pc_network_allow = true\npc_allow_local_network = true\npc_host_console = true\npc_loopback_ports = \[\]/u,
  );
  const network = nativeQualificationLoopbackConfig(
    { tier: "base-container", needsDaclAugmentation: false },
    [1, 18080, 65535, 18080],
  );
  const qualification = render({ network });
  assert.match(
    qualification,
    /pc_network_allow = false\npc_allow_local_network = false\npc_host_console = false\npc_loopback_ports = \[1,18080,65535\]/u,
  );
  for (const rendered of [denied, personal, qualification]) {
    assert(rendered.endsWith('backend = "process_container"\n[other]\nretained = true\n'));
    assert(!rendered.includes("internetClient"));
    assert.equal(rendered.split("pc_loopback_ports =").length, 2);
  }
  assert.deepEqual(
    nativeQualificationLoopbackConfig(
      { tier: "appcontainer-dacl", needsDaclAugmentation: true },
      [18080],
    ),
    { kind: "deny" },
  );
});

test("gateway profiles reject malformed ports, modes, and conflicting options", () => {
  for (const ports of [[], Array(1), [0], [-1], [65536], [1.5], [NaN], [Infinity], ["80"], null]) {
    assert.throws(
      () => render({ network: { kind: "loopback", ports } } as NativeGatewayOptions),
      /loopback ports/u,
    );
  }
  for (const options of [
    { network: { kind: "unknown" } },
    { network: null },
    { network: { kind: "personal", ports: [80] } },
    { network: { kind: "deny", ports: [80] } },
    { hostConsole: "true" },
    { personalNetwork: true },
    null,
  ])
    assert.throws(() => render(options as NativeGatewayOptions), /gateway profile/u);
  for (const probe of [
    null,
    {},
    { tier: "base-container", needsDaclAugmentation: true },
    { tier: "appcontainer-dacl", needsDaclAugmentation: false },
  ]) {
    assert.throws(() => nativeQualificationLoopbackConfig(probe, [80]), /qualification/u);
  }
});

test("gateway templates cannot override the session-owned networking or console profile", () => {
  for (const key of [
    "pc_network_allow",
    "pc_allow_local_network",
    "pc_host_console",
    "pc_loopback_ports",
    "egress_proxy",
    "egress_proxy_addr",
    "pc_relay_spawner_path",
    "pc_relay_target_port",
  ]) {
    const conflicting = template.replace('backend = "process_container"', `${key} = true`);
    assert.throws(() => renderNativeGatewayConfig(conflicting, "C:\\NemoClaw"), /session-owned/u);
  }
  assert.throws(
    () => renderNativeGatewayConfig(template + "[openshell.drivers.mxc]\n", "C:\\NemoClaw"),
    /one MXC/u,
  );
  assert.throws(
    () =>
      renderNativeGatewayConfig(
        template.replace('wxc_exec_path = "stock.exe"', ""),
        "C:\\NemoClaw",
      ),
    /executable path/u,
  );
});

test("Node compatibility permits graphical startup but denies clipboard and input injection", () => {
  assert.deepEqual(NATIVE_NODE_UI_POLICY, [
    "ui:",
    "  allow_graphical_ui: true",
    "  clipboard: none",
    "  allow_input_injection: false",
    "",
  ]);
  assert(Object.isFrozen(NATIVE_NODE_UI_POLICY));
});

test("gateway writer validates the template before probing and refuses to overwrite configuration", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-profile-"));
  try {
    const install = path.join(root, "install");
    const run = path.join(root, "run");
    fs.mkdirSync(path.join(install, "config"), { recursive: true });
    fs.mkdirSync(run);
    const input = path.join(install, "config", "mxc-gateway.toml");
    let probes = 0;
    const profile = async (): Promise<NativeGatewayOptions> => {
      probes += 1;
      return { network: { kind: "loopback", ports: [18080] } };
    };
    fs.writeFileSync(input, "[other]\nvalue = true\n");
    await assert.rejects(writeNativeGatewayConfig(install, run, undefined, profile), /one MXC/u);
    assert.equal(probes, 0);
    assert.deepEqual(fs.readdirSync(run), []);
    fs.writeFileSync(input, template);
    await assert.rejects(
      writeNativeGatewayConfig(install, install, undefined, profile),
      /outside/u,
    );
    assert.equal(probes, 0);
    const output = await writeNativeGatewayConfig(install, run, undefined, profile);
    assert.equal(probes, 1);
    assert.equal(
      fs.readFileSync(output, "utf8"),
      renderNativeGatewayConfig(template, install, undefined, {
        network: { kind: "loopback", ports: [18080] },
      }),
    );
    const before = fs.readFileSync(output);
    await assert.rejects(writeNativeGatewayConfig(install, run), /EEXIST/u);
    assert.deepEqual(fs.readFileSync(output), before);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
