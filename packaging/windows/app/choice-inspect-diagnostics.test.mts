// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { choiceInspectChildDiagnostics } from "./choice-inspect-diagnostics.mts";

function fixture(invoke: (...args: unknown[]) => unknown) {
  const methods = ["spawn", "spawnSync", "execFile", "execFileSync"];
  const cp = Object.fromEntries(methods.map((method) => [method, invoke]));
  const lines: string[] = [];
  let syncs = 0;
  runInNewContext(choiceInspectChildDiagnostics, {
    require(name: string) {
      if (name === "node:child_process") return cp;
      assert.equal(name, "node:module");
      return { syncBuiltinESMExports: () => syncs++ };
    },
    process: { execPath: "/private/node", stderr: { write: (line: string) => lines.push(line) } },
    performance: { now: () => 10 },
  });
  assert.equal(syncs, 1);
  const records = () => lines.map((line) => JSON.parse(line.slice(line.indexOf("{")).trim()));
  return { cp, lines, records };
}

test("inspect diagnostics preserve child calls and disclose only bounded categories", () => {
  const child = new EventEmitter();
  const args = ["--openclaw-sqlite-readonly-child", "secret-database-path"];
  const options = { env: { SECRET: "secret-environment" } };
  const callback = () => {};
  const receiver = {};
  const { cp, lines, records } = fixture(function (this: unknown, ...actual) {
    assert.equal(this, receiver);
    assert.deepEqual(actual, ["/private/node", args, options, callback]);
    assert.equal(actual[1], args);
    assert.equal(actual[2], options);
    assert.equal(actual[3], callback);
    return child;
  });
  assert.equal(cp.execFile.call(receiver, "/private/node", args, options, callback), child);
  assert.equal(records().length, 1);
  child.emit("close", 1, "SIGTERM");
  assert.deepEqual(records(), [
    { id: 1, method: "execFile", category: "node-sqlite-readonly", stage: "start", elapsedMs: 0 },
    { id: 1, method: "execFile", category: "node-sqlite-readonly", stage: "closed", elapsedMs: 0 },
  ]);
  assert.doesNotMatch(lines.join(""), /private|secret|SIGTERM/);
});

test("inspect diagnostics preserve synchronous results and thrown errors", () => {
  const result = { status: 1, stderr: "secret-output" };
  const returned = fixture(() => result);
  assert.equal(returned.cp.spawnSync("C:\\Windows\\powershell.exe", ["secret-script"]), result);
  assert.deepEqual(
    returned.records().map(({ category, stage }) => [category, stage]),
    [
      ["powershell", "start"],
      ["powershell", "returned"],
    ],
  );
  const failure = new Error("secret-failure");
  const thrown = fixture(() => {
    throw failure;
  });
  assert.throws(
    () => thrown.cp.execFileSync("private-executable"),
    (error) => error === failure,
  );
  assert.deepEqual(
    thrown.records().map(({ category, stage }) => [category, stage]),
    [
      ["other", "start"],
      ["other", "threw"],
    ],
  );
  assert.doesNotMatch([...returned.lines, ...thrown.lines].join(""), /secret|private|Windows/);
});

test("inspect diagnostics stop recording without stopping child calls", () => {
  let calls = 0;
  const { cp, records } = fixture(() => {
    calls++;
    return {};
  });
  for (let i = 0; i < 200; i++) cp.spawnSync("/private/node");
  assert.equal(calls, 200);
  assert.equal(records().length, 128);
  assert(records().every(({ category }) => category === "node"));
});

test("inspect diagnostics retain the package-manager trap and real Node callback output", () => {
  const result = spawnSync(
    process.execPath,
    [
      "-e",
      `
    const assert = require("node:assert/strict"), cp = require("node:child_process");
    const original = cp.execFile;
    const refusal = new Error("synthetic package-manager refusal");
    cp.execFile = function(...args) {
      if (args[0] === "npm") throw refusal;
      return original.apply(this, args);
    };
    ${choiceInspectChildDiagnostics}
    assert.throws(() => cp.execFile("npm"), error => error === refusal);
    cp.execFile(process.execPath, ["-e", "process.stdout.write('retained-output')"],
      {encoding:"utf8"}, (error, stdout) => {
        assert.ifError(error);
        assert.equal(stdout, "retained-output");
        process.stdout.write("callback-preserved");
      });
  `,
    ],
    { encoding: "utf8", timeout: 10000, windowsHide: true },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "callback-preserved");
  assert.match(result.stderr, /"stage":"threw"/);
  assert.match(result.stderr, /"category":"node","stage":"closed"/);
  assert.doesNotMatch(result.stderr, /retained-output|package-manager refusal|process\.stdout/);
});
