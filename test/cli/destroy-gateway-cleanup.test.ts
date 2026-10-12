// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { runWithEnv, testTimeoutOptions } from "./helpers";

const LIVE_DOCKER_IDENTITY = `#!/bin/sh
removed_marker="$0.removed"
case "$1" in
  ps)
    if [ ! -e "$removed_marker" ]; then
      last_arg=""
      for arg do last_arg="$arg"; done
      case "$last_arg" in
        '{{.ID}}') printf 'aaaaaaaaaaaa\n' ;;
        *) printf 'aaaaaaaaaaaa\topenshell\tdefault\tsb-alpha\n' ;;
      esac
    fi
    ;;
  rm)
    if [ "$2" = "-f" ] && [ "$3" = "aaaaaaaaaaaa" ]; then
      : > "$removed_marker"
    fi
    ;;
esac
exit 0
`;

function confirmSandboxMissingAfterDelete(markerPath: string, logPath: string): string[] {
  return [
    'if [ "$1" = "gateway" ] && [ "$2" = "list" ]; then',
    '  printf \'[{"name":"nemoclaw","active":true},{"name":"nemoclaw-8081","active":false}]\\n\'',
    "  exit 0",
    "fi",
    `deleted_marker=${JSON.stringify(markerPath)}`,
    `delete_log_file=${JSON.stringify(logPath)}`,
    'if [ "$1" = "sandbox" ] && [ "$2" = "delete" ]; then',
    '  : > "$deleted_marker"',
    "fi",
    'if [ "$1" = "sandbox" ] && [ "$2" = "get" ] && [ -e "$deleted_marker" ]; then',
    '  printf \'%s\\n\' "$*" >> "$delete_log_file"',
    '  printf "Error: code: \'Some requested entity was not found\', message: \\"sandbox not found\\"\\n" >&2',
    "  exit 1",
    "fi",
  ];
}

function isPersistentStateWipeExec(line: string): boolean {
  return line.includes("nemoclaw-native-home-cleanup");
}

