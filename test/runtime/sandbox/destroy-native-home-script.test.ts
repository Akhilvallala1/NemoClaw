// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, onTestFinished } from "vitest";

import { wipeAgentNativeHome } from "../../../src/lib/actions/sandbox/destroy-execution";

function cleanupFixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "native-home-script-"));
  onTestFinished(() => fs.rmSync(directory, { recursive: true, force: true }));
  const root = path.join(directory, "sandbox");
  fs.mkdirSync(root);
  let command: readonly string[] = [];
  wipeAgentNativeHome(
    "alpha",
    "langchain-deepagents-code",
    (args) => {
      command = args.slice(args.indexOf("--") + 1);
      return { status: 0, stdout: "", stderr: "" };
    },
    undefined,
  );
  // Execute the production shell with only its filesystem root relocated.
  const script = command[2]!.replace("root='/sandbox'", 'root="$NATIVE_HOME_FIXTURE"');
  const protectedPaths = command.slice(4).map((entry) => entry.replace("/sandbox", root));
  const run = (rmMode = "normal") =>
    spawnSync(
      "sh",
      [
        "-c",
        [
          "rm() {",
          '  case "$3" in',
          '    */.a-denied) case "$NATIVE_HOME_RM_MODE" in denied) return 1;; retained) return 0;; esac;;',
          "  esac",
          '  /bin/rm "$@"',
          "}",
          script,
        ].join("\n"),
        command[3]!,
        ...protectedPaths,
      ],
      {
        encoding: "utf8",
        timeout: 5_000,
        env: { ...process.env, NATIVE_HOME_FIXTURE: root, NATIVE_HOME_RM_MODE: rmMode },
      },
    );
  return { directory, root, run };
}

describe("native-home cleanup shell", () => {
  it.each([
    { mode: "normal", status: 0, remains: false },
    { mode: "denied", status: 1, remains: true },
    { mode: "retained", status: 22, remains: true },
  ])("finishes eligible entries and verifies remaining state after $mode removal", (testCase) => {
    const { root, run } = cleanupFixture();
    fs.mkdirSync(path.join(root, ".deepagents"));
    const protectedFile = path.join(root, ".deepagents", ".env");
    fs.writeFileSync(protectedFile, "synthetic protected configuration");
    fs.writeFileSync(path.join(root, ".a-denied"), "first entry");
    fs.writeFileSync(path.join(root, "z-owned"), "later entry");

    const result = run(testCase.mode);

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(testCase.status);
    expect(fs.existsSync(path.join(root, "z-owned"))).toBe(false);
    expect(fs.existsSync(path.join(root, ".a-denied"))).toBe(testCase.remains);
    expect(fs.readFileSync(protectedFile, "utf8")).toBe("synthetic protected configuration");
    expect(run().status).toBe(0);
    expect(fs.existsSync(path.join(root, ".a-denied"))).toBe(false);
    expect(fs.readFileSync(protectedFile, "utf8")).toBe("synthetic protected configuration");
  });

  it.each([
    {
      target: "root",
      status: 20,
      linkPath: (root: string) => {
        fs.rmdirSync(root);
        return root;
      },
    },
    {
      target: "protected ancestor",
      status: 21,
      linkPath: (root: string) => path.join(root, ".deepagents"),
    },
  ])("refuses a symlink at the $target without following it", ({ linkPath, status }) => {
    const { directory, root, run } = cleanupFixture();
    const outside = path.join(directory, "outside");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "retained"), "outside state");
    fs.symlinkSync(outside, linkPath(root));

    const result = run();

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(status);
    expect(fs.readFileSync(path.join(outside, "retained"), "utf8")).toBe("outside state");
  });
});
