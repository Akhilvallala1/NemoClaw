// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { qualifyNativeOpenClawTurn, stopChild } from "./run-installed-native-turn.mts";
import {
  createPrivateShareRoot,
  qualifyNativeTerminalAgent,
} from "./run-installed-native-hermes-turn.mts";
import type { NativeRuntimeSession } from "./native-runtime.mts";
import { NativeGatewaySession } from "./native-gateway-session.mts";

// Fault injection executes the actual qualification owner. Filesystem calls are
// mocked before entry; no installed runtime, service, sandbox or host path is changed.
async function scenario(
  t: TestContext,
  fault:
    | "second-root"
    | "config"
    | "retained"
    | "existing"
    | "private-failure"
    | "private-timeout"
    | "private-retained"
    | "private-unconfirmed",
  agent: "openclaw" | "hermes",
) {
  const originalArgv = process.argv;
  const originalInstall = process.env.NEMOCLAW_NATIVE_INSTALL_ROOT;
  const artifact = path.join(process.env.SystemDrive!, "\\", "owned-turn-test-evidence");
  process.argv = [
    process.execPath,
    "owned-test",
    "--artifact-directory",
    artifact,
    "--qualification",
    "--agent",
    agent,
  ];
  process.env.NEMOCLAW_NATIVE_INSTALL_ROOT = path.join(
    process.env.SystemDrive!,
    "\\",
    "owned-turn-test-install",
  );
  const roots = new Set<string>();
  const created: string[] = [];
  const removed: string[] = [];
  const receipts: Record<string, unknown>[] = [];
  const diagnostics: string[] = [];
  const primary = new Error("owned-primary-preparation-failure");
  const terminal = agent !== "openclaw";
  const privateFault = fault.startsWith("private-");
  let preflightCalls = 0;
  t.mock.method(NativeGatewaySession.prototype, "preflightConfiguration", (file: string) => {
    assert(privateFault, "Earlier preparation failures must not reach runtime preflight.");
    assert.equal(path.basename(file), "mxc-gateway.toml");
    preflightCalls++;
  });
  const sharePrefix = terminal ? "NemoClawNativeAgentShare-" : "NemoClawNativeShare-";
  const secondPrefix = terminal ? "NemoClawNativeAgentRuntime-" : sharePrefix;
  const runPrefix = terminal ? "NemoClawNativeAgent-" : "NemoClawNativeTurn-";
  const creator = Object.assign(new EventEmitter(), {
    pid: 987654,
    exitCode: null as number | null,
    signalCode: null as string | null,
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: () => {
      if (fault !== "private-retained")
        setImmediate(() => {
          creator.signalCode = "SIGTERM";
          creator.emit("exit", null, "SIGTERM");
          creator.emit("close", null, "SIGTERM");
        });
      return fault !== "private-retained";
    },
  });
  t.mock.method(
    childProcess,
    "spawn",
    (file: string, _args: string[], options: { env: NodeJS.ProcessEnv }) => {
      assert(privateFault, "Preparation faults must not start any process.");
      assert.match(file, /WindowsPowerShell.*powershell[.]exe$/u);
      const privateRoot = options.env.NEMOCLAW_NATIVE_SHARE_ROOT!;
      assert(privateRoot.includes(sharePrefix));
      assert(!roots.has(privateRoot), "The private creator must claim a fresh path.");
      roots.add(privateRoot);
      if (fault !== "private-unconfirmed") {
        created.push(privateRoot);
        setImmediate(() => {
          creator.stdout.emit("data", Buffer.from("NEMOCLAW_PRIVATE_"));
          creator.stdout.emit("data", Buffer.from("SHARE_CREATED\r"));
          creator.stdout.emit("data", Buffer.from("\n"));
        });
      }
      if (fault === "private-failure")
        setImmediate(() => {
          creator.exitCode = 1;
          creator.emit("exit", 1, null);
          creator.emit("close", 1, null);
        });
      return creator;
    },
  );
  syncBuiltinESMExports();
  let templateRead = false;
  const template = '[openshell.drivers.mxc]\nwxc_exec_path = "old.exe"\n';
  t.mock.method(fs, "fstatSync", () => ({ isFile: () => true, size: Buffer.byteLength(template) }));
  t.mock.method(fs, "readSync", (_fd: number, buffer: Buffer) => {
    if (templateRead) return 0;
    templateRead = true;
    return buffer.write(template);
  });
  t.mock.method(fs, "closeSync", () => {});
  t.mock.method(fs, "statSync", () => ({ isFile: () => true, isDirectory: () => true }));
  t.mock.method(fs, "realpathSync", (file: string) => file);
  t.mock.method(
    fs,
    "existsSync",
    (file: string) =>
      roots.has(String(file)) || (fault === "existing" && String(file).includes(sharePrefix)),
  );
  t.mock.method(fs, "mkdirSync", (file: string) => {
    if (fault === "second-root" && file.includes(secondPrefix)) throw primary;
    roots.add(file);
    if (file !== artifact) created.push(file);
  });
  t.mock.method(fs, "openSync", (file: string) => {
    if (file.endsWith("mxc-gateway.toml")) {
      if (privateFault) return 42;
      throw primary;
    }
    throw Object.assign(new Error("owned missing diagnostic"), { code: "ENOENT" });
  });
  t.mock.method(fs, "rmSync", (file: string) => {
    assert(created.includes(file), "Only a root acquired by this call may be removed.");
    removed.push(file);
    if (fault === "retained" && file.includes(runPrefix)) throw new Error("owned-removal-failure");
    if (privateFault && file.includes(sharePrefix))
      assert(
        creator.exitCode !== null || creator.signalCode !== null,
        "Confirm creator exit before removing its share.",
      );
    for (const root of roots)
      if (root === file || root.startsWith(file + path.sep)) roots.delete(root);
  });
  t.mock.method(fs, "writeFileSync", (file: string, content: string) => {
    if (privateFault && file.endsWith("mxc-gateway.toml")) return;
    assert(file.startsWith(artifact + path.sep));
    receipts.push(JSON.parse(content));
  });
  t.mock.method(console, "error", (message: string) => diagnostics.push(message));
  t.mock.method(console, "log", () => {});
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const installation = process.env.NEMOCLAW_NATIVE_INSTALL_ROOT!;
    const runtimeId = "a".repeat(64);
    const runtimeRoot = path.join(installation, "runtimes", runtimeId);
    const agentRoot = path.join(runtimeRoot, agent);
    const lease = {
      purpose: agent,
      runtimeId,
      runtimeRoot,
      agentRoot,
      node: path.join(installation, "bin", "node.exe"),
      python: path.join(agentRoot, "hermes-agent", "venv", "Scripts", "python.exe"),
      bash: path.join(agentRoot, "git", "bin", "bash.exe"),
      assertHeld: () => {},
    } as NativeRuntimeSession;
    const qualify = terminal ? qualifyNativeTerminalAgent : qualifyNativeOpenClawTurn;
    const completion = assert.rejects(qualify(lease), (error: unknown) =>
      fault === "existing"
        ? error instanceof Error && /qualification roots? already exist/u.test(error.message)
        : privateFault
          ? error instanceof Error &&
            error.message.includes(fault === "private-failure" ? "exited 1" : "timed out")
          : error === primary,
    );
    // Attach a handler while fake time advances; retain the assertion failure
    // for the awaited result so mocks are always restored by this scenario.
    void completion.catch(() => {});
    for (let tick = 0; tick < (privateFault ? 75 : 8); tick++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      t.mock.timers.tick(1000);
    }
    await completion;
    assert.equal(preflightCalls, privateFault ? 1 : 0);
    assert(roots.has(artifact), "The evidence directory must be retained.");
    assert.equal(
      created.length,
      fault === "second-root"
        ? 1
        : fault === "existing"
          ? terminal
            ? 2
            : 1
          : terminal && (!privateFault || fault === "private-unconfirmed")
            ? 2
            : 3,
    );
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].verdict, "fail");
    assert.equal(
      receipts[0].ownedQualificationRootsRemoved,
      fault !== "retained" && fault !== "private-retained",
    );
    if (fault === "retained") {
      assert.equal(removed.filter((file) => file.includes(runPrefix)).length, 5);
      assert.equal((receipts[0].retainedQualificationRoots as string[]).length, 1);
      assert.match(diagnostics.join("\n"), /Cleanup also failed: temporary root removal/);
      assert.equal(roots.size, 2, "Evidence and the explicitly retained root remain.");
    } else if (fault === "private-retained") {
      assert.equal(removed.filter((file) => file.includes(sharePrefix)).length, 0);
      assert.equal((receipts[0].retainedQualificationRoots as string[]).length, 1);
      assert((receipts[0].cleanupFailures as string[]).includes("private share creator stop"));
      assert.equal(roots.size, 2, "Retain evidence and the private share until the creator exits.");
    } else if (fault === "private-unconfirmed") {
      assert.equal(removed.filter((file) => file.includes(sharePrefix)).length, 0);
      assert.equal((receipts[0].retainedQualificationRoots as string[]).length, 0);
      assert.equal(typeof receipts[0].unconfirmedShareRoot, "string");
      assert(
        (receipts[0].cleanupFailures as string[]).includes("private share ownership verification"),
      );
      assert.equal(roots.size, 2, "Retain the unconfirmed path without claiming ownership.");
    } else {
      assert.equal(roots.size, 1);
      assert.deepEqual(
        receipts[0].cleanupFailures,
        terminal && fault === "existing" ? ["private share ownership verification"] : [],
      );
    }
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    process.argv = originalArgv;
    if (originalInstall === undefined) delete process.env.NEMOCLAW_NATIVE_INSTALL_ROOT;
    else process.env.NEMOCLAW_NATIVE_INSTALL_ROOT = originalInstall;
  }
}

