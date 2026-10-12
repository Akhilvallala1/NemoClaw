// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { getChangedFiles } from "../advisors/git.mts";
import { buildRiskPlan, isPrE2ePlanningJob, type RiskPlan } from "../advisors/risk-plan.mts";
import { focusedE2eJobsForChangedFiles } from "../e2e/workflow-boundary.mts";

const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const PR_PATTERN = /^[1-9][0-9]*$/u;

export function deriveTrustedRiskPlan(input: {
  repo: string;
  prNumber?: string;
  baseSha: string;
  headSha: string;
}): RiskPlan {
  if (!REPO_PATTERN.test(input.repo)) throw new Error("Trusted risk plan requires a valid repo");
  if (input.prNumber && !PR_PATTERN.test(input.prNumber)) {
    throw new Error("Trusted risk plan requires a valid PR number");
  }
  if (!SHA_PATTERN.test(input.baseSha) || !SHA_PATTERN.test(input.headSha)) {
    throw new Error("Trusted risk plan requires full base and head SHAs");
  }

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "advisor-trusted-risk-plan-"));
  const git = (...args: string[]): string =>
    execFileSync("git", ["-C", directory, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    }).trim();
  try {
    git("init", "--quiet");
    git("config", "core.hooksPath", "/dev/null");
    git("config", "submodule.recurse", "false");
    git("remote", "add", "origin", `https://github.com/${input.repo}.git`);
    git(
      "fetch",
      "--no-tags",
      "--no-recurse-submodules",
      "origin",
      `${input.baseSha}:refs/remotes/origin/base`,
    );
    git(
      "fetch",
      "--no-tags",
      "--no-recurse-submodules",
      "origin",
      input.prNumber
        ? `refs/pull/${input.prNumber}/head:refs/remotes/origin/head`
        : `${input.headSha}:refs/remotes/origin/head`,
    );
    if (
      git("rev-parse", "refs/remotes/origin/base") !== input.baseSha ||
      git("rev-parse", "refs/remotes/origin/head") !== input.headSha
    ) {
      throw new Error("Trusted risk plan refs do not match the checked revision");
    }
    const changedFiles = getChangedFiles(
      "refs/remotes/origin/base",
      "refs/remotes/origin/head",
      directory,
    );
    return buildRiskPlan({
      headSha: input.headSha,
      changedFiles,
      focusedE2eJobs: focusedE2eJobsForChangedFiles(changedFiles).filter((selection) =>
        isPrE2ePlanningJob(selection.id),
      ),
    });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const output = process.env.PR_REVIEW_ADVISOR_TRUSTED_PLAN_PATH;
  if (!output) throw new Error("Trusted risk plan requires an output path");
  const plan = deriveTrustedRiskPlan({
    repo: process.env.TARGET_REPO ?? "",
    prNumber: process.env.PR_NUMBER || undefined,
    baseSha: process.env.EXPECTED_BASE_SHA ?? "",
    headSha: process.env.EXPECTED_HEAD_SHA ?? "",
  });
  fs.writeFileSync(output, JSON.stringify(plan), { flag: "wx", mode: 0o600 });
}
