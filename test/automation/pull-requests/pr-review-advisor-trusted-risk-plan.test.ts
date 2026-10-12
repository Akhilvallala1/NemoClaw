// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect, it, onTestFinished } from "vitest";

import { readTrustedRiskPlan } from "../../../tools/pr-review-advisor/blocker-gate.mts";
import {
  deriveTrustedRiskPlan,
  writeTrustedRiskPlan,
} from "../../../tools/pr-review-advisor/trusted-risk-plan.mts";

function git(directory: string, ...args: string[]): string {
  return execFileSync("git", ["-C", directory, ...args], { encoding: "utf8" }).trim();
}

function fixture(): { root: string; remote: string; baseSha: string; headSha: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "advisor-trusted-plan-test-"));
  onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
  const remote = path.join(root, "remote.git");
  const source = path.join(root, "source");
  fs.mkdirSync(source);
  git(root, "init", "--quiet", "--bare", remote);
  git(source, "init", "--quiet");
  git(source, "config", "user.name", "Test Fixture");
  git(source, "config", "user.email", "fixture@example.com");
  git(source, "config", "commit.gpgsign", "false");
  git(source, "config", "core.hooksPath", "/dev/null");
  git(source, "remote", "add", "origin", remote);
  fs.writeFileSync(path.join(source, "README.md"), "base\n");
  git(source, "add", "README.md");
  git(source, "commit", "--quiet", "-m", "test: create base");
  const baseSha = git(source, "rev-parse", "HEAD");
  git(source, "push", "--quiet", "origin", "HEAD:refs/heads/main");
  const changedFile = path.join(source, "src/lib/actions/sandbox/connect.ts");
  fs.mkdirSync(path.dirname(changedFile), { recursive: true });
  fs.writeFileSync(changedFile, "export {};\n");
  git(source, "add", "src/lib/actions/sandbox/connect.ts");
  git(source, "commit", "--quiet", "-m", "test: change sandbox connection");
  const headSha = git(source, "rev-parse", "HEAD");
  git(source, "push", "--quiet", "origin", "HEAD:refs/pull/73/head");
  return { root, remote, baseSha, headSha };
}

it("writes required selectors from the fetched PR revision", () => {
  const { root, remote, baseSha, headSha } = fixture();
  const output = path.join(root, "trusted-plan.json");
  writeTrustedRiskPlan(
    output,
    { repo: "NVIDIA/NemoClaw", prNumber: "73", baseSha, headSha },
    { originUrl: remote },
  );
  const plan = readTrustedRiskPlan(output);
  expect(plan.headSha).toBe(headSha);
  expect(plan.changedFiles).toEqual(["src/lib/actions/sandbox/connect.ts"]);
  expect(plan.requiredJobs.map((job) => job.id)).toContain("staging-brev-launchable");
  expect(fs.statSync(output).mode & 0o777).toBe(0o600);
});

it("rejects a fetched PR ref that differs from the requested commit", () => {
  const { remote, baseSha } = fixture();
  expect(() =>
    deriveTrustedRiskPlan(
      { repo: "NVIDIA/NemoClaw", prNumber: "73", baseSha, headSha: "f".repeat(40) },
      { originUrl: remote },
    ),
  ).toThrow("refs do not match the checked revision");
});
