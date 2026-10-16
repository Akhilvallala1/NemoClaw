// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { HERMES_NATIVE_CONFIG_WRITE } from "../../../src/lib/sandbox/hermes-native-config";

const original = "model:\n  default: old-model\nmcp_servers: {}\ncustom: retained\n";
const updated = original.replace("old-model", "selected-model");

function transaction(scenario: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-native-config-"));
  try {
    const home = path.join(root, "home");
    fs.mkdirSync(home, { mode: 0o700 });
    fs.writeFileSync(path.join(home, "config.yaml"), original, { mode: 0o600 });
    fs.writeFileSync(path.join(home, ".env"), "SAFE_SETTING=true\n", { mode: 0o600 });
    const hash = (text: string) => createHash("sha256").update(text).digest("hex");
    const hashes = `${hash(original)}  ${home}/config.yaml\n${hash("SAFE_SETTING=true\n")}  ${home}/.env\n`;
    fs.writeFileSync(path.join(home, ".config-hash"), hashes, { mode: 0o600 });
    const lockDir = path.join(root, "lock");
    fs.mkdirSync(lockDir, { mode: 0o755 });
    fs.writeFileSync(path.join(lockDir, "transaction"), "", { mode: 0o444 });
    fs.chmodSync(lockDir, 0o755);
    fs.chmodSync(path.join(lockDir, "transaction"), 0o444);
    const shim = path.join(root, "helper.py");
    // Exercise the real filesystem guards and transaction lock. Runtime identity
    // and the installed Hermes schema are exercised by the Brev reproduction.
    fs.writeFileSync(
      shim,
      `
import importlib.util, os, sys, types
from pathlib import Path

def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, filename)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module

guard = load("native_guard", ${JSON.stringify(path.resolve("agents/hermes/runtime-config-guard.py"))})
helper = load("native_helper", ${JSON.stringify(path.resolve("agents/hermes/mcp-config-transaction.py"))})
helper.HERMES_DIR = ${JSON.stringify(home)}
helper.CONFIG_PATH = helper.HERMES_DIR + "/config.yaml"
helper.MCP_TRANSACTION_LOCK_PATH = ${JSON.stringify(path.join(lockDir, "transaction"))}
helper.MCP_TRANSACTION_LOCK_EXPECTED_UID = os.geteuid()
helper.MCP_TRANSACTION_LOCK_EXPECTED_GID = os.stat(helper.MCP_TRANSACTION_LOCK_PATH).st_gid
helper._load_guard = lambda: guard
helper._assert_non_root_lifecycle_identity = lambda: None
helper._configure_gateway_public_port = lambda: None
helper.reload_gateway = lambda: True
schema = types.ModuleType("gateway.config")
schema.GatewayConfig = type("GatewayConfig", (), {"from_dict": staticmethod(lambda data: data)})
sys.modules["gateway.config"] = schema
scenario = ${JSON.stringify(scenario)}
if scenario == "lifecycle":
    def reject(): raise PermissionError("wrong lifecycle")
    helper._assert_non_root_lifecycle_identity = reject
if scenario == "reload-failure":
    helper.reload_gateway = lambda: False
if scenario == "hash-drift":
    Path(helper.HERMES_DIR + "/.env").write_text("changed=true\\n")
if scenario == "symlink":
    current = Path(helper.CONFIG_PATH)
    current.rename(current.with_suffix(".original"))
    current.symlink_to(current.with_suffix(".original"))
if scenario == "hardlink":
    os.link(helper.CONFIG_PATH, helper.CONFIG_PATH + ".link")
if scenario == "hash-failure":
    def fail_hash(*args): raise RuntimeError("injected hash failure")
    helper._refresh_and_verify_hashes = fail_hash
if scenario == "concurrent-write":
    write = guard._write_existing
    def raced_write(filename, text, snapshot, mode=None):
        write(filename, text, snapshot, mode)
        if filename == helper.CONFIG_PATH:
            Path(filename).write_text("model: concurrent-writer\\n")
    guard._write_existing = raced_write
for name, value in vars(helper).items():
    if not name.startswith("__"): globals()[name] = value
`,
    );
    const candidate =
      scenario === "mcp-change"
        ? updated.replace(
            "mcp_servers: {}",
            "mcp_servers: {other: {url: 'https://example.test/mcp'}}",
          )
        : updated;
    const script = HERMES_NATIVE_CONFIG_WRITE.replace(
      "except Exception:\n    # Config parser",
      "except Exception:\n    import traceback; traceback.print_exc()\n    # Config parser",
    ).replace("/usr/local/lib/nemoclaw/hermes-mcp-config-transaction.py", shim);
    const result = spawnSync(
      "python3",
      ["-c", script, scenario === "stale" ? "0".repeat(64) : hash(original)],
      {
        input: candidate,
        encoding: "utf8",
        timeout: 10_000,
      },
    );
    return {
      result,
      config: fs.readFileSync(path.join(home, "config.yaml"), "utf8"),
      hash: fs.readFileSync(path.join(home, ".config-hash"), "utf8"),
      originalHash: hashes,
      updatedHash: hash(updated),
    };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

describe("native Hermes config transaction", () => {
  it("updates the selected model and compatibility hash while preserving unrelated configuration", () => {
    const actual = transaction("success");
    expect(actual.result.status, actual.result.stderr).toBe(0);
    expect(actual.config).toBe(updated);
    expect(actual.hash).toContain(actual.updatedHash);
  });

  it.each([
    "stale",
    "lifecycle",
    "symlink",
    "hardlink",
    "mcp-change",
    "hash-failure",
    "reload-failure",
  ])("preserves configuration and its hash after %s rejection", (scenario) => {
    const actual = transaction(scenario);
    expect(actual.result.status).not.toBe(0);
    expect(actual.config).toBe(original);
    expect(actual.hash).toBe(actual.originalHash);
  });

  it("refuses mismatched environment integrity before writing configuration", () => {
    const actual = transaction("hash-drift");
    expect(actual.result.status).not.toBe(0);
    expect(actual.config).toBe(original);
  });

  it("retains a concurrent writer's configuration instead of rolling it back", () => {
    const actual = transaction("concurrent-write");
    expect(actual.result.status).not.toBe(0);
    expect(actual.config).toBe("model: concurrent-writer\n");
  });
});
