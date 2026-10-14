// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  validateInstallerSources,
  readOpenShellTrustRegistry,
} from "../../scripts/checks/extract-installer-pins.mts";
import { parseOpenShellTrustRegistry } from "../../scripts/checks/openshell-trust-data.mts";
import { isDeepStrictEqual } from "node:util";
import { readCandidateUpgradeSource } from "./candidate-upgrade-admission.mts";
import { githubRequest } from "./base-image-publication.mts";
import {
  CANDIDATE_OPENSHELL_SOURCES as SOURCE_PATHS,
  CANDIDATE_OPENSHELL_TRUST_PATH,
  reviewedCandidateOpenShellTrust,
} from "./candidate-openshell-trust.mts";

// Runs from the trusted workflow checkout, before any candidate code executes.
// Candidate files are inert inputs to the existing release/template verifier.
export async function candidateOpenShellVersion(
  repository: string,
  candidateSha: string,
  request: (path: string) => Promise<unknown>,
  review?: { prNumber: number; baseSha: string },
): Promise<string> {
  if (repository !== "NVIDIA/NemoClaw" || !/^[0-9a-f]{40}$/u.test(candidateSha)) {
    throw new Error("OpenShell selection requires an exact NVIDIA/NemoClaw candidate SHA");
  }
  const sources = {} as Record<keyof typeof SOURCE_PATHS, string>;
  for (const [key, sourcePath] of Object.entries(SOURCE_PATHS)) {
    sources[key as keyof typeof SOURCE_PATHS] = await readCandidateUpgradeSource(
      request,
      candidateSha,
      sourcePath,
    );
  }
  if (review) {
    const registry = parseOpenShellTrustRegistry(
      await readCandidateUpgradeSource(request, candidateSha, CANDIDATE_OPENSHELL_TRUST_PATH),
    );
    if (!isDeepStrictEqual(registry, readOpenShellTrustRegistry())) {
      const approved = await reviewedCandidateOpenShellTrust({ ...review, candidateSha }, request);
      return approved.selected.releaseVersion;
    }
  }
  return validateInstallerSources(sources).releaseVersion;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const output = process.env.GITHUB_OUTPUT;
  if (!output) throw new Error("GitHub output path is required");
  const version = await candidateOpenShellVersion(
    process.env.CANDIDATE_REPOSITORY ?? "",
    process.env.CANDIDATE_SHA ?? "",
    (url) => githubRequest(url, process.env.GITHUB_TOKEN ?? ""),
    process.env.UPGRADE_PR_NUMBER
      ? {
          prNumber: Number(process.env.UPGRADE_PR_NUMBER),
          baseSha: process.env.UPGRADE_BASE_SHA ?? "",
        }
      : undefined,
  );
  appendFileSync(output, `version=${version}\n`);
  console.log(`Reviewed candidate OpenShell release: ${version}`);
}
