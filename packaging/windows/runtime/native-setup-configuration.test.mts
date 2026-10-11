// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { stripTypeScriptTypes } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";
import { configureNativeFromStdin } from "./native-setup-configuration.mts";
import {
  NATIVE_NODE_UI_POLICY,
  nativeCredentialBinding,
  renderNativeGatewayConfig,
} from "./native-security.mts";
import { nativeServiceBinding } from "./native-options.mts";
import { NATIVE_EXPRESS } from "./native-inference-manifest.mts";
import { interactiveWorkloadSource } from "./run-installed-native-console-agent.mts";
import type { NativeOptions } from "./native-options.mts";
import { hermesDashboardPythonSource } from "./native-hermes-dashboard.mts";
import {
  buildNativeWorkers,
  renderFactory,
  staticWorkerSource,
} from "../distribution/build-native-workers.mts";
import { prepareRuntimeSource } from "../distribution/prepare-runtime-source.mts";
import { probeSource } from "./run-installed-native-turn.mts";
import { gatewaySource } from "./run-installed-native-web-ui.mts";
import {
  nativeHermesToolEnvironment,
  nativeHermesCompatibility,
  bindNativeRuntimeGuard,
  nativeRuntimeWorkerCommand,
  validateNativeRuntimeReceipt,
  acquireNativeRuntimeSession,
  type NativeRuntimePurpose,
} from "./native-runtime.mts";

for (const removed of ["pi", "langchain-deepagents-code", "nemocua"]) {
  test(`retired ${removed} cannot acquire an installed runtime lease`, async () => {
    const purpose = removed as NativeRuntimePurpose;
    assert.throws(
      () => validateNativeRuntimeReceipt({}, "C:\\Program Files\\NVIDIA\\NemoClaw", purpose),
      /installed runtime identity is invalid/u,
    );
    await assert.rejects(
      acquireNativeRuntimeSession(
        "must-not-execute",
        "C:\\Program Files\\NVIDIA\\NemoClaw",
        purpose,
      ),
      /native runtime purpose is invalid/u,
    );
  });
}

test("compiled native workers expose only retained agent modes", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "two-agent-workers-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const staged = prepareRuntimeSource(fileURLToPath(new URL("./", import.meta.url)));
  t.after(() => staged.close());
  assert.equal(staged.receipt.adapterSha256, null);
  assert.equal(staged.receipt.preimagesVerified, 0);
  assert.equal(staged.receipt.removedDiagnosticGuards.length, 6);
  const output = path.join(root, "compiled");
  const report = await buildNativeWorkers(staged.runtime, output);
  assert.equal(report.installedExecutionQualified, false);
  assert.deepEqual(report.modes, ["openclaw-turn", "openclaw-web", "hermes-turn", "interactive"]);
  const described = spawnSync(
    process.execPath,
    [path.join(output, "native-runtime.cjs"), "--describe-runtime"],
    {
      encoding: "utf8",
      timeout: 10_000,
    },
  );
  assert.equal(described.status, 0, described.stderr);
  const description = JSON.parse(described.stdout);
  assert.deepEqual(description.guestModes, report.modes);
  assert.deepEqual(description.hostModes, [
    "turn",
    "terminal-turn",
    "console",
    "web",
    "hermes-dashboard",
    "inference",
  ]);
  assert.deepEqual(fs.readdirSync(path.join(output, "python-build-inputs")).sort(), [
    "hermes-console-probe.py",
    "hermes-console.py",
    "hermes-dashboard-probe.py",
    "hermes-dashboard.py",
    "hermes-turn.py",
  ]);
});

test("runtime preparation refuses historical patches and a missing diagnostic entry", (t) => {
  assert.throws(
    () => Reflect.apply(prepareRuntimeSource, null, ["must-not-read", "historical.patch"]),
    /patches are no longer accepted/u,
  );
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-entry-inventory-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "unexpected.mts"), "export const fixture = true;\n");
  assert.throws(() => prepareRuntimeSource(root), /diagnostic entry inventory changed/u);
});

