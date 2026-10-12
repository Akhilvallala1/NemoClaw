// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as registry from "./state/registry";
import { buildListCommandDeps } from "./list-command-deps";

function writeExecutable(target: string, body: string): void {
  fs.writeFileSync(target, body, { mode: 0o755 });
}

describe("buildListCommandDeps active-session count", () => {
  let tmp: string;
  let openshell: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-list-deps-"));
    openshell = path.join(tmp, "openshell");
    vi.stubEnv("NEMOCLAW_OPENSHELL_BIN", openshell);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it.skipIf(process.platform !== "linux")(
    "counts sessions with gateway evidence and excludes a same-name sibling gateway",
    () => {
      writeExecutable(openshell, "#!/usr/bin/env bash\nexit 0\n");
      const sandboxName = `list-count-${process.pid}`;
      vi.spyOn(registry, "getSandbox").mockReturnValue({
        name: sandboxName,
        gatewayName: "nemoclaw",
      } as never);
      const command = `openshell sandbox exec --name ${sandboxName} --tty -- /bin/bash -i`;
      const startSession = (gateway: string) =>
        spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
          argv0: command,
          env: { ...process.env, OPENSHELL_GATEWAY: gateway },
          stdio: "ignore",
        });
      const selected = startSession("nemoclaw");
      const sibling = startSession("nemoclaw-9090");
      try {
        const deps = buildListCommandDeps();
        expect(deps.getActiveSessionCount?.(sandboxName)).toBe(1);
      } finally {
        selected.kill();
        sibling.kill();
      }
    },
  );
});
