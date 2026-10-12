// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect, it, onTestFinished } from "vitest";

import type { TrustedE2eRecommendationInventory } from "../../../tools/advisors/e2e-recommendations.mts";
import { buildRiskPlan } from "../../../tools/advisors/risk-plan.mts";
import { evaluateAdvisorBlockers } from "../../../tools/pr-review-advisor/blocker-gate.mts";
import {
  buildReviewQueueContext,
  buildSpecialistE2eReceipt,
} from "../../../tools/pr-review-advisor/e2e-receipt.mts";
import { buildAdvisorFindingLedger } from "../../../tools/pr-review-advisor/finding-ledger.mts";
import { ADVISOR_INTERESTS } from "../../../tools/pr-review-advisor/specialist-catalog.mts";

const HEAD_SHA = "a".repeat(40);
const BASE_SHA = "b".repeat(40);
const ATTEMPT = "2";
const inventory: TrustedE2eRecommendationInventory = {
  workflow: "e2e.yaml",
  fanoutId: "e2e-all",
  selectorTypes: ["all", "target", "job"],
  allowedJobIds: [],
  manualOnlyJobIds: [],
  liveSupportedTargetIds: [],
};
const riskPlan = buildRiskPlan({ headSha: HEAD_SHA, changedFiles: ["docs/example.mdx"] });
const expectedSpecialists = [...ADVISOR_INTERESTS].sort();

function artifactTree(
  options: {
    findingInterest?: string;
    unresolvedInterest?: string;
    changedFiles?: string[];
    invalidJobId?: "markdown" | "numeric";
    omitRequiredJob?: boolean;
  } = {},
): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "advisor-blocker-gate-"));
  onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
  const selectedRiskPlan = structuredClone(
    options.changedFiles
      ? buildRiskPlan({ headSha: HEAD_SHA, changedFiles: options.changedFiles })
      : riskPlan,
  );
  selectedRiskPlan.requiredJobs = selectedRiskPlan.requiredJobs.map((job, index) => ({
    ...job,
    id:
      index === 0 && options.invalidJobId === "markdown"
        ? "staging-brev-launchable\n# forged summary"
        : index === 0 && options.invalidJobId === "numeric"
          ? (123 as unknown as string)
          : job.id,
  }));
  const { planHash: originalPlanHash, ...withoutHash } = selectedRiskPlan;
  selectedRiskPlan.planHash =
    options.invalidJobId === "numeric"
      ? createHash("sha256").update(JSON.stringify(withoutHash)).digest("hex")
      : originalPlanHash;
  const selectedInventory = {
    ...inventory,
    allowedJobIds: selectedRiskPlan.requiredJobs.map((job) => job.id),
    liveSupportedTargetIds: selectedRiskPlan.requiredTargets.map((target) => target.id),
  };
  const context = buildReviewQueueContext(
    {
      baseSha: BASE_SHA,
      expectedSpecialists,
      riskPlan: selectedRiskPlan,
      inventory: selectedInventory,
    },
    {},
  );
  const writtenContext = options.omitRequiredJob
    ? {
        ...context,
        deterministic: {
          ...context.deterministic,
          requiredJobs: context.deterministic.requiredJobs.slice(1),
        },
      }
    : context;
  for (const interest of expectedSpecialists) {
    const directory = path.join(root, `pr-review-specialist-${interest}-${ATTEMPT}`);
    fs.mkdirSync(directory);
    const findings =
      interest === options.findingInterest
        ? [
            {
              severity: "P1" as const,
              kind: "security" as const,
              summary: "A credential can be exposed.",
              path: "src/lib/example.ts",
              line: 42,
              impact: "A caller can read the credential.",
              smallestSafeFix: "Remove the credential from output.",
              regressionTest: "Assert the credential is redacted.",
              exclusions: ["security-sensitive" as const],
            },
          ]
        : [];
    const ledger = buildAdvisorFindingLedger({
      headSha: HEAD_SHA,
      interest,
      input: {
        findings,
        noFindingsReason: findings.length === 0 ? "No P0/P1 blocker remains." : null,
      },
    });
    const receipt = buildSpecialistE2eReceipt({
      baseSha: BASE_SHA,
      expectedSpecialists,
      riskPlan: selectedRiskPlan,
      inventory: selectedInventory,
      interest,
      advisor: {
        recommendations: [],
        noAdditionalE2eReason:
          interest === options.unresolvedInterest ? null : "No additional E2E is needed.",
        unresolvedRecommendations:
          interest === options.unresolvedInterest
            ? ["No supported target covers the security boundary."]
            : [],
      },
    });
    fs.writeFileSync(
      path.join(directory, "review-queue-context.json"),
      JSON.stringify(writtenContext),
    );
    fs.writeFileSync(
      path.join(directory, `pr-review-${interest}-findings.json`),
      JSON.stringify(ledger),
    );
    fs.writeFileSync(
      path.join(directory, `pr-review-${interest}-e2e.json`),
      JSON.stringify(receipt),
    );
  }
  return root;
}

function evaluate(root: string) {
  return evaluateAdvisorBlockers({
    artifactsRoot: root,
    attempt: ATTEMPT,
    expectedHeadSha: HEAD_SHA,
    expectedBaseSha: BASE_SHA,
  });
}

it("passes only complete, canonical, clear Advisor evidence", () => {
  expect(evaluate(artifactTree())).toEqual({
    status: "clear",
    findingCount: 0,
    unresolvedRecommendationCount: 0,
    findingInterests: [],
    unresolvedInterests: [],
    recommendations: [],
  });
});