test("prebuilt OpenClaw factories materialize the exported workers as valid JavaScript", () => {
  const root = fileURLToPath(new URL("./", import.meta.url));
  for (const [file, name, factory] of [
    ["run-installed-native-turn.mts", "probeSource", probeSource],
    ["run-installed-native-web-ui.mts", "gatewaySource", gatewaySource],
  ] as const) {
    const source = renderFactory(root, file, name);
    assert.equal(source, factory());
    const parsed = spawnSync(process.execPath, ["--check", "--input-type=module"], {
      input: source,
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.equal(parsed.status, 0, parsed.stderr);
  }
});

function heldHermesRuntime(agent: "hermes" | "openclaw" = "hermes") {
  const install = "C:\\Program Files\\NVIDIA\\NemoClaw";
  const runtimeId = "a".repeat(64);
  return {
    ...validateNativeRuntimeReceipt(
      {
        schemaVersion: 1,
        kind: "native-runtime-session",
        agent,
        runtimeRoot: path.win32.join(install, "runtimes", runtimeId),
        runtimeId,
        manifestSha256: "b".repeat(64),
        sourceRevision: "c".repeat(40),
        nodeSha256: "d".repeat(64),
        nodeVersion: "22.23.2",
        integrity: "installer-sealed-content",
        leaseHeld: true,
      },
      install,
      agent,
    ),
    assertHeld() {},
  };
}

test("Hermes compatibility paths and prebuilt command bind the live sealed lease", () => {
  const runtime = heldHermesRuntime();
  const compatibility = nativeHermesCompatibility(runtime);
  const root = path.win32.join(runtime.agentRoot!, "mxc-compat");
  assert.deepEqual(compatibility, {
    installation: "C:\\Program Files\\NVIDIA\\NemoClaw",
    root,
    launcher: path.win32.join(root, "NemoClawMsysLauncher.exe"),
    arm64Dll: path.win32.join(root, "NemoClawMsysCompat-arm64.dll"),
    x64Dll: path.win32.join(root, "NemoClawMsysCompat-x64.dll"),
    executor: path.win32.join(root, "wxc-exec.exe"),
  });
  const worker = path.win32.join(runtime.runtimeRoot, "workers", "native-runtime.cjs");
  assert.deepEqual(nativeRuntimeWorkerCommand(runtime, worker), [
    compatibility.launcher,
    "--",
    runtime.node,
    "--preserve-symlinks-main",
    worker,
  ]);
  for (const changed of [
    { ...runtime, agentRoot: root },
    { ...runtime, runtimeId: "f".repeat(64) },
  ])
    assert.throws(() => nativeHermesCompatibility(changed), /held runtime lease/u);
  assert.throws(
    () => nativeRuntimeWorkerCommand(runtime, "C:\\outside\\worker.cjs"),
    /sealed runtime/u,
  );
  runtime.assertHeld = () => {
    throw new Error("lease revoked");
  };
  assert.throws(() => nativeHermesCompatibility(runtime), /lease revoked/u);
  assert.throws(() => nativeRuntimeWorkerCommand(runtime, worker), /lease revoked/u);
});

test("sealed Node workers avoid main-entry parent traversal without changing dependency resolution", () => {
  const runtime = heldHermesRuntime("openclaw");
  const worker = path.win32.join(runtime.runtimeRoot, "workers", "native-runtime.cjs");
  assert.deepEqual(nativeRuntimeWorkerCommand(runtime, worker), [
    runtime.node,
    "--preserve-symlinks-main",
    worker,
  ]);
  assert.deepEqual(nativeRuntimeWorkerCommand({ ...runtime, purpose: "openclaw" }, worker), [
    runtime.node,
    "--preserve-symlinks-main",
    worker,
  ]);
  for (const purpose of ["inference"] as const)
    assert.deepEqual(nativeRuntimeWorkerCommand({ ...runtime, purpose }, worker), [
      runtime.node,
      worker,
    ]);
  const webUi = fs.readFileSync(
    new URL("./run-installed-native-web-ui.mts", import.meta.url),
    "utf8",
  );
  const turn = fs.readFileSync(new URL("./run-installed-native-turn.mts", import.meta.url), "utf8");
  assert(webUi.includes("command: nativeRuntimeWorkerCommand(runtimeLease, gatewayScript)"));
  assert(turn.includes("command: nativeRuntimeWorkerCommand(runtimeLease, probePath)"));
  runtime.assertHeld = () => {
    throw new Error("lease revoked");
  };
  assert.throws(() => nativeRuntimeWorkerCommand(runtime, worker), /lease revoked/u);
});

test("actual gateway renderer selects only the held Hermes executor and preserves other TOML", () => {
  const installation = "C:\\Program Files\\NVIDIA\\NemoClaw";
  const template =
    "# retained\r\n[openshell.drivers.mxc]\r\nwxc_exec_path = 'stock.exe' # retained path comment\r\nother = true\r\n[other]\r\nwxc_exec_path = 'unrelated.exe'\r\n";
  const runtime = heldHermesRuntime();
  const executor = nativeHermesCompatibility(runtime).executor;
  const profiled = template.replace(
    "other = true",
    "pc_network_allow = false\r\npc_allow_local_network = false\r\npc_host_console = false\r\npc_loopback_ports = []\r\nother = true",
  );
  const expected = profiled.replace("'stock.exe'", JSON.stringify(executor));
  assert.equal(renderNativeGatewayConfig(template, installation, runtime), expected);
  assert.equal(JSON.parse(expected.split("\r\n")[2].split(" = ")[1].split(" #")[0]), executor);
  assert.equal(
    renderNativeGatewayConfig(template, installation),
    profiled.replace("'stock.exe'", JSON.stringify(path.join(installation, "mxc", "wxc-exec.exe"))),
  );
  assert.throws(
    () => renderNativeGatewayConfig(template, "D:\\Other", runtime),
    /different installations/u,
  );
  assert.throws(
    () => renderNativeGatewayConfig(template, installation, heldHermesRuntime("openclaw")),
    /held runtime lease/u,
  );
  runtime.assertHeld = () => {
    throw new Error("lease revoked");
  };
  assert.throws(() => renderNativeGatewayConfig(template, installation, runtime), /lease revoked/u);
});

test("actual console and turn driver configs prefix Hermes only and retain their worker environment", async () => {
  for (const file of [
    "run-installed-native-console-agent.mts",
    "run-installed-native-hermes-turn.mts",
  ]) {
    const source = fs.readFileSync(new URL(file, import.meta.url), "utf8");
    const start = source.indexOf("const createArgs = [");
    const end = source.indexOf("console.log(", start);
    assert(start >= 0 && end > start);
    for (const agent of ["hermes"] as const) {
      const runtime = heldHermesRuntime(agent);
      const workload = path.win32.join(runtime.runtimeRoot, "workers", "native-runtime.cjs");
      const environment =
        agent === "hermes"
          ? nativeHermesToolEnvironment(runtime, "C:\\Windows").environment
          : { PATH: "unchanged-non-hermes-path" };
      const context: any = {
        runtimeLease: runtime,
        nativeRuntimeWorkerCommand,
        node: runtime.node,
        workload,
        sandboxName: "existing-sandbox-name",
        policyPath: "existing-policy",
        agentRuntimeRoot: "held-state-root",
        shareRoot: "existing-turn-share",
        dashboard: false,
        environment,
        sandboxEnvironment: environment,
        gatewaySession: { kind: "owned-session-fixture" },
      };
      runInNewContext(source.slice(start, end) + "\nresult = createArgs;", context);
      const args = context.result as string[];
      if (file.includes("console")) {
        assert(args.includes("--detach"));
        assert(args.includes("--tty"));
        assert(!args.includes("--no-tty"));
      }
      const driver = JSON.parse(args[args.indexOf("--driver-config-json") + 1]).mxc;
      assert.deepEqual(driver.command, nativeRuntimeWorkerCommand(runtime, workload));
      assert.equal(
        driver.cwd,
        file.includes("console") ? "held-state-root" : "existing-turn-share",
      );
      assert.deepEqual(Object.keys(driver).sort(), ["command", "cwd"]);
      const passedEnvironment = Object.fromEntries(
        args.flatMap((value, i) =>
          value === "--env" ? [args[i + 1].split(/=(.*)/su).slice(0, 2)] : [],
        ),
      );
      assert.deepEqual(passedEnvironment, environment);
      assert(!Object.hasOwn(passedEnvironment, "GITHUB_ACTIONS"));
      assert(!Object.hasOwn(passedEnvironment, "NEMOCLAW_MSYS_TOKEN_INSPECTION_HOLD"));
      const gatewayCall =
        /const gatewayConfig = await writeNativeGatewayConfig\([\s\S]*?\n    \);/u.exec(source);
      assert(gatewayCall, "The launcher must configure its private gateway before launch.");
      for (const dashboard of [false, true]) {
        if (file.includes("console")) {
          const selected = { ...context, dashboard };
          runInNewContext(source.slice(start, end) + "\nresult = createArgs;", selected);
          assert.equal(selected.result.includes("--tty"), !dashboard);
          assert.equal(selected.result.includes("--no-tty"), dashboard);
        }
        let rendered = "";
        await runInNewContext(`(async () => { ${gatewayCall[0]} })()`, {
          ...context,
          dashboard,
          agentId: agent,
          isHermes: agent === "hermes",
          installRoot: "C:\\Program Files\\NVIDIA\\NemoClaw",
          runRoot: "owned-run-root",
          writeNativeGatewayConfig: async (install, _run, lease, options, session) => {
            assert.equal(session, context.gatewaySession);
            rendered = renderNativeGatewayConfig(
              '[openshell.drivers.mxc]\nwxc_exec_path = "old.exe"\n',
              install,
              lease,
              options,
            );
            return "owned-gateway-config";
          },
        });
        const console = file.includes("console");
        assert(rendered.includes("pc_host_console = false\n"));
        assert(rendered.includes(`pc_network_allow = ${console}\n`));
        assert(rendered.includes(`pc_allow_local_network = ${console}\n`));
        assert(rendered.includes("pc_loopback_ports = []\n"));
        if (agent === "hermes") assert(rendered.includes("mxc-compat"));
        else assert(!rendered.includes("mxc-compat"));
      }
      assert.equal(runtime.runtimeBytesCopied, 0);
      assert.equal(runtime.runtimeFilesHashedAtLaunch, 0);
    }
  }
});

test("every native Node workload emits portable UI policy without widening filesystem grants", () => {
  for (const file of [
    "run-installed-native-turn.mts",
    "run-installed-native-web-ui.mts",
    "run-installed-native-hermes-turn.mts",
    "run-installed-native-console-agent.mts",
    "../performance/probe-installed-readonly.mts",
    "../hermes/probe-official-components.mts",
  ]) {
    const source = fs.readFileSync(new URL(file, import.meta.url), "utf8");
    const policy =
      /fs\.writeFileSync\(\s*policyPath,\s*(\[[\s\S]*?\])\.join\("\\n"\),(?:\s*"utf8",?)?\s*\);/u.exec(
        source,
      );
    assert(policy, file);
    const roots = {
      runtimeRoot: "C:/runtime",
      shareRoot: "C:/share",
      relayRoot: "C:/relay",
      brokerRelayRoot: "C:/broker",
      agentRuntimeRoot: "C:/agent",
      statusRoot: "C:/status",
      browserRelayRoot: "C:/browser",
      installRoot: "C:/install",
      runRoot: "C:/run",
      node: "C:/node.exe",
      launcherRoot: "C:/launcher",
      home: "C:/home",
    };
    const quoteYamlPath = (value) => JSON.stringify(value);
    const context = {
      ...roots,
      path,
      NATIVE_NODE_UI_POLICY,
      security: { NATIVE_NODE_UI_POLICY },
      quoteYamlPath,
      helpers: { quoteYamlPath },
      runtimeLease: { readOnlyRoots: ["C:/sealed"] },
      configuredIdentity: null,
      brokerRelay: null,
      dashboard: false,
    };
    const document = parseYaml(runInNewContext(`${policy[1]}.join("\\n")`, context));
    assert.deepEqual(
      document.ui,
      { allow_graphical_ui: true, clipboard: "none", allow_input_injection: false },
      file,
    );
    assert.equal(document.filesystem_policy.include_workdir, false, file);
    const expectedReadOnly = file.includes("performance")
      ? [roots.node, path.join(roots.installRoot, "openclaw"), roots.runRoot]
      : file.includes("probe-official")
        ? [roots.runtimeRoot, roots.launcherRoot]
        : [roots.runtimeRoot, "C:/sealed"];
    const expectedReadWrite = file.includes("console-agent")
      ? [roots.agentRuntimeRoot, roots.statusRoot, roots.brokerRelayRoot, roots.browserRelayRoot]
      : file.includes("web-ui")
        ? [roots.shareRoot, roots.relayRoot]
        : [roots.shareRoot];
    assert.deepEqual(document.filesystem_policy.read_only, expectedReadOnly, file);
    assert.deepEqual(document.filesystem_policy.read_write, expectedReadWrite, file);
    assert(!Object.hasOwn(document, "network_policies"), file);
  }
});

test("installed Hermes query modes bind both held owners and remain host or guest scoped", async () => {
  const source = fs.readFileSync(
    new URL("./run-installed-native-console-agent.mts", import.meta.url),
    "utf8",
  );
  const gatewayStart = source.indexOf(
    "stateSession.assertHeld();\n    await gatewaySession.prepare();",
  );
  const gatewayEnd = source.indexOf('    diagnostics.stage("gateway");', gatewayStart);
  const guestStart = source.indexOf("const environment = {");
  const guestEnd = source.indexOf("      diagnostics.secret(", guestStart);
  const cliStart = source.indexOf("      cliEnvironment = allowlistedWindowsEnvironment({");
  const cliEnd = source.indexOf("      await run(", cliStart);
  assert(
    gatewayStart >= 0 && gatewayEnd > gatewayStart && guestStart >= 0 && guestEnd > guestStart,
  );
  for (const agentId of ["hermes"] as const) {
    const runtimeLease = heldHermesRuntime(agentId);
    const agentRuntimeRoot = "C:\\NemoClawState-S-1-5-21-1-2-3-1001-hermes";
    let stateHeld = true;
    let prepared = 0;
    const gatewayEnvironment = {
      OPENSHELL_LOCAL_TLS_DIR: "private-gateway/tls",
      XDG_CONFIG_HOME: "private-gateway/config",
      XDG_STATE_HOME: "private-gateway/state",
    };
    const stateSession = bindNativeRuntimeGuard(
      {
        assertHeld() {
          if (!stateHeld) throw new Error("state revoked");
        },
      },
      runtimeLease as any,
    );
    const context: any = {
      agentId,
      stateSession,
      gatewaySession: {
        async prepare() {
          prepared++;
        },
        get environment() {
          assert.equal(prepared, 1);
          return gatewayEnvironment;
        },
      },
      runtimeLease,
      path: path.win32,
      allowlistedWindowsEnvironment: (extra: object) => ({ ...extra }),
      gatewayConfig: "session-gateway.toml",
      configRoot: "session-config",
      gatewayState: "session-state",
      worker: { environment: { NEMOCLAW_WORKER_MODE: "interactive" } },
      agentRuntimeRoot,
      runId: "fixture",
      bootstrapPath: "bootstrap",
      statusRoot: "status",
      brokerRelayRoot: "broker",
      brokerRelayToken: "fixture",
      dashboard: false,
      consoleQualification: false,
      brokerToken: "fixture",
      exitReceipt: "exit",
      config: { model: "fixture" },
      node: runtimeLease.node,
      broker: { port: 1234 },
      edge: null,
      browserRelayRoot: undefined,
      browserRelayToken: undefined,
      runtime: runtimeLease.agentRoot,
      process: { env: {} },
      hermesTools:
        agentId === "hermes" ? nativeHermesToolEnvironment(runtimeLease, "C:\\Windows") : null,
      systemRoot: "C:\\Windows",
      systemDrive: "C:",
      temp: path.win32.join(agentRuntimeRoot, "temp"),
    };
    const gateway = `(async () => { ${source.slice(gatewayStart, gatewayEnd)}\nresult = gatewayEnvironment; })()`;
    await runInNewContext(gateway, context);
    assert.equal(prepared, 1);
    for (const [name, value] of Object.entries(gatewayEnvironment))
      assert.equal(context.result[name], value);
    assert.equal(
      context.result.NEMOCLAW_MSYS_TOKEN_INSPECTION,
      agentId === "hermes" ? "hermes-query" : undefined,
    );
    assert.equal(context.result.GITHUB_ACTIONS, undefined);
    assert.equal(
      context.result.NEMOCLAW_HERMES_PRIVATE_DESKTOP,
      agentId === "hermes" ? "1" : undefined,
    );
    context.gatewayEnvironment = context.result;
    runInNewContext(source.slice(cliStart, cliEnd), context);
    assert.equal(context.cliEnvironment.NEMOCLAW_MSYS_TOKEN_INSPECTION, undefined);
    assert.equal(context.cliEnvironment.NEMOCLAW_HERMES_PRIVATE_DESKTOP, undefined);
    runInNewContext(source.slice(guestStart, guestEnd) + "\nresult = environment;", context);
    assert.equal(context.result.NEMOCLAW_AGENT_HOME, agentRuntimeRoot);
    assert.equal(
      context.result.NEMOCLAW_MSYS_TOKEN_INSPECTION_HOLD,
      agentId === "hermes" ? "hermes-query" : undefined,
    );
    assert.equal(context.result.NEMOCLAW_MSYS_DIAGNOSTICS, agentId === "hermes" ? "0" : undefined);
    assert.equal(context.result.NEMOCLAW_MSYS_TOKEN_INSPECTION, undefined);
    assert.equal(context.result.NEMOCLAW_HERMES_PRIVATE_DESKTOP, undefined);
    assert.equal(context.result.GITHUB_ACTIONS, undefined);
    stateHeld = false;
    await assert.rejects(runInNewContext(gateway, { ...context }), /state revoked/u);
    assert.equal(prepared, 1, "Revoked state must fail before private credential preparation.");
    stateHeld = true;
    runtimeLease.assertHeld = () => {
      throw new Error("runtime revoked");
    };
    await assert.rejects(runInNewContext(gateway, { ...context }), /runtime revoked/u);
    assert.equal(prepared, 1, "Revoked runtime must fail before private credential preparation.");
  }
});

test("Hermes tools use only their held canonical runtime and Windows OS paths", () => {
  const runtime = heldHermesRuntime();
  let held = 0;
  runtime.assertHeld = () => {
    held += 1;
  };
  const tools = nativeHermesToolEnvironment(runtime, "C:\\Windows");
  const root = runtime.agentRoot!;
  assert.equal(held, 1);
  assert.equal(tools.python, runtime.python);
  assert.equal(tools.bash, runtime.bash);
  assert.equal(tools.node, runtime.node);
  assert.equal(tools.ripgrep, path.win32.join(root, "ripgrep", "rg.exe"));
  assert.deepEqual(tools.environment.PATH.split(";"), [
    path.win32.join(root, "bin"),
    path.win32.dirname(runtime.node),
    path.win32.join(root, "hermes-agent", "venv", "Scripts"),
    path.win32.join(root, "ripgrep"),
    path.win32.join(root, "git", "bin"),
    path.win32.join(root, "git", "usr", "bin"),
    path.win32.join(root, "git", "cmd"),
    "C:\\Windows\\System32",
    "C:\\Windows",
  ]);
  assert.equal(tools.environment.HERMES_NODE, tools.node);
  assert.equal(tools.environment.HERMES_PYTHON, tools.python);
  assert.equal(tools.environment.HERMES_GIT_BASH_PATH, tools.bash);
  assert.equal(tools.environment.HERMES_DISABLE_LAZY_INSTALLS, "1");
  assert.equal(tools.environment.UV_OFFLINE, "1");
  assert.equal(tools.environment.PIP_NO_INDEX, "1");
  assert.equal(runtime.runtimeBytesCopied, 0);
});

test("Hermes tool environment refuses a closed lease, another agent or substituted executables", () => {
  const runtime = heldHermesRuntime();
  assert.throws(
    () =>
      nativeHermesToolEnvironment(
        {
          ...runtime,
          assertHeld() {
            throw new Error("lease closed");
          },
        },
        "C:\\Windows",
      ),
    /lease closed/u,
  );
  assert.throws(
    () => nativeHermesToolEnvironment({ ...runtime, purpose: "pi" }, "C:\\Windows"),
    /held runtime identity/u,
  );
  assert.throws(
    () =>
      nativeHermesToolEnvironment(
        { ...runtime, bash: "C:\\Windows\\System32\\bash.exe" },
        "C:\\Windows",
      ),
    /differs from its runtime lease/u,
  );
  assert.throws(
    () =>
      nativeHermesToolEnvironment(
        { ...runtime, python: "C:\\HostPython\\python.exe" },
        "C:\\Windows",
      ),
    /differs from its runtime lease/u,
  );
  assert.throws(
    () => nativeHermesToolEnvironment(runtime, "C:\\Windows;C:\\Host"),
    /held runtime identity/u,
  );
});

test("prebuilt Hermes worker keeps canonical Node instead of overwriting it with shared worker Node", () => {
  const source = renderFactory(
    fileURLToPath(new URL("./", import.meta.url)),
    "run-installed-native-console-agent.mts",
    "interactiveWorkloadSource",
  );
  const assets = new Map<string, string>();
  const bundledSource = staticWorkerSource("interactive", source, assets);
  assert(!bundledSource.includes("writeFileSync(runner"));
  assert(
    bundledSource.includes('nativeGuestAsset((dashboard ? "hermes-dashboard" : "hermes-console")'),
  );
  assert.deepEqual([...assets.keys()].filter((name) => name.startsWith("hermes-")).sort(), [
    "hermes-console-probe.py",
    "hermes-console.py",
    "hermes-dashboard-probe.py",
    "hermes-dashboard.py",
  ]);
  assert(assets.get("hermes-dashboard.py")!.includes("--skip-build"));
  assert(assets.get("hermes-console.py")!.includes("from hermes_cli.main import main"));
  const start = source.indexOf("extraEnvironment = { HERMES_HOME: hermesHome");
  const end = source.indexOf(
    '} else {\n  throw new Error("unsupported native terminal agent "',
    start,
  );
  assert(start >= 0 && end > start);
  const tools = nativeHermesToolEnvironment(heldHermesRuntime(), "C:\\Windows");
  const context: any = {
    extraEnvironment: undefined,
    hermesHome: "C:\\state\\.hermes",
    python: tools.python,
    node: "C:\\shared-worker\\node.exe",
    dashboard: false,
    process: { env: {} },
    required(name: string) {
      assert.equal(name, "HERMES_NODE");
      return tools.node;
    },
  };
  runInNewContext(source.slice(start, end), context);
  assert.equal(context.extraEnvironment.HERMES_NODE, tools.node);
  assert.equal(context.extraEnvironment.HERMES_PYTHON, tools.python);
  context.required = () => {
    throw new Error("canonical Node missing");
  };
  assert.throws(
    () => runInNewContext(source.slice(start, end), context),
    /canonical Node missing/u,
  );
});

test("the generated dashboard preserves the required canonical Hermes Node environment", () => {
  const python = hermesDashboardPythonSource();
  const nodeLines = python.filter((line) => line.includes("HERMES_NODE"));
  assert.equal(nodeLines.length, 1);
  assert.match(nodeLines[0], /^if not os\.environ\.get\('HERMES_NODE'\): raise RuntimeError/u);
  assert(!python.some((line) => line.includes("NEMOCLAW_AGENT_NODE")));
  const worker = interactiveWorkloadSource();
  assert(worker.includes(JSON.stringify(nodeLines[0])));
  const tools = nativeHermesToolEnvironment(heldHermesRuntime(), "C:\\Windows");
  assert.equal(tools.environment.HERMES_NODE, tools.node);
  assert.equal(tools.node, heldHermesRuntime().node);
});

test("Hermes turn-only worker also preserves the held canonical tool environment", () => {
  const owner = fs.readFileSync(
    new URL("./run-installed-native-hermes-turn.mts", import.meta.url),
    "utf8",
  );
  const functionStart = owner.indexOf("function hermesWorkloadSource() {");
  const functionEnd = owner.indexOf("async function mainInternal(", functionStart);
  assert(functionStart >= 0 && functionEnd > functionStart);
  const source = runInNewContext(
    owner.slice(functionStart, functionEnd) + "\nhermesWorkloadSource()",
  ) as string;
  const start = source.indexOf("    env: {");
  const end = source.indexOf('    stdio: ["ignore", "pipe", "pipe"]', start);
  assert(start >= 0 && end > start);
  const tools = nativeHermesToolEnvironment(heldHermesRuntime(), "C:\\Windows");
  const context: any = {
    process: {
      env: tools.environment,
      execPath: "C:\\shared-worker\\node.exe",
    },
    hermesHome: "C:\\state\\.hermes",
    home: "C:\\state",
    python: tools.python,
    required: () => tools.node,
  };
  const evaluate = "result = ({" + source.slice(start, end) + "}).env";
  runInNewContext(evaluate, context);
  assert.equal(context.result.HERMES_NODE, tools.node);
  assert.equal(context.result.HERMES_GIT_BASH_PATH, tools.bash);
  assert.equal(context.result.PATH, tools.environment.PATH);
});

const configuration = {
  schemaVersion: 1,
  classification: "nemoclaw-native-windows-agent-configuration",
  agent: "hermes",
  inference: "nvidia",
  endpoint: "https://integrate.api.nvidia.com/v1",
  model: "test-model",
  credentialStored: true,
  profile: "personal",
  options: {
    search: { provider: "tavily", credentialStored: true },
    messaging: {
      telegram: { credentialStored: true, allowedUsers: ["123456"] },
    },
  },
};

async function prepare(value: unknown, args = ["--prepare-all"]): Promise<string> {
  let result = "";
  await configureNativeFromStdin(
    "nonexistent-credential-helper",
    args,
    Readable.from([Buffer.from(JSON.stringify(value))]),
    {
      write: ((chunk: string | Uint8Array) => {
        result += chunk.toString();
        return true;
      }) as NodeJS.WriteStream["write"],
    },
  );
  return result;
}

test("one metadata-only call returns all selected existing credential identities", async () => {
  assert.deepEqual(JSON.parse(await prepare(configuration)), {
    schemaVersion: 1,
    inference: nativeCredentialBinding(configuration),
    services: {
      tavily: nativeServiceBinding("hermes", "tavily"),
      telegram: nativeServiceBinding("hermes", "telegram"),
    },
  });
  assert.equal(await prepare(configuration, ["--prepare"]), nativeCredentialBinding(configuration));
});

test("invalid or missing credentials fail before emitting a preparation result", async () => {
  await assert.rejects(
    prepare({ ...configuration, credentialStored: false }),
    /requires a credential/u,
  );
  await assert.rejects(
    prepare({
      ...configuration,
      options: { search: { provider: "brave", credentialStored: true } },
    }),
    /does not support/u,
  );
  await assert.rejects(
    prepare({
      ...configuration,
      options: {
        messaging: {
          telegram: { credentialStored: true, allowedUsers: ["invalid"] },
        },
      },
    }),
    /valid messaging/u,
  );
});

test("custom provider bindings retain the broker endpoint security boundary", async () => {
  await assert.rejects(
    prepare({
      ...configuration,
      inference: "compatible",
      endpoint: "https://user:password@example.invalid/v1",
    }),
    /endpoint violates/u,
  );
  const local = {
    ...configuration,
    inference: "local",
    endpoint: "http://127.0.0.1:12345/v1",
    credentialStored: false,
    options: {},
  };
  assert.deepEqual(JSON.parse(await prepare(local)), {
    schemaVersion: 1,
    inference: nativeCredentialBinding(local),
    services: {},
  });
});

test("metadata input is bounded before parsing or credential access", async () => {
  await assert.rejects(prepare({ ...configuration, model: "x".repeat(17 * 1024) }), /size limit/u);
});

test("configuration waits for combined configuration and agent ownership before any mutation", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-configuration-lease-"));
  const previousLocalAppData = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = root;
  const configPath = path.join(
    root,
    "NVIDIA",
    "NemoClaw",
    "agents",
    "hermes",
    "native-windows.json",
  );
  const activePath = path.join(root, "NVIDIA", "NemoClaw", "active-agent.txt");
  let admit!: () => void;
  const admitted = new Promise<void>((resolve) => {
    admit = resolve;
  });
  let acquisitionStarted!: () => void;
  const acquiring = new Promise<void>((resolve) => {
    acquisitionStarted = resolve;
  });
  const events: string[] = [];
  try {
    const pending = configureNativeFromStdin(
      "unused",
      [],
      Readable.from([
        Buffer.from(
          JSON.stringify({
            ...configuration,
            inference: "compatible",
            endpoint: "https://example.invalid/v1",
            credentialStored: false,
            options: {},
          }),
        ),
      ]),
      process.stdout,
      {
        acquireState: async () => {
          events.push("acquire");
          acquisitionStarted();
          await admitted;
          return {
            stateRoot: "C:\\NemoClawState-S-1-5-21-1-hermes",
            created: false,
            removed: false,
            assertHeld() {
              events.push("held");
            },
            async release() {
              events.push("release");
            },
          };
        },
        readCredential: async () => {
          events.push("credential");
          return "";
        },
        readServices: async () => {
          events.push("services");
          return { options: {}, environment: {} };
        },
        deleteCredential: async () => {
          events.push("delete");
        },
      },
    );
    await acquiring;
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(events, ["acquire"]);
    assert.equal(fs.existsSync(configPath), false);
    assert.equal(fs.existsSync(activePath), false);
    admit();
    await pending;
    assert.equal(JSON.parse(fs.readFileSync(configPath, "utf8")).agent, "hermes");
    assert.equal(fs.readFileSync(activePath, "utf8"), "hermes\n");
    assert.equal(events.at(-1), "release");
    assert(events.indexOf("credential") > events.indexOf("held"));
  } finally {
    if (previousLocalAppData === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = previousLocalAppData;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("configuration requires the shared-owner protocol, not an ordinary session receipt", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-configuration-protocol-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const mock = path.join(root, "process-boundary.mjs");
  fs.writeFileSync(
    mock,
    `
    import {EventEmitter} from 'node:events';
    import {PassThrough} from 'node:stream';
    export const calls = [];
    let override;
    let shared = false;
    const agents = new Set();
    export function setReceiptKind(value) { override = value; }
    export function spawn(launcher, args) {
      calls.push({launcher, args});
      const child = new EventEmitter();
      child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.kill = () => child.emit('close', 1);
      const mode = args[0] === '--state-configure' ? 'configuration' : args[0].slice('--state-'.length);
      const ownsShared = mode !== 'session';
      if (agents.has(args[1]) || (ownsShared && shared)) {
        queueMicrotask(() => child.emit('close', 2));
        return child;
      }
      if (ownsShared) shared = true;
      agents.add(args[1]);
      child.stdin.on('finish', () => {
        if (ownsShared) shared = false;
        agents.delete(args[1]);
        child.emit('close', 0);
      });
      queueMicrotask(() => child.stdout.write(JSON.stringify({schemaVersion:1,
        kind:override ?? 'native-state-' + mode, agent:args[1],
        stateRoot:'C:\\\\NemoClawState-S-1-5-21-1-' + args[1],
        created:false, removed:true, leaseHeld:true}) + '\\n'));
      return child;
    }
  `,
  );
  const output = path.join(root, "state-protocol.mjs");
  const stateSource = fileURLToPath(new URL("./native-state.mts", import.meta.url));
  const setupSource = fileURLToPath(new URL("./native-setup-configuration.mts", import.meta.url));
  const removalSource = fileURLToPath(new URL("./native-remove-data.mts", import.meta.url));
  const { build } = await import("esbuild");
  await build({
    stdin: {
      contents: `export * from ${JSON.stringify(stateSource)};
      export {configureNativeFromStdin} from ${JSON.stringify(setupSource)};
      export {removeNativeAgentData} from ${JSON.stringify(removalSource)};
      export {calls,setReceiptKind} from ${JSON.stringify(mock)};`,
      resolveDir: root,
    },
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: output,
    plugins: [
      {
        name: "owned-process-fixture",
        setup(builder) {
          builder.onResolve({ filter: /^node:child_process$/ }, () => ({ path: mock }));
        },
      },
    ],
  });
  const owner = await import(pathToFileURL(output).href);
  for (const [operation, command] of [
    [owner.acquireNativeStateConfiguration, "--state-configure"],
    [owner.acquireNativeStateSession, "--state-session"],
    [owner.acquireNativeStateRemoval, "--state-remove"],
  ] as const) {
    const lease = await operation("owned-launcher", "hermes");
    assert.deepEqual(owner.calls.at(-1), { launcher: "owned-launcher", args: [command, "hermes"] });
    lease.assertHeld();
    await lease.release();
    assert.throws(() => lease.assertHeld(), /lease is closed/u);
  }
  owner.setReceiptKind("native-state-session");
  await assert.rejects(
    owner.acquireNativeStateConfiguration("owned-launcher", "hermes"),
    /receipt is invalid/u,
  );
  const calls = owner.calls.length;
  await assert.rejects(
    owner.acquireNativeStateConfiguration("owned-launcher", "pi"),
    /supported native agent/u,
  );
  assert.equal(owner.calls.length, calls);
  owner.setReceiptKind(undefined);
  const previous = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = process.platform === "win32" ? root : `/${root}`;
  try {
    // Exercise the default setup owner, not the injected acquireState test seam.
    const configureHermes = () =>
      owner.configureNativeFromStdin(
        "owned-launcher",
        [],
        Readable.from([
          Buffer.from(
            JSON.stringify({
              ...configuration,
              inference: "compatible",
              endpoint: "https://example.invalid/v1",
              credentialStored: false,
              options: {},
            }),
          ),
        ]),
        process.stdout,
        {
          readCredential: async () => "",
          readServices: async () => ({ options: {}, environment: {} }),
          deleteCredential: async () => {},
        },
      );
    await configureHermes();
    assert.deepEqual(owner.calls.at(-1).args, ["--state-configure", "hermes"]);
    assert.equal(
      fs.readFileSync(path.join(root, "NVIDIA", "NemoClaw", "active-agent.txt"), "utf8"),
      "hermes\n",
    );
    const openclaw = path.join(root, "NVIDIA", "NemoClaw", "agents", "openclaw");
    fs.mkdirSync(openclaw);
    fs.writeFileSync(
      path.join(openclaw, "native-windows.json"),
      JSON.stringify({
        ...configuration,
        agent: "openclaw",
        inference: "compatible",
        endpoint: "https://example.invalid/v1",
        credentialStored: false,
        options: {},
      }),
    );
    const activePath = path.join(root, "NVIDIA", "NemoClaw", "active-agent.txt");
    fs.writeFileSync(activePath, "openclaw\n");
    let pause!: () => void;
    let resume!: () => void;
    const paused = new Promise<void>((resolve) => {
      pause = resolve;
    });
    const resumed = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const removal = owner.removeNativeAgentData("owned-launcher", "openclaw", {
      deleteCredential: async () => {
        pause();
        await resumed;
      },
    });
    try {
      await paused;
      await assert.rejects(configureHermes(), /already in use/u);
      assert.equal(fs.readFileSync(activePath, "utf8"), "openclaw\n");
    } finally {
      resume();
      await removal;
    }
    assert.equal(fs.existsSync(activePath), false);
    await configureHermes();
    assert.equal(fs.readFileSync(activePath, "utf8"), "hermes\n");
    // Repeated OpenClaw removal must preserve the later Hermes selection and settings.
    await owner.removeNativeAgentData("owned-launcher", "openclaw", {
      deleteCredential: async () => {},
    });
    assert.equal(fs.readFileSync(activePath, "utf8"), "hermes\n");
    assert.equal(
      JSON.parse(
        fs.readFileSync(
          path.join(root, "NVIDIA", "NemoClaw", "agents", "hermes", "native-windows.json"),
          "utf8",
        ),
      ).agent,
      "hermes",
    );
  } finally {
    if (previous === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = previous;
  }
});

test("logical prebuilt model preparation emits no endpoint or external credential binding", async () => {
  const local = {
    ...configuration,
    inference: "local",
    endpoint: undefined,
    model: NATIVE_EXPRESS.model,
    credentialStored: false,
    localModel: NATIVE_EXPRESS.id,
    options: {},
  };
  const metadata = {
    schemaVersion: 1,
    id: NATIVE_EXPRESS.id,
    model: NATIVE_EXPRESS.model,
    modelRevision: NATIVE_EXPRESS.modelRevision,
    weightsSha256: NATIVE_EXPRESS.weights.sha256,
    weightsBytes: NATIVE_EXPRESS.weights.bytes,
    packSha256: "a".repeat(64),
    runtimeId: "b".repeat(64),
    runtimeManifestSha256: "c".repeat(64),
    sourceRevision: "d".repeat(40),
    availability: "prebuilt" as const,
    modelBytesRead: 0 as const,
  };
  let inspections = 0;
  let text = "";
  await configureNativeFromStdin(
    "unused-native-credential-helper",
    ["--prepare-all"],
    Readable.from([Buffer.from(JSON.stringify(local))]),
    {
      write: ((chunk: string) => {
        text += chunk;
        return true;
      }) as NodeJS.WriteStream["write"],
    },
    {
      inspectModel: async () => {
        inspections++;
        return metadata;
      },
    },
  );
  assert.equal(inspections, 1);
  assert.deepEqual(JSON.parse(text), {
    schemaVersion: 1,
    inference: null,
    localModel: metadata,
    services: {},
  });
  assert.equal(text.includes("endpoint"), false);
});

test("a local-model endpoint placeholder is rejected before inspecting a pack", async () => {
  let called = false;
  await assert.rejects(
    configureNativeFromStdin(
      "unused",
      ["--prepare-all"],
      Readable.from([
        Buffer.from(
          JSON.stringify({
            ...configuration,
            inference: "local",
            endpoint: "http://127.0.0.1:1",
            model: NATIVE_EXPRESS.model,
            credentialStored: false,
            localModel: NATIVE_EXPRESS.id,
            options: {},
          }),
        ),
      ]),
      process.stdout,
      {
        inspectModel: async () => {
          called = true;
          throw new Error("must not inspect");
        },
      },
    ),
    /configuration is invalid/u,
  );
  assert.equal(called, false);
});

function writeGeneratedHermesConfiguration(home: string, options: NativeOptions) {
  // Execute only the actual prebuilt worker's configuration writer. No worker
  // startup, interpreter, credentials, provider, or network operation is run.
  const source = interactiveWorkloadSource();
  const declaration = source.indexOf("const nativeHermesConfiguration = ");
  const declarationEnd = source.indexOf("\n\nconst required = ", declaration);
  const writer = source.indexOf('writeFileSync(join(hermesHome, "config.yaml"),');
  const writerEnd = source.indexOf("  const runner = ", writer);
  assert(declaration >= 0 && declarationEnd > declaration && writer >= 0 && writerEnd > writer);
  runInNewContext(
    source.slice(declaration, declarationEnd) + "\n" + source.slice(writer, writerEnd),
    {
      writeFileSync: fs.writeFileSync,
      join: path.join,
      hermesHome: home,
      model: "test-model",
      baseUrl: "http://127.0.0.1:1/v1",
      brokerToken: "",
      nativeServices: { options },
    },
  );
  return parseYaml(fs.readFileSync(path.join(home, "config.yaml"), "utf8"));
}

test("Hermes starts a distinct authenticated Edge CDP tunnel before Python", () => {
  const source = interactiveWorkloadSource();
  const browserTunnel = source.indexOf('required("NEMOCLAW_BROWSER_RELAY_ROOT")');
  const endpoint = source.indexOf("process.env.BROWSER_CDP_URL =");
  const hermes = source.indexOf('if (agent === "hermes") {', endpoint);
  assert(browserTunnel > 0 && endpoint > browserTunnel);
  assert(hermes > endpoint);
  assert(source.includes('required("NEMOCLAW_BROWSER_RELAY_TOKEN")'));
  assert(source.includes('required("NEMOCLAW_BROWSER_CDP_PATH")'));
  assert(!source.includes("AGENT_BROWSER_EXECUTABLE_PATH ="));
});

test("unchecked Hermes search replaces persisted enables with the stable disabled-web contract", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "native-hermes-search-off-"));
  try {
    fs.writeFileSync(
      path.join(home, "config.yaml"),
      JSON.stringify({
        web: { backend: "tavily", keyless_fallback: true },
        agent: { disabled_toolsets: [] },
        platform_toolsets: { cli: ["hermes-cli", "web"], slack: ["web"] },
      }),
    );
    const actual = writeGeneratedHermesConfiguration(home, {});
    // v2026.9.7: web_search_registry reads keyless_fallback; the final
    // model_tools selection subtracts agent.disabled_toolsets after enables.
    assert.deepEqual(actual.web, { keyless_fallback: false });
    assert.deepEqual(actual.agent.disabled_toolsets, ["web"]);
    assert.equal(actual.platform_toolsets, undefined);
    assert.equal(actual.agent.disabled_toolsets.includes("browser"), false);
    assert.equal(actual.security.allow_lazy_installs, false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("Tavily selection clears previous suppression and preserves existing Hermes YAML semantics", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "native-hermes-search-on-"));
  try {
    writeGeneratedHermesConfiguration(home, {});
    const actual = writeGeneratedHermesConfiguration(home, {
      search: { provider: "tavily", credentialStored: true },
      messaging: { telegram: { credentialStored: true, allowedUsers: [] } },
    });
    assert.deepEqual(actual, {
      model: {
        default: "test-model",
        provider: "custom",
        base_url: "http://127.0.0.1:1/v1",
        api_key: "",
        context_length: 131072,
      },
      web: {
        backend: "tavily",
        search_backend: "tavily",
        extract_backend: "tavily",
      },
      platforms: { telegram: { enabled: true } },
      memory: { memory_enabled: true, user_profile_enabled: true },
      security: { allow_lazy_installs: false },
      updates: {
        check: false,
        pre_update_backup: false,
        refresh_cua_driver: false,
      },
    });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("dashboard and console cleanup emit their held runtime tuple and cleanup results", async () => {
  const source = fs.readFileSync(
    new URL("./run-installed-native-console-agent.mts", import.meta.url),
    "utf8",
  );
  const start = source.indexOf('await attempt("qualification cleanup receipt", () => {');
  const end = source.indexOf("    diagnostics.cleanupFailed(...cleanupFailures)", start);
  assert(start >= 0 && end > start);
  const runtimeLease = {
    runtimeId: "a".repeat(64),
    manifestSha256: "b".repeat(64),
    sourceRevision: "c".repeat(40),
    runtimeBytesCopied: 7,
    runtimeFilesHashedAtLaunch: 3,
  };
  for (const surface of ["dashboard", "console"]) {
    for (const succeeded of [true, false]) {
      const written: { file: string; document: any; options: any }[] = [];
      await runInNewContext(
        "(async () => {" + stripTypeScriptTypes(source.slice(start, end)) + "})()",
        {
          agentId: "hermes",
          dashboardEvidenceRoot: surface === "dashboard" ? "/evidence" : null,
          consoleEvidenceRoot: surface === "console" ? "/evidence" : null,
          attempt: async (_label: string, operation: () => unknown) => operation(),
          path,
          runtimeLease,
          gatewaySession: { root: "private-gateway" },
          sessionPassed: succeeded,
          dashboardGatewayStopped: succeeded,
          rootsRemoved: succeeded,
          runRoot: "run",
          runtimeRoot: "runtime",
          dashboardRelayRoot: "relay",
          statusRoot: "status",
          agentRuntimeRoot: "state",
          released: succeeded,
          cleanupFailures: succeeded ? [] : ["owned fixture cleanup"],
          fs: {
            existsSync: (value: string) =>
              value === "state" || (!succeeded && value === "private-gateway"),
            writeFileSync: (file: string, text: string, options: unknown) =>
              written.push({ file, document: JSON.parse(text), options }),
          },
        },
      );
      assert.equal(written.length, 1);
      assert.equal(
        written[0].file,
        path.join(
          "/evidence",
          surface === "dashboard" ? "dashboard-end.json" : "console-cleanup.json",
        ),
      );
      assert.equal(written[0].options.flag, "wx");
      const result = written[0].document;
      assert.equal(result.agent, "hermes");
      assert.equal(result.stateRetained, true);
      assert.equal(result.retainedPrivateGatewayRoot, succeeded ? null : "private-gateway");
      for (const key of [
        "sandboxDeleted",
        "gatewayStopped",
        "ephemeralRootsRemoved",
        "leaseReleased",
        "cleanupSucceeded",
      ])
        assert.equal(result[key], succeeded, key);
      assert.equal(result.runtimeBytesCopied, runtimeLease.runtimeBytesCopied);
      assert.equal(result.runtimeFilesHashedAtLaunch, runtimeLease.runtimeFilesHashedAtLaunch);
      assert.equal(result.runtimeCounterSource, "held-runtime-session");
      assert.deepEqual(JSON.parse(JSON.stringify(result.runtimeIdentity)), {
        runtimeId: runtimeLease.runtimeId,
        manifestSha256: runtimeLease.manifestSha256,
        sourceRevision: runtimeLease.sourceRevision,
      });
    }
  }
});