describe("CLI dispatch", () => {
  it(
    "uses the platform gateway default when the last sandbox is destroyed (#2166, #4662)",
    testTimeoutOptions(30_000),
    () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-destroy-last-"));
      const localBin = path.join(home, "bin");
      const registryDir = path.join(home, ".nemoclaw");
      const openshellLog = path.join(home, "openshell.log");
      const bashLog = path.join(home, "docker.log");
      fs.mkdirSync(localBin, { recursive: true });
      fs.mkdirSync(registryDir, { recursive: true });
      fs.writeFileSync(
        path.join(registryDir, "sandboxes.json"),
        JSON.stringify({
          sandboxes: {
            alpha: {
              name: "alpha",
              model: "test-model",
              provider: "nvidia-prod",
              gpuEnabled: false,
              agent: "langchain-deepagents-code",
            },
          },
          defaultSandbox: "alpha",
        }),
        { mode: 0o600 },
      );
      fs.writeFileSync(
        path.join(localBin, "openshell"),
        [
          "#!/bin/sh",
          ...confirmSandboxMissingAfterDelete(path.join(home, "sandbox-deleted"), openshellLog),
          `log_file=${JSON.stringify(openshellLog)}`,
          'if [ "$1" = "sandbox" ] && [ "$2" = "list" ]; then',
          '  printf "NAME STATUS\\n" >> "$log_file"',
          "  exit 0",
          "fi",
          'printf \'%s\\n\' "$*" >> "$log_file"',
          "exit 0",
        ].join("\n"),
        { mode: 0o755 },
      );
      fs.writeFileSync(
        path.join(localBin, "docker"),
        [
          "#!/bin/sh",
          `log_file=${JSON.stringify(bashLog)}`,
          'printf \'%s\\n\' "$*" >> "$log_file"',
          "exit 0",
        ].join("\n"),
        { mode: 0o755 },
      );

      const r = runWithEnv("alpha destroy -y", {
        HOME: home,
        PATH: `${localBin}:${process.env.PATH || ""}`,
      });

      expect(r.code, r.out).toBe(0);
      const openshellOutput = fs.readFileSync(openshellLog, "utf8");
      const dockerOutput = fs.readFileSync(bashLog, "utf8");
      const shouldCleanupGateway = process.platform === "darwin";
      expect(openshellOutput).toContain("sandbox delete -g nemoclaw alpha");
      expect(openshellOutput).toContain("NAME STATUS");
      expect(openshellOutput).not.toContain("forward stop 18789");
      expect(openshellOutput.includes("gateway remove nemoclaw")).toBe(shouldCleanupGateway);
      expect(dockerOutput.includes("volume ls -q --filter name=openshell-cluster-nemoclaw")).toBe(
        shouldCleanupGateway,
      );
      expect(r.out.includes("openshell gateway remove nemoclaw")).toBe(!shouldCleanupGateway);
      expect(r.out).not.toContain("gateway destroy");
    },
  );

  it(
    "falls back to legacy gateway destroy when remove is unsupported (#6569)",
    testTimeoutOptions(30_000),
    () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-destroy-last-cleanup-"));
      const localBin = path.join(home, "bin");
      const registryDir = path.join(home, ".nemoclaw");
      const openshellLog = path.join(home, "openshell.log");
      const bashLog = path.join(home, "docker.log");
      fs.mkdirSync(localBin, { recursive: true });
      fs.mkdirSync(registryDir, { recursive: true });
      fs.writeFileSync(
        path.join(registryDir, "sandboxes.json"),
        JSON.stringify({
          sandboxes: {
            alpha: {
              name: "alpha",
              model: "test-model",
              provider: "nvidia-prod",
              gpuEnabled: false,
              agent: "langchain-deepagents-code",
              gatewayName: "nemoclaw-8081",
              gatewayPort: 8081,
            },
          },
          defaultSandbox: "alpha",
        }),
        { mode: 0o600 },
      );
      fs.writeFileSync(
        path.join(localBin, "openshell"),
        [
          "#!/bin/sh",
          ...confirmSandboxMissingAfterDelete(path.join(home, "sandbox-deleted"), openshellLog),
          `log_file=${JSON.stringify(openshellLog)}`,
          'if [ "$1" = "sandbox" ] && [ "$2" = "list" ]; then',
          '  printf "NAME STATUS\\n" >> "$log_file"',
          "  exit 0",
          "fi",
          'printf \'%s\\n\' "$*" >> "$log_file"',
          'if [ "$1" = "gateway" ] && [ "$2" = "remove" ]; then',
          "  printf '%s\n' \"unrecognized subcommand 'remove'\" >&2",
          "  exit 1",
          "fi",
          "exit 0",
        ].join("\n"),
        { mode: 0o755 },
      );
      fs.writeFileSync(
        path.join(localBin, "docker"),
        [
          "#!/bin/sh",
          `log_file=${JSON.stringify(bashLog)}`,
          'printf \'%s\\n\' "$*" >> "$log_file"',
          "exit 0",
        ].join("\n"),
        { mode: 0o755 },
      );
      fs.writeFileSync(path.join(localBin, "pgrep"), "#!/bin/sh\nexit 1\n", {
        mode: 0o755,
      });
      fs.writeFileSync(path.join(localBin, "lsof"), "#!/bin/sh\nexit 1\n", {
        mode: 0o755,
      });

      const r = runWithEnv(
        "alpha destroy -y --cleanup-gateway",
        {
          HOME: home,
          PATH: `${localBin}:${process.env.PATH || ""}`,
        },
        30_000,
      );

      expect(r.code, r.out).toBe(0);
      const openshellOutput = fs.readFileSync(openshellLog, "utf8");
      expect(openshellOutput).toContain("sandbox delete -g nemoclaw-8081 alpha");
      expect(openshellOutput).not.toContain("forward stop 18789");
      // `gateway remove` is the modern subcommand on every platform (#6569).
      expect(openshellOutput).toContain("gateway remove nemoclaw-8081");
      expect(openshellOutput).toContain("gateway destroy -g nemoclaw-8081");
      expect(openshellOutput.indexOf("gateway remove nemoclaw-8081")).toBeLessThan(
        openshellOutput.indexOf("gateway destroy -g nemoclaw-8081"),
      );
      expect(fs.readFileSync(bashLog, "utf8")).toContain(
        "volume ls -q --filter name=openshell-cluster-nemoclaw-8081",
      );
    },
  );

  it(
    "honours NEMOCLAW_CLEANUP_GATEWAY=1 as the env-driven opt-in (#2166)",
    testTimeoutOptions(30_000),
    () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-destroy-last-env-"));
      const localBin = path.join(home, "bin");
      const registryDir = path.join(home, ".nemoclaw");
      const openshellLog = path.join(home, "openshell.log");
      const bashLog = path.join(home, "docker.log");
      fs.mkdirSync(localBin, { recursive: true });
      fs.mkdirSync(registryDir, { recursive: true });
      fs.writeFileSync(
        path.join(registryDir, "sandboxes.json"),
        JSON.stringify({
          sandboxes: {
            alpha: {
              name: "alpha",
              model: "test-model",
              provider: "nvidia-prod",
              gpuEnabled: false,
              agent: "langchain-deepagents-code",
            },
          },
          defaultSandbox: "alpha",
        }),
        { mode: 0o600 },
      );
      fs.writeFileSync(
        path.join(localBin, "openshell"),
        [
          "#!/bin/sh",
          ...confirmSandboxMissingAfterDelete(path.join(home, "sandbox-deleted"), openshellLog),
          `log_file=${JSON.stringify(openshellLog)}`,
          'if [ "$1" = "sandbox" ] && [ "$2" = "list" ]; then',
          '  printf "NAME STATUS\\n" >> "$log_file"',
          "  exit 0",
          "fi",
          'printf \'%s\\n\' "$*" >> "$log_file"',
          "exit 0",
        ].join("\n"),
        { mode: 0o755 },
      );
      fs.writeFileSync(
        path.join(localBin, "docker"),
        [
          "#!/bin/sh",
          `log_file=${JSON.stringify(bashLog)}`,
          'printf \'%s\\n\' "$*" >> "$log_file"',
          "exit 0",
        ].join("\n"),
        { mode: 0o755 },
      );
      fs.writeFileSync(path.join(localBin, "pgrep"), "#!/bin/sh\nexit 1\n", {
        mode: 0o755,
      });
      fs.writeFileSync(path.join(localBin, "lsof"), "#!/bin/sh\nexit 1\n", {
        mode: 0o755,
      });

      const r = runWithEnv(
        "alpha destroy -y",
        {
          HOME: home,
          PATH: `${localBin}:${process.env.PATH || ""}`,
          NEMOCLAW_CLEANUP_GATEWAY: "1",
        },
        30_000,
      );

      expect(r.code, r.out).toBe(0);
      const openshellOutput = fs.readFileSync(openshellLog, "utf8");
      expect(openshellOutput).not.toContain("forward stop 18789");
      // `gateway remove` is the modern subcommand on every platform (#6569).
      expect(openshellOutput).toContain("gateway remove nemoclaw");
      expect(openshellOutput).not.toContain("gateway destroy -g nemoclaw");
      expect(fs.readFileSync(bashLog, "utf8")).toContain(
        "volume ls -q --filter name=openshell-cluster-nemoclaw",
      );
    },
  );

  it.runIf(process.platform === "linux")(
    "clears only the per-port host gateway PID file when destroying nemoclaw-<port>",
    testTimeoutOptions(30_000),
    () => {
      // A `nemoclaw-8081` sandbox's destroy must read and clear its own
      // `openshell-docker-gateway-8081/openshell-gateway.pid`, NOT the default
      // instance's `openshell-docker-gateway/openshell-gateway.pid`. Otherwise
      // destroying a non-default sandbox tears down the default instance's
      // tracked host gateway process.
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-destroy-perport-pid-"));
      const localBin = path.join(home, "bin");
      const registryDir = path.join(home, ".nemoclaw");
      const openshellLog = path.join(home, "openshell.log");
      const defaultStateDir = path.join(home, ".local/state/nemoclaw/openshell-docker-gateway");
      const perPortStateDir = path.join(
        home,
        ".local/state/nemoclaw/openshell-docker-gateway-8081",
      );
      const defaultPidFile = path.join(defaultStateDir, "openshell-gateway.pid");
      const perPortPidFile = path.join(perPortStateDir, "openshell-gateway.pid");
      fs.mkdirSync(localBin, { recursive: true });
      fs.mkdirSync(registryDir, { recursive: true });
      fs.mkdirSync(defaultStateDir, { recursive: true });
      fs.mkdirSync(perPortStateDir, { recursive: true });
      // PIDs that are guaranteed to be dead so stopHostGatewayProcesses takes
      // the clearRuntimeFiles branch without trying to kill anything.
      fs.writeFileSync(defaultPidFile, "999998\n");
      fs.writeFileSync(perPortPidFile, "999999\n");
      fs.writeFileSync(
        path.join(registryDir, "sandboxes.json"),
        JSON.stringify({
          sandboxes: {
            alpha: {
              name: "alpha",
              model: "test-model",
              provider: "nvidia-prod",
              gpuEnabled: false,
              agent: "langchain-deepagents-code",
              gatewayName: "nemoclaw-8081",
              gatewayPort: 8081,
            },
          },
          defaultSandbox: "alpha",
        }),
        { mode: 0o600 },
      );
      fs.writeFileSync(
        path.join(localBin, "openshell"),
        [
          "#!/bin/sh",
          ...confirmSandboxMissingAfterDelete(path.join(home, "sandbox-deleted"), openshellLog),
          'if [ "$1" = "sandbox" ] && [ "$2" = "list" ]; then',
          '  printf "NAME STATUS\\n"',
          "  exit 0",
          "fi",
          "exit 0",
        ].join("\n"),
        { mode: 0o755 },
      );
      fs.writeFileSync(path.join(localBin, "docker"), "#!/bin/sh\nexit 0\n", {
        mode: 0o755,
      });
      fs.writeFileSync(path.join(localBin, "pgrep"), "#!/bin/sh\nexit 1\n", {
        mode: 0o755,
      });
      fs.writeFileSync(path.join(localBin, "lsof"), "#!/bin/sh\nexit 1\n", {
        mode: 0o755,
      });

      const r = runWithEnv(
        "alpha destroy -y --cleanup-gateway",
        {
          HOME: home,
          PATH: `${localBin}:${process.env.PATH || ""}`,
        },
        30_000,
      );

      expect(r.code, r.out).toBe(0);
      expect(fs.existsSync(perPortPidFile)).toBe(false);
      expect(fs.existsSync(defaultPidFile)).toBe(true);
      expect(fs.readFileSync(defaultPidFile, "utf8").trim()).toBe("999998");
    },
  );

  it.runIf(process.platform === "linux")(
    "stops the packaged gateway service so the port is free after the final destroy (#7904)",
    testTimeoutOptions(30_000),
    () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-destroy-service-"));
      const localBin = path.join(home, "bin");
      const registryDir = path.join(home, ".nemoclaw");
      const configHome = path.join(home, ".config");
      const binHome = path.join(home, ".local", "bin");
      const unitDir = path.join(configHome, "systemd", "user");
      const unitPath = path.join(unitDir, "nemoclaw-openshell-gateway.service");
      const gatewayBin = path.join(binHome, "openshell-gateway");
      const openshellLog = path.join(home, "openshell.log");
      const systemctlLog = path.join(home, "systemctl.log");
      fs.mkdirSync(localBin, { recursive: true });
      fs.mkdirSync(registryDir, { recursive: true });
      fs.mkdirSync(unitDir, { recursive: true });
      fs.writeFileSync(
        unitPath,
        ["[Unit]", "# NEMOCLAW_MANAGED_OPENSHELL_GATEWAY=1", "[Service]"].join("\n"),
      );
      fs.writeFileSync(
        path.join(registryDir, "sandboxes.json"),
        JSON.stringify({
          sandboxes: {
            alpha: {
              name: "alpha",
              model: "test-model",
              provider: "nvidia-prod",
              gpuEnabled: false,
              agent: "langchain-deepagents-code",
            },
          },
          defaultSandbox: "alpha",
        }),
        { mode: 0o600 },
      );
      fs.writeFileSync(
        path.join(localBin, "openshell"),
        [
          "#!/bin/sh",
          ...confirmSandboxMissingAfterDelete(path.join(home, "sandbox-deleted"), openshellLog),
          `log_file=${JSON.stringify(openshellLog)}`,
          'if [ "$1" = "sandbox" ] && [ "$2" = "list" ]; then',
          '  printf "NAME STATUS\\n" >> "$log_file"',
          "  exit 0",
          "fi",
          'printf \'%s\\n\' "$*" >> "$log_file"',
          "exit 0",
        ].join("\n"),
        { mode: 0o755 },
      );
      fs.writeFileSync(
        path.join(localBin, "systemctl"),
        [
          "#!/bin/sh",
          `log_file=${JSON.stringify(systemctlLog)}`,
          'printf \'%s\\n\' "$*" >> "$log_file"',
          'if [ "$2" = "show" ]; then',
          `  printf 'FragmentPath=%s\\n' ${JSON.stringify(unitPath)}`,
          `  printf 'ExecStart={ path=%s ; argv[]=%s ; }\\n' ${JSON.stringify(gatewayBin)} ${JSON.stringify(gatewayBin)}`,
          "fi",
          "exit 0",
        ].join("\n"),
        { mode: 0o755 },
      );
      fs.writeFileSync(path.join(localBin, "docker"), "#!/bin/sh\nexit 0\n", {
        mode: 0o755,
      });
      fs.writeFileSync(path.join(localBin, "pgrep"), "#!/bin/sh\nexit 1\n", {
        mode: 0o755,
      });
      fs.writeFileSync(path.join(localBin, "lsof"), "#!/bin/sh\nexit 1\n", {
        mode: 0o755,
      });

      const r = runWithEnv(
        "alpha destroy -y --cleanup-gateway",
        {
          HOME: home,
          PATH: `${localBin}:${process.env.PATH || ""}`,
          XDG_BIN_HOME: binHome,
          XDG_CONFIG_HOME: configHome,
        },
        30_000,
      );

      expect(r.code, r.out).toBe(0);
      const systemctlOutput = fs.readFileSync(systemctlLog, "utf8");
      expect(systemctlOutput).toContain("--user stop nemoclaw-openshell-gateway\n");
      expect(systemctlOutput).not.toContain("disable");
      expect(fs.readFileSync(openshellLog, "utf8")).toContain("gateway remove nemoclaw");
    },
  );

  it("keeps the gateway runtime when other sandboxes still exist", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-destroy-shared-"));
    const localBin = path.join(home, "bin");
    const registryDir = path.join(home, ".nemoclaw");
    const openshellLog = path.join(home, "openshell.log");
    const bashLog = path.join(home, "docker.log");
    fs.mkdirSync(localBin, { recursive: true });
    fs.mkdirSync(registryDir, { recursive: true });
    fs.writeFileSync(
      path.join(registryDir, "sandboxes.json"),
      JSON.stringify({
        sandboxes: {
          alpha: {
            name: "alpha",
            model: "test-model",
            provider: "nvidia-prod",
            gpuEnabled: false,
            agent: "langchain-deepagents-code",
            gatewayName: "nemoclaw-8081",
            gatewayPort: 8081,
          },
          beta: {
            name: "beta",
            model: "test-model",
            provider: "nvidia-prod",
            gpuEnabled: false,
            agent: "langchain-deepagents-code",
          },
        },
        defaultSandbox: "alpha",
      }),
      { mode: 0o600 },
    );
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/bin/sh",
        ...confirmSandboxMissingAfterDelete(path.join(home, "sandbox-deleted"), openshellLog),
        `log_file=${JSON.stringify(openshellLog)}`,
        'if [ "$1" = "sandbox" ] && [ "$2" = "list" ]; then',
        '  printf "NAME STATUS\\nbeta Ready\\n" >> "$log_file"',
        '  printf "NAME STATUS\\nbeta Ready\\n"',
        "  exit 0",
        "fi",
        'printf \'%s\\n\' "$*" >> "$log_file"',
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );
    fs.writeFileSync(
      path.join(localBin, "docker"),
      [
        "#!/bin/sh",
        `log_file=${JSON.stringify(bashLog)}`,
        'printf \'%s\\n\' "$*" >> "$log_file"',
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );

    const r = runWithEnv("alpha destroy --yes", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });

    expect(r.code).toBe(0);
    expect(fs.readFileSync(openshellLog, "utf8")).toContain(
      "sandbox delete -g nemoclaw-8081 alpha",
    );
    expect(fs.readFileSync(openshellLog, "utf8")).not.toContain("forward stop 18789");
    expect(fs.readFileSync(openshellLog, "utf8")).not.toContain("gateway destroy -g nemoclaw");
    expect(fs.readFileSync(openshellLog, "utf8")).not.toContain("gateway remove nemoclaw");
    if (fs.existsSync(bashLog)) {
      expect(fs.readFileSync(bashLog, "utf8")).not.toContain("volume ls -q --filter");
    }
  });

  it("keeps the gateway runtime when the live gateway still reports sandboxes", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-destroy-live-shared-"));
    const localBin = path.join(home, "bin");
    const registryDir = path.join(home, ".nemoclaw");
    const openshellLog = path.join(home, "openshell.log");
    const bashLog = path.join(home, "docker.log");
    const deletedMarker = path.join(home, "alpha-deleted");
    const sandboxListJson = (names: string[]) =>
      JSON.stringify(
        names.map((name) => ({
          id: `sandbox-${name}`,
          name,
          labels: {},
          resource_version: 1,
          created_at: "2026-09-16T00:00:00Z",
          phase: "Ready",
          current_policy_version: 1,
        })),
      );
    const beforeDeleteListJson = sandboxListJson(["alpha", "beta"]);
    const afterDeleteListJson = sandboxListJson(["beta"]);
    fs.mkdirSync(localBin, { recursive: true });
    fs.mkdirSync(registryDir, { recursive: true });
    fs.writeFileSync(
      path.join(registryDir, "sandboxes.json"),
      JSON.stringify({
        sandboxes: {
          alpha: {
            name: "alpha",
            model: "test-model",
            provider: "nvidia-prod",
            gpuEnabled: false,
            agent: "langchain-deepagents-code",
          },
        },
        defaultSandbox: "alpha",
      }),
      { mode: 0o600 },
    );
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/bin/sh",
        ...confirmSandboxMissingAfterDelete(path.join(home, "sandbox-deleted"), openshellLog),
        `log_file=${JSON.stringify(openshellLog)}`,
        `deleted_marker=${JSON.stringify(deletedMarker)}`,
        'if [ "$1" = "sandbox" ] && [ "$2" = "list" ]; then',
        '  case " $* " in',
        '    *" -o json "*)',
        '      if [ -e "$deleted_marker" ]; then',
        `        output=${JSON.stringify(afterDeleteListJson)}`,
        "      else",
        `        output=${JSON.stringify(beforeDeleteListJson)}`,
        "      fi",
        "      ;;",
        "    *)",
        '      if [ -e "$deleted_marker" ]; then',
        '        output="NAME STATUS\\nbeta Ready"',
        "      else",
        '        output="NAME STATUS\\nalpha Ready\\nbeta Ready"',
        "      fi",
        "      ;;",
        "  esac",
        '  printf "%b\\n" "$output" >> "$log_file"',
        '  printf "%b\\n" "$output"',
        "  exit 0",
        "fi",
        'if [ "$1" = "sandbox" ] && [ "$2" = "delete" ]; then',
        '  : > "$deleted_marker"',
        "fi",
        'printf \'%s\\n\' "$*" >> "$log_file"',
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );
    fs.writeFileSync(
      path.join(localBin, "docker"),
      [
        "#!/bin/sh",
        `log_file=${JSON.stringify(bashLog)}`,
        'printf \'%s\\n\' "$*" >> "$log_file"',
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );

    const r = runWithEnv("alpha destroy --yes --cleanup-gateway 2>&1", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });

    expect(r.code).toBe(1);
    expect(r.out).toContain("Shared NemoClaw gateway left running");
    expect(r.out).toContain("--cleanup-gateway was not applied");
    expect(r.out).toContain("'beta'");
    expect(fs.readFileSync(openshellLog, "utf8")).toContain("sandbox delete -g nemoclaw alpha");
    expect(fs.readFileSync(openshellLog, "utf8")).toContain("beta Ready");
    expect(fs.readFileSync(openshellLog, "utf8")).not.toContain("forward stop 18789");
    expect(fs.readFileSync(openshellLog, "utf8")).not.toContain("gateway destroy -g nemoclaw");
    expect(fs.readFileSync(openshellLog, "utf8")).not.toContain("gateway remove nemoclaw");
    if (fs.existsSync(bashLog)) {
      expect(fs.readFileSync(bashLog, "utf8")).not.toContain("volume ls -q --filter");
    }
  });

  it.each([
    ["--cleanup-gateway", true, false, false, false, false, "", 0, true, true],
    ["--no-cleanup-gateway", false, false, false, false, false, "", 0, true, true],
    ["--no-cleanup-gateway", false, true, false, false, false, "", 42, true, true],
    ["--no-cleanup-gateway", false, false, true, false, false, "", 1, false, false],
    ["--no-cleanup-gateway", false, false, false, true, false, "", 0, true, false],
    ["--no-cleanup-gateway", false, false, false, false, true, "", 1, true, true],
    ["--no-cleanup-gateway", false, true, false, false, true, "", 42, true, true],
    ["--no-cleanup-gateway", false, false, false, false, false, "list-failure", 1, true, false],
    ["--no-cleanup-gateway", false, false, false, false, false, "prior-missing", 1, true, false],
    ["--no-cleanup-gateway", false, false, false, false, false, "marker-omitted", 1, true, false],
    ["--no-cleanup-gateway", false, false, false, false, false, "already-restored", 0, true, false],
    [
      "--no-cleanup-gateway",
      false,
      false,
      false,
      false,
      false,
      "no-active-target-present",
      1,
      true,
      false,
    ],
  ] as const)(
    "preserves active gateway during destroy %s (cleanup: %s, delete failure: %s, missing marker: %s, concurrent selection: %s, restore failure: %s, registry state: %s) (#11897)",
    (
      cleanupFlag,
      cleanupGateway,
      failDelete,
      missingActive,
      concurrentSelection,
      failRestoration,
      postOperationState,
      expectedExitCode,
      mutationExpected,
      restorationExpected,
    ) => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-destroy-restore-active-"));
      const localBin = path.join(home, "bin");
      const registryDir = path.join(home, ".nemoclaw");
      const openshellLog = path.join(home, "openshell.log");
      const activeGateway = path.join(home, "active-gateway");
      const removedGateway = path.join(home, "gateway-removed");
      const deletedSandbox = path.join(home, "sandbox-deleted");
      const failDeleteMarker = path.join(home, "fail-delete");
      const missingActiveMarker = path.join(home, "missing-active");
      const concurrentSelectionMarker = path.join(home, "concurrent-selection");
      const enableConcurrentSelectionMarker = path.join(home, "enable-concurrent-selection");
      const targetSelectedMarker = path.join(home, "target-selected");
      const failRestorationMarker = path.join(home, "fail-restoration");
      const postOperationStateMarker = path.join(home, "post-operation-state");
      fs.writeFileSync(failDeleteMarker, failDelete ? "fail" : "");
      fs.writeFileSync(missingActiveMarker, missingActive ? "missing" : "");
      fs.writeFileSync(concurrentSelectionMarker, "");
      fs.writeFileSync(enableConcurrentSelectionMarker, concurrentSelection ? "yes" : "");
      fs.writeFileSync(failRestorationMarker, failRestoration ? "fail" : "");
      fs.writeFileSync(postOperationStateMarker, "");
      fs.mkdirSync(localBin, { recursive: true });
      fs.mkdirSync(registryDir, { recursive: true });
      fs.writeFileSync(activeGateway, "survivor-gateway\n");
      fs.writeFileSync(
        path.join(registryDir, "sandboxes.json"),
        JSON.stringify({
          sandboxes: {
            alpha: {
              name: "alpha",
              model: "test-model",
              provider: "nvidia-prod",
              gpuEnabled: false,
              agent: "langchain-deepagents-code",
              gatewayName: "nemoclaw-8081",
              gatewayPort: 8081,
            },
          },
          defaultSandbox: "alpha",
        }),
        { mode: 0o600 },
      );
      fs.writeFileSync(
        path.join(localBin, "openshell"),
        [
          "#!/bin/sh",
          `log_file=${JSON.stringify(openshellLog)}`,
          `active_gateway=${JSON.stringify(activeGateway)}`,
          `removed_gateway=${JSON.stringify(removedGateway)}`,
          `deleted_sandbox=${JSON.stringify(deletedSandbox)}`,
          `fail_delete=${JSON.stringify(failDeleteMarker)}`,
          `missing_active=${JSON.stringify(missingActiveMarker)}`,
          `concurrent_selection=${JSON.stringify(concurrentSelectionMarker)}`,
          `enable_concurrent_selection=${JSON.stringify(enableConcurrentSelectionMarker)}`,
          `target_selected=${JSON.stringify(targetSelectedMarker)}`,
          `fail_restoration=${JSON.stringify(failRestorationMarker)}`,
          `post_operation_state=${JSON.stringify(postOperationStateMarker)}`,
          `post_operation_state_value=${JSON.stringify(postOperationState)}`,
          'printf \'%s\\n\' "$*" >> "$log_file"',
          'if [ "$1" = "gateway" ] && [ "$2" = "list" ]; then',
          '  if [ -s "$missing_active" ]; then printf \'[{"name":"nemoclaw-8081"},{"name":"survivor-gateway"}]\\n\'; exit 0; fi',
          '  active="$(cat "$active_gateway")"',
          '  if [ -s "$concurrent_selection" ]; then printf \'[{"name":"nemoclaw-8081","active":false},{"name":"survivor-gateway","active":false},{"name":"new-gateway","active":true}]\\n\'; exit 0; fi',
          '  if [ -s "$post_operation_state" ]; then',
          '    case "$post_operation_state_value" in',

          '      list-failure) echo "registry unavailable" >&2; exit 44 ;;',
          '      prior-missing) printf \'[{"name":"nemoclaw-8081","active":true}]\\n\' ;;',
          '      marker-omitted) printf \'[{"name":"nemoclaw-8081"},{"name":"survivor-gateway"}]\\n\' ;;',
          '      already-restored) printf \'[{"name":"nemoclaw-8081","active":false},{"name":"survivor-gateway","active":true}]\\n\' ;;',
          '      no-active-target-present) printf \'[{"name":"nemoclaw-8081","active":false},{"name":"survivor-gateway","active":false}]\\n\' ;;',
          "    esac",
          "    exit 0",
          "  fi",
          '  if [ -e "$target_selected" ] && [ ! -e "$removed_gateway" ]; then printf \'[{"name":"nemoclaw-8081","active":true},{"name":"survivor-gateway","active":false}]\\n\'; exit 0; fi',
          '  if [ -n "$OPENSHELL_GATEWAY" ]; then active="$OPENSHELL_GATEWAY"; fi',
          '  if [ -e "$removed_gateway" ]; then',
          '    printf \'[{"name":"survivor-gateway","active":%s}]\\n\' "$( [ "$active" = "survivor-gateway" ] && printf true || printf false )"',
          "  else",
          '    printf \'[{"name":"nemoclaw-8081","active":%s},{"name":"survivor-gateway","active":%s}]\\n\' "$( [ "$active" = "nemoclaw-8081" ] && printf true || printf false )" "$( [ "$active" = "survivor-gateway" ] && printf true || printf false )"',
          "  fi",
          "  exit 0",
          "fi",
          'if [ "$1" = "gateway" ] && [ "$2" = "select" ]; then',
          '  if [ "$3" = "survivor-gateway" ] && [ -s "$fail_restoration" ]; then echo "restore failed" >&2; exit 43; fi',
          '  printf "%s\\n" "$3" > "$active_gateway"',
          '  if [ "$3" = "nemoclaw-8081" ]; then : > "$target_selected"; fi',
          "  exit 0",
          "fi",
          'if [ "$1" = "gateway" ] && [ "$2" = "remove" ] && [ "$3" = "nemoclaw-8081" ]; then',
          '  : > "$removed_gateway"',
          '  : > "$active_gateway"',
          "  exit 0",
          "fi",
          'if [ "$1" = "sandbox" ] && [ "$2" = "delete" ]; then',
          '  if [ -s "$fail_delete" ]; then echo "delete failed" >&2; exit 42; fi',
          '  if [ -s "$enable_concurrent_selection" ]; then printf "selected\\n" > "$concurrent_selection"; printf "new-gateway\\n" > "$active_gateway"; fi',
          '  if [ -n "$post_operation_state_value" ]; then',
          '    printf "%s\\n" "$post_operation_state_value" > "$post_operation_state"',
          '    if [ "$post_operation_state_value" = "already-restored" ]; then printf "survivor-gateway\\n" > "$active_gateway"; fi',
          '    if [ "$post_operation_state_value" = "no-active-target-present" ]; then : > "$active_gateway"; fi',
          "  fi",
          '  : > "$deleted_sandbox"',
          "  exit 0",
          "fi",
          'if [ "$1" = "sandbox" ] && [ "$2" = "get" ] && [ -e "$deleted_sandbox" ]; then',
          '  echo "Error: code: \'Some requested entity was not found\', message: \\"sandbox not found\\"" >&2',
          "  exit 1",
          "fi",
          'if [ "$1" = "sandbox" ] && [ "$2" = "list" ]; then',
          '  printf "NAME STATUS\\n"',
          "  exit 0",
          "fi",
          "exit 0",
        ].join("\n"),
        { mode: 0o755 },
      );
      fs.writeFileSync(path.join(localBin, "docker"), LIVE_DOCKER_IDENTITY, {
        mode: 0o755,
      });
      fs.writeFileSync(path.join(localBin, "pgrep"), "#!/bin/sh\nexit 1\n", {
        mode: 0o755,
      });
      fs.writeFileSync(path.join(localBin, "lsof"), "#!/bin/sh\nexit 1\n", {
        mode: 0o755,
      });

      const r = runWithEnv(`alpha destroy --yes ${cleanupFlag}`, {
        HOME: home,
        OPENSHELL_GATEWAY: "nemoclaw-8081",
        PATH: `${localBin}:${process.env.PATH || ""}`,
      });

      const lines = fs.readFileSync(openshellLog, "utf8").trim().split("\n");
      expect(r.code, r.out).toBe(expectedExitCode);
      expect(
        r.out.includes(
          "Could not preserve the active OpenShell gateway before destroying 'alpha':",
        ),
      ).toBe(missingActive);
      expect(
        r.out.includes(
          "could not be restored: the gateway registry did not report its active selection",
        ),
      ).toBe(postOperationState === "marker-omitted");
      expect(lines.includes("gateway select nemoclaw-8081")).toBe(mutationExpected);
      expect(lines.includes("sandbox delete -g nemoclaw-8081 alpha")).toBe(mutationExpected);
      expect(lines.includes("gateway remove nemoclaw-8081")).toBe(
        cleanupGateway && !failDelete && !missingActive,
      );
      expect(fs.readFileSync(activeGateway, "utf8").trim()).toBe(
        concurrentSelection
          ? "new-gateway"
          : postOperationState === "no-active-target-present"
            ? ""
            : failRestoration ||
                (postOperationState !== "" && postOperationState !== "already-restored")
              ? "nemoclaw-8081"
              : "survivor-gateway",
      );
      expect(r.out.includes("openshell gateway select survivor-gateway")).toBe(
        failRestoration ||
          postOperationState === "marker-omitted" ||
          postOperationState === "no-active-target-present",
      );
      expect(r.out.includes("delete failed")).toBe(failDelete);
      expect(fs.existsSync(removedGateway)).toBe(cleanupGateway && !failDelete && !missingActive);
      const restoreIndex = lines.lastIndexOf("gateway select survivor-gateway");
      const mutationIndex = Math.max(
        lines.indexOf("sandbox delete -g nemoclaw-8081 alpha"),
        lines.indexOf("gateway remove nemoclaw-8081"),
      );
      expect(restoreIndex > mutationIndex).toBe(restorationExpected);
      expect(lines.includes("gateway select survivor-gateway")).toBe(
        !concurrentSelection && !missingActive && postOperationState === "",
      );
      expect(r.out.includes("gateway registry could not be re-read:")).toBe(
        postOperationState === "list-failure",
      );
      expect(r.out.includes("Check OpenShell connectivity")).toBe(
        postOperationState === "list-failure",
      );
      expect(r.out.includes("previously active gateway is no longer registered")).toBe(
        postOperationState === "prior-missing",
      );
      expect(r.out.includes("openshell gateway list")).toBe(
        postOperationState === "prior-missing" || postOperationState === "list-failure",
      );
      expect(
        r.out.includes("there is no active gateway while the temporary target remains registered"),
      ).toBe(postOperationState === "no-active-target-present");
    },
  );

  it("selects the sandbox persisted gateway before provider cleanup and delete", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-destroy-select-gateway-"));
    const localBin = path.join(home, "bin");
    const registryDir = path.join(home, ".nemoclaw");
    const openshellLog = path.join(home, "openshell.log");
    const activeGateway = path.join(home, "active-gateway");
    fs.mkdirSync(localBin, { recursive: true });
    fs.mkdirSync(registryDir, { recursive: true });
    fs.writeFileSync(activeGateway, "other-gateway\n");
    fs.writeFileSync(
      path.join(registryDir, "sandboxes.json"),
      JSON.stringify({
        sandboxes: {
          alpha: {
            name: "alpha",
            model: "test-model",
            provider: "nvidia-prod",
            gpuEnabled: false,
            agent: "langchain-deepagents-code",
            gatewayName: "nemoclaw-8081",
            gatewayPort: 8081,
          },
        },
        defaultSandbox: "alpha",
      }),
      { mode: 0o600 },
    );
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/bin/sh",
        ...confirmSandboxMissingAfterDelete(path.join(home, "sandbox-deleted"), openshellLog),
        `log_file=${JSON.stringify(openshellLog)}`,
        `active_gateway=${JSON.stringify(activeGateway)}`,
        'printf \'%s\\n\' "$*" >> "$log_file"',
        'if [ "$1" = "gateway" ] && [ "$2" = "select" ]; then',
        '  printf "%s\\n" "$3" > "$active_gateway"',
        "  exit 0",
        "fi",
        'if [ "$1" = "sandbox" ] && [ "$2" = "delete" ]; then',
        '  active="$(cat "$active_gateway")"',
        '  if [ "$active" != "nemoclaw-8081" ]; then',
        '    printf "wrong gateway: %s\\n" "$active" >&2',
        "    exit 42",
        "  fi",
        "  exit 0",
        "fi",
        'if [ "$1" = "sandbox" ] && [ "$2" = "list" ]; then',
        '  active="$(cat "$active_gateway")"',
        '  if [ "$active" != "nemoclaw-8081" ]; then',
        '    printf "wrong list gateway: %s\\n" "$active" >&2',
        "    exit 43",
        "  fi",
        '  printf "NAME STATUS\\n"',
        "  exit 0",
        "fi",
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );
    fs.writeFileSync(path.join(localBin, "docker"), LIVE_DOCKER_IDENTITY, {
      mode: 0o755,
    });

    const r = runWithEnv("alpha destroy --yes", {
      HOME: home,
      NEMOCLAW_CLEANUP_GATEWAY: "0",
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });

    expect(r.code, r.out).toBe(0);
    const lines = fs.readFileSync(openshellLog, "utf8").trim().split("\n");
    const selectIndex = lines.indexOf("gateway select nemoclaw-8081");
    const wipeIndex = lines.findIndex(isPersistentStateWipeExec);
    const deleteIndex = lines.indexOf("sandbox delete -g nemoclaw-8081 alpha");
    expect(selectIndex).toBeGreaterThanOrEqual(0);
    expect(wipeIndex).toBeGreaterThan(selectIndex);
    expect(deleteIndex).toBeGreaterThan(wipeIndex);
    expect(lines.slice(deleteIndex + 1)).toContain("sandbox get -g nemoclaw-8081 alpha");
  });

  // NemoClaw clears the native home before OpenShell deletes storage. Gateway
  // teardown still follows the completed delete.
  it(
    "destroys with --cleanup-gateway and runs gateway-select -> delete -> gateway-destroy in order",
    testTimeoutOptions(30_000),
    () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-destroy-cleanup-order-"));
      const localBin = path.join(home, "bin");
      const registryDir = path.join(home, ".nemoclaw");
      const openshellLog = path.join(home, "openshell.log");
      fs.mkdirSync(localBin, { recursive: true });
      fs.mkdirSync(registryDir, { recursive: true });
      fs.writeFileSync(
        path.join(registryDir, "sandboxes.json"),
        JSON.stringify({
          sandboxes: {
            alpha: {
              name: "alpha",
              model: "test-model",
              provider: "nvidia-prod",
              gpuEnabled: false,
              agent: "langchain-deepagents-code",
              gatewayName: "nemoclaw-8081",
              gatewayPort: 8081,
            },
          },
          defaultSandbox: "alpha",
        }),
        { mode: 0o600 },
      );
      fs.writeFileSync(
        path.join(localBin, "openshell"),
        [
          "#!/bin/sh",
          ...confirmSandboxMissingAfterDelete(path.join(home, "sandbox-deleted"), openshellLog),
          `log_file=${JSON.stringify(openshellLog)}`,
          'printf \'%s\\n\' "$*" >> "$log_file"',
          'if [ "$1" = "sandbox" ] && [ "$2" = "list" ]; then',
          '  printf "NAME STATUS\\n"',
          "fi",
          "exit 0",
        ].join("\n"),
        { mode: 0o755 },
      );
      fs.writeFileSync(path.join(localBin, "docker"), LIVE_DOCKER_IDENTITY, {
        mode: 0o755,
      });
      fs.writeFileSync(path.join(localBin, "pgrep"), "#!/bin/sh\nexit 1\n", {
        mode: 0o755,
      });
      fs.writeFileSync(path.join(localBin, "lsof"), "#!/bin/sh\nexit 1\n", {
        mode: 0o755,
      });

      const r = runWithEnv(
        "alpha destroy -y --cleanup-gateway",
        { HOME: home, PATH: `${localBin}:${process.env.PATH || ""}` },
        30_000,
      );

      expect(r.code, r.out).toBe(0);
      const lines = fs.readFileSync(openshellLog, "utf8").trim().split("\n");
      const selectIndex = lines.indexOf("gateway select nemoclaw-8081");
      const wipeIndex = lines.findIndex(isPersistentStateWipeExec);
      const deleteIndex = lines.indexOf("sandbox delete -g nemoclaw-8081 alpha");
      const gatewayDestroyIndex = lines.findIndex(
        (line) =>
          line === "gateway remove nemoclaw-8081" || line === "gateway destroy -g nemoclaw-8081",
      );

      expect(selectIndex, "gateway select did not run").toBeGreaterThanOrEqual(0);
      expect(wipeIndex, "native-home cleanup did not run").toBeGreaterThan(selectIndex);
      expect(deleteIndex, "sandbox delete did not run").toBeGreaterThan(wipeIndex);
      expect(gatewayDestroyIndex, "gateway teardown did not run").toBeGreaterThan(deleteIndex);
    },
  );

  it("fails destroy when openshell sandbox delete returns a real error", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-destroy-failure-"));
    const localBin = path.join(home, "bin");
    const registryDir = path.join(home, ".nemoclaw");
    const openshellLog = path.join(home, "openshell.log");
    fs.mkdirSync(localBin, { recursive: true });
    fs.mkdirSync(registryDir, { recursive: true });
    fs.writeFileSync(
      path.join(registryDir, "sandboxes.json"),
      JSON.stringify({
        sandboxes: {
          alpha: {
            name: "alpha",
            model: "test-model",
            provider: "nvidia-prod",
            gpuEnabled: false,
            agent: "langchain-deepagents-code",
          },
        },
        defaultSandbox: "alpha",
      }),
      { mode: 0o600 },
    );
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/bin/sh",
        'if [ "$1" = "gateway" ] && [ "$2" = "list" ]; then',
        '  printf \'[{"name":"nemoclaw","active":true}]\\n\'',
        "  exit 0",
        "fi",
        `log_file=${JSON.stringify(openshellLog)}`,
        'printf \'%s\\n\' "$*" >> "$log_file"',
        'if [ "$1" = "sandbox" ] && [ "$2" = "delete" ]; then',
        '  echo "transport error: no active gateway configured" >&2',
        "  exit 1",
        "fi",
        'if [ "$1" = "sandbox" ] && [ "$2" = "list" ]; then',
        '  printf "NAME STATUS\\nalpha Ready\\n"',
        "  exit 0",
        "fi",
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );
    fs.writeFileSync(path.join(localBin, "docker"), LIVE_DOCKER_IDENTITY, {
      mode: 0o755,
    });

    const r = runWithEnv("alpha destroy --yes", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });

    const openshellFailureLog = fs.readFileSync(openshellLog, "utf8");
    expect(r.code, r.out).toBe(1);
    expect(r.out).toContain("transport error: no active gateway configured");
    expect(r.out).toContain("Failed to destroy sandbox 'alpha'.");
    expect(r.out).not.toContain("Sandbox 'alpha' destroyed");

    const registryAfter = JSON.parse(
      fs.readFileSync(path.join(registryDir, "sandboxes.json"), "utf8"),
    );
    expect(registryAfter.sandboxes.alpha).toBeTruthy();
    expect(openshellFailureLog).toContain("sandbox delete -g nemoclaw alpha");
    expect(openshellFailureLog).not.toContain("gateway destroy -g nemoclaw");
    expect(openshellFailureLog).not.toContain("gateway remove nemoclaw");
  });

  it(
    "treats an already-missing sandbox as destroyed using the platform gateway default (#4662)",
    testTimeoutOptions(30_000),
    () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-destroy-missing-"));
      const localBin = path.join(home, "bin");
      const registryDir = path.join(home, ".nemoclaw");
      const openshellLog = path.join(home, "openshell.log");
      const bashLog = path.join(home, "docker.log");
      fs.mkdirSync(localBin, { recursive: true });
      fs.mkdirSync(registryDir, { recursive: true });
      fs.writeFileSync(
        path.join(registryDir, "sandboxes.json"),
        JSON.stringify({
          sandboxes: {
            alpha: {
              name: "alpha",
              model: "test-model",
              provider: "nvidia-prod",
              gpuEnabled: false,
              agent: "langchain-deepagents-code",
            },
          },
          defaultSandbox: "alpha",
        }),
        { mode: 0o600 },
      );
      fs.writeFileSync(
        path.join(localBin, "openshell"),
        [
          "#!/bin/sh",
          'if [ "$1" = "gateway" ] && [ "$2" = "list" ]; then',
          '  printf \'[{"name":"nemoclaw","active":true}]\\n\'',
          "  exit 0",
          "fi",
          `log_file=${JSON.stringify(openshellLog)}`,
          'if [ "$1" = "sandbox" ] && [ "$2" = "delete" ]; then',
          '  printf \'%s\\n\' "$*" >> "$log_file"',
          '  echo "Error: status: Not Found, message: \\"sandbox not found\\"" >&2',
          "  exit 1",
          "fi",
          'if [ "$1" = "sandbox" ] && [ "$2" = "list" ]; then',
          '  printf "NAME STATUS\\n" >> "$log_file"',
          '  printf "NAME STATUS\\n"',
          "  exit 0",
          "fi",
          'printf \'%s\\n\' "$*" >> "$log_file"',
          "exit 0",
        ].join("\n"),
        { mode: 0o755 },
      );
      fs.writeFileSync(
        path.join(localBin, "docker"),
        [
          "#!/bin/sh",
          `log_file=${JSON.stringify(bashLog)}`,
          'printf \'%s\\n\' "$*" >> "$log_file"',
          "exit 0",
        ].join("\n"),
        { mode: 0o755 },
      );

      const r = runWithEnv("alpha destroy --yes", {
        HOME: home,
        PATH: `${localBin}:${process.env.PATH || ""}`,
      });

      expect(r.code, r.out).toBe(0);
      expect(r.out).toContain("already absent from the live gateway");
      expect(r.out).toContain("Sandbox 'alpha' destroyed");

      const registryAfter = JSON.parse(
        fs.readFileSync(path.join(registryDir, "sandboxes.json"), "utf8"),
      );
      expect(registryAfter.sandboxes.alpha).toBeFalsy();
      expect(fs.readFileSync(openshellLog, "utf8")).toContain("sandbox delete -g nemoclaw alpha");
      const openshellOutput = fs.readFileSync(openshellLog, "utf8");
      const dockerOutput = fs.readFileSync(bashLog, "utf8");
      const shouldCleanupGateway = process.platform === "darwin";
      expect(openshellOutput).not.toContain("forward stop 18789");
      expect(openshellOutput.includes("gateway remove nemoclaw")).toBe(shouldCleanupGateway);
      expect(dockerOutput.includes("volume ls -q --filter name=openshell-cluster-nemoclaw")).toBe(
        shouldCleanupGateway,
      );
      expect(openshellOutput).not.toContain("gateway destroy -g nemoclaw");
    },
  );

  it("deletes messaging providers when destroying a sandbox", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-destroy-providers-"));
    const localBin = path.join(home, "bin");
    const registryDir = path.join(home, ".nemoclaw");
    const openshellLog = path.join(home, "openshell.log");
    const bashLog = path.join(home, "docker.log");
    fs.mkdirSync(localBin, { recursive: true });
    fs.mkdirSync(registryDir, { recursive: true });
    fs.writeFileSync(
      path.join(registryDir, "sandboxes.json"),
      JSON.stringify({
        sandboxes: {
          alpha: {
            name: "alpha",
            model: "test-model",
            provider: "nvidia-prod",
            gpuEnabled: false,
            agent: "langchain-deepagents-code",
          },
        },
        defaultSandbox: "alpha",
      }),
      { mode: 0o600 },
    );
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/bin/sh",
        ...confirmSandboxMissingAfterDelete(path.join(home, "sandbox-deleted"), openshellLog),
        `log_file=${JSON.stringify(openshellLog)}`,
        'if [ "$1" = "sandbox" ] && [ "$2" = "list" ]; then',
        '  printf "NAME STATUS\\n" >> "$log_file"',
        "  exit 0",
        "fi",
        'printf \'%s\\n\' "$*" >> "$log_file"',
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );
    fs.writeFileSync(
      path.join(localBin, "docker"),
      [
        "#!/bin/sh",
        `log_file=${JSON.stringify(bashLog)}`,
        'printf \'%s\\n\' "$*" >> "$log_file"',
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );

    const r = runWithEnv("alpha destroy --yes", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
    });

    expect(r.code, r.out).toBe(0);
    const log = fs.readFileSync(openshellLog, "utf8");
    expect(log).toContain("provider delete alpha-telegram-bridge");
    expect(log).toContain("provider delete alpha-discord-bridge");
    expect(log).toContain("provider delete alpha-slack-bridge");
    expect(log).toContain("provider delete alpha-slack-app");
  });
});