for (const agent of ["openclaw", "hermes"] as const)
  for (const fault of [
    "second-root",
    "config",
    "retained",
    "existing",
    ...(agent === "openclaw"
      ? []
      : ["private-failure", "private-timeout", "private-retained", "private-unconfirmed"]),
  ] as const)
    test(
      `${agent} qualification cleanup: ${fault}`,
      {
        skip: process.platform !== "win32" || process.arch !== "arm64",
      },
      (t) => scenario(t, fault as Parameters<typeof scenario>[1], agent),
    );

// This component check exercises only a fresh temporary directory and the real
// Windows security API; it does not start an installed runtime or gateway.
test(
  "private share creation enforces its DACL and refuses an existing directory",
  {
    skip: process.platform !== "win32" || process.arch !== "arm64",
    timeout: 150_000,
  },
  async (t) => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-private-share-control-"));
    const share = path.join(fixture, "share");
    const creators: childProcess.ChildProcess[] = [];
    let claims = 0;
    const spawn = childProcess.spawn;
    let explicitModuleCalls = 0;
    t.mock.method(childProcess, "spawn", (...args: Parameters<typeof spawn>) => {
      const arguments_ = [...args[1]!];
      const encodedIndex = arguments_.indexOf("-EncodedCommand") + 1;
      assert(encodedIndex > 0, "The private creator must receive its encoded script.");
      const script = Buffer.from(arguments_[encodedIndex]!, "base64").toString("utf16le");
      arguments_[encodedIndex] = Buffer.from(
        "$PSModuleAutoLoadingPreference = 'None'\n" + script,
        "utf16le",
      ).toString("base64");
      explicitModuleCalls++;
      return spawn(args[0], arguments_, args[2]);
    });
    syncBuiltinESMExports();
    try {
      const acl = await createPrivateShareRoot(
        share,
        process.env.SystemRoot!,
        (child) => creators.push(child),
        () => {
          claims++;
        },
      );
      assert.equal(claims, 1);
      assert.equal(acl.protected, true);
      assert.equal(acl.nonOwnerDataAccess, false);
      assert.equal(acl.serviceSid, "S-1-5-18");
      assert.deepEqual(acl.deniedSids, ["S-1-1-0", "S-1-5-11", "S-1-5-32-545"]);
      const retainedFile = path.join(share, "retained.txt");
      fs.writeFileSync(retainedFile, "existing-content", { flag: "wx" });
      await assert.rejects(
        createPrivateShareRoot(
          share,
          process.env.SystemRoot!,
          (child) => creators.push(child),
          () => {
            claims++;
          },
        ),
        /Private share root already exists/u,
      );
      assert.equal(
        explicitModuleCalls,
        2,
        "Both creation and refusal must work without autoloading.",
      );
      assert.equal(claims, 1, "An existing directory must not transfer ownership.");
      assert.equal(fs.readFileSync(retainedFile, "utf8"), "existing-content");
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
      const stopped = await Promise.all(creators.map(stopChild));
      assert(
        stopped.every(Boolean),
        `Private-share creator did not stop; fixture retained: ${fixture}`,
      );
      fs.rmSync(fixture, { recursive: true, force: true });
      assert(!fs.existsSync(fixture));
    }
  },
);