it("reports the Brev E2E selection even when the Advisor gate blocks", () => {
  const root = artifactTree({
    changedFiles: ["src/lib/actions/sandbox/connect.ts"],
    unresolvedInterest: "delivery-flow",
  });
  const recommendations = evaluate(root).recommendations;
  expect(recommendations).toContainEqual(
    expect.objectContaining({ selectorType: "job", id: "staging-brev-launchable", required: true }),
  );

  const summary = path.join(root, "step-summary.md");
  const child = spawnSync(
    process.execPath,
    [
      "--no-warnings",
      path.resolve("tools/pr-review-advisor/blocker-gate.mts"),
      "--attempt",
      ATTEMPT,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        EXPECTED_BASE_SHA: BASE_SHA,
        EXPECTED_HEAD_SHA: HEAD_SHA,
        PR_REVIEW_ADVISOR_ARTIFACTS: root,
        GITHUB_STEP_SUMMARY: summary,
      },
    },
  );
  expect(child.error).toBeUndefined();
  expect(child.status).toBe(1);
  const summaryText = fs.readFileSync(summary, "utf8");
  expect(summaryText).toContain("Required: `job:staging-brev-launchable`");
  expect(summaryText).toContain("selection only; no execution evidence");
});

it("rejects a mutated selector in the deterministic risk plan", () => {
  const root = artifactTree({
    changedFiles: ["src/lib/actions/sandbox/connect.ts"],
    invalidJobId: "markdown",
  });
  expect(() => evaluate(root)).toThrow("invalid deterministic risk plan");
});

it("rejects a non-string selector ID even with a matching risk-plan digest", () => {
  const root = artifactTree({
    changedFiles: ["src/lib/actions/sandbox/connect.ts"],
    invalidJobId: "numeric",
  });
  expect(() => evaluate(root)).toThrow("invalid selector");
});

it("rejects a missing required selector when the risk-plan digest is unchanged", () => {
  const root = artifactTree({
    changedFiles: ["src/lib/actions/sandbox/connect.ts"],
    omitRequiredJob: true,
  });
  expect(() => evaluate(root)).toThrow("invalid deterministic risk plan");
});

it("blocks a P0/P1 finding from any specialist", () => {
  const interest = "security-built-in-quality";
  expect(evaluate(artifactTree({ findingInterest: interest }))).toMatchObject({
    status: "blocked",
    findingCount: 1,
    findingInterests: [interest],
  });
});

it("blocks an unresolved E2E recommendation from any specialist", () => {
  const interest = "security-built-in-quality";
  expect(evaluate(artifactTree({ unresolvedInterest: interest }))).toMatchObject({
    status: "blocked",
    unresolvedRecommendationCount: 1,
    unresolvedInterests: [interest],
  });
});

it.each([
  ["clear", undefined, 0],
  ["blocked", "security-built-in-quality", 1],
] as const)(
  "returns CLI exit status for %s evidence",
  (_result, findingInterest, expectedStatus) => {
    const child = spawnSync(
      process.execPath,
      [
        "--no-warnings",
        path.resolve("tools/pr-review-advisor/blocker-gate.mts"),
        "--attempt",
        ATTEMPT,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          EXPECTED_BASE_SHA: BASE_SHA,
          EXPECTED_HEAD_SHA: HEAD_SHA,
          PR_REVIEW_ADVISOR_ARTIFACTS: artifactTree({ findingInterest }),
        },
      },
    );

    expect(child.error).toBeUndefined();
    expect(child.status).toBe(expectedStatus);
  },
);

const specialistEvidenceFiles = [
  ["review queue context", (_interest: string) => "review-queue-context.json"],
  ["finding ledger", (interest: string) => `pr-review-${interest}-findings.json`],
  ["E2E receipt", (interest: string) => `pr-review-${interest}-e2e.json`],
] as const;

const invalidEvidenceMutations = [
  ["missing", (file: string) => fs.unlinkSync(file)],
  ["malformed", (file: string) => fs.writeFileSync(file, "{}")],
  [
    "symlinked",
    (file: string) => {
      const target = `${file}.target`;
      fs.renameSync(file, target);
      fs.symlinkSync(target, file);
    },
  ],
] as const;

it.each(
  specialistEvidenceFiles.flatMap(([artifactType, fileName]) =>
    invalidEvidenceMutations.map(
      ([variant, mutate]) => [artifactType, variant, fileName, mutate] as const,
    ),
  ),
)("fails closed for a %s that is %s", (_artifactType, _variant, fileName, mutate) => {
  const root = artifactTree();
  const interest = expectedSpecialists[0]!;
  const file = path.join(root, `pr-review-specialist-${interest}-${ATTEMPT}`, fileName(interest));
  mutate(file);
  expect(() => evaluate(root)).toThrow();
});

it("rejects evidence for a different checked commit", () => {
  expect(() =>
    evaluateAdvisorBlockers({
      artifactsRoot: artifactTree(),
      attempt: ATTEMPT,
      expectedHeadSha: "c".repeat(40),
      expectedBaseSha: BASE_SHA,
    }),
  ).toThrow("head SHA does not match");
});

it.each([
  ["head", { expectedBaseSha: BASE_SHA }],
  ["base", { expectedHeadSha: HEAD_SHA }],
])("requires the expected %s SHA", (label, expected) => {
  expect(() =>
    evaluateAdvisorBlockers({
      artifactsRoot: artifactTree(),
      attempt: ATTEMPT,
      ...expected,
    }),
  ).toThrow(`requires expected ${label} SHA`);
});
