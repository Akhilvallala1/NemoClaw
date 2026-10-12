// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  type CompositeAction,
  readYaml,
  type WorkflowJob,
  type WorkflowStep,
} from "../../helpers/e2e-workflow-contract";

type PrWorkflow = { jobs: Record<string, WorkflowJob> };

const workflow = readYaml<PrWorkflow>(".github/workflows/pr.yaml");
const action = readYaml<CompositeAction>(".github/actions/ci-static-checks/action.yaml");
const docsStep = workflow.jobs["docs-only-checks"].steps?.find(
  (step) => step.name === "Install hadolint",
);
const staticStep = action.runs.steps.find((step) => step.name === "Install hadolint");

function exerciseInstall(step: WorkflowStep, trustedAction: boolean) {
  const root = mkdtempSync(join(tmpdir(), "nemoclaw-hadolint-pin-"));
  try {
    const bin = join(root, "bin");
    const target = join(root, "hadolint");
    const curlArgs = join(root, "curl-args");
    const untrustedMarker = join(root, "untrusted-pin-ran");
    const workspace = join(root, "workspace");
    const actionPath = join(root, "trusted", ".github", "actions", "ci-static-checks");
    const version = "9.9.9";
    const pin = `HADOLINT_VERSION=${version}\nHADOLINT_LINUX_X86_64_SHA256=6bf226944684f56c84dd014e8b979d27425c0148f61b3bd99bcc6f39e9dc5a47\n`;
    const sparseCheckout = String(
      workflow.jobs["static-checks"].steps?.find(
        (candidate) => candidate.name === "Checkout trusted CI actions",
      )?.with?.["sparse-checkout"] ?? "",
    );

    mkdirSync(bin);
    mkdirSync(join(root, ".github"));
    mkdirSync(join(workspace, ".github"), { recursive: true });
    mkdirSync(actionPath, { recursive: true });
    writeFileSync(join(root, ".github", "hadolint.env"), pin);
    writeFileSync(
      join(root, "trusted", ".github", "hadolint.env"),
      trustedAction &&
        sparseCheckout
          .split("\n")
          .map((line) => line.trim())
          .includes(".github/hadolint.env")
        ? pin
        : "",
    );
    writeFileSync(
      join(workspace, ".github", "hadolint.env"),
      'touch "$HADOLINT_UNTRUSTED_MARKER"\nHADOLINT_VERSION=0.0.0\n',
    );
    writeFileSync(
      join(bin, "curl"),
      '#!/bin/sh\nprintf "%s\\n" "$*" > "$HADOLINT_CURL_ARGS"\nprintf fake > "$HADOLINT_TARGET"\n',
      { mode: 0o755 },
    );
    writeFileSync(
      join(bin, "sha256sum"),
      '#!/bin/sh\nprintf "%s  %s\\n" 6bf226944684f56c84dd014e8b979d27425c0148f61b3bd99bcc6f39e9dc5a47 "$1"\n',
      { mode: 0o755 },
    );

    const result = spawnSync(
      "/bin/bash",
      ["-c", step.run?.replaceAll("/usr/local/bin/hadolint", target) ?? ""],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          GITHUB_ACTION_PATH: actionPath,
          GITHUB_WORKSPACE: workspace,
          HADOLINT_CURL_ARGS: curlArgs,
          HADOLINT_TARGET: target,
          HADOLINT_UNTRUSTED_MARKER: untrustedMarker,
          HOME: root,
          PATH: `${bin}:/opt/homebrew/bin:/usr/bin:/bin`,
        },
        timeout: 5_000,
      },
    );

    expect(result.status, String(result.stdout) + String(result.stderr)).toBe(0);
    expect(readFileSync(curlArgs, "utf8")).toContain(
      `https://github.com/hadolint/hadolint/releases/download/v${version}/hadolint-linux-x86_64`,
    );
    expect(existsSync(untrustedMarker)).toBe(false);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}

describe("Hadolint CI pin", () => {
  it.each([
    ["docs-only", docsStep, false],
    ["base-trusted static action", staticStep, true],
  ] as const)("uses the pinned release URL in %s", (_name, step, trustedAction) => {
    expect(step).toBeDefined();
    exerciseInstall(step!, trustedAction);
  });
});
