// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  readOpenShellTrustRegistry,
  resolveOpenShellTrustRegistry,
  installerReleaseTsv,
  readInstallerInput,
  validateInstallerSources,
} from "../../scripts/checks/extract-installer-pins.mts";
import {
  readApprovedCandidateUpgrade,
  type CandidateUpgradeIdentity,
  type UpgradeRequest,
} from "./candidate-upgrade-admission.mts";
import { pathToFileURL } from "node:url";
import { isAbsolute, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { githubRequest } from "./base-image-publication.mts";
import { parseOpenShellTrustRegistry } from "../../scripts/checks/openshell-trust-data.mts";

export const CANDIDATE_OPENSHELL_TRUST_PATH = "ci/openshell-upgrade-trust.json";
export const CANDIDATE_OPENSHELL_SOURCES = {
  blueprintSource: "nemoclaw-blueprint/blueprint.yaml",
  installerSource: "scripts/install-openshell.sh",
  brevInstallerSource: "scripts/brev-launchable-ci-cpu.sh",
  supervisorRuntimeSource: "src/lib/onboard/docker-driver-gateway-runtime.ts",
} as const;

/** Read the approved manifest and its consumers from the same immutable commit, without execution. */
export async function reviewedCandidateOpenShellTrust(
  identity: CandidateUpgradeIdentity,
  request: UpgradeRequest,
) {
  const admission = await readApprovedCandidateUpgrade(
    identity,
    [...Object.values(CANDIDATE_OPENSHELL_SOURCES), CANDIDATE_OPENSHELL_TRUST_PATH],
    request,
  );
  const registry = parseOpenShellTrustRegistry(admission.sources[CANDIDATE_OPENSHELL_TRUST_PATH]!);
  const releases = resolveOpenShellTrustRegistry(registry, readOpenShellTrustRegistry());
  const sources = Object.fromEntries(
    Object.entries(CANDIDATE_OPENSHELL_SOURCES).map(([key, path]) => [
      key,
      admission.sources[path]!,
    ]),
  ) as Record<keyof typeof CANDIDATE_OPENSHELL_SOURCES, string>;
  const selected = validateInstallerSources(sources, releases);
  if (!registry.releases.some((release) => release.version === selected.releaseVersion))
    throw new Error("Upgrade trust registry does not select the candidate release");
  return {
    registrySource: admission.sources[CANDIDATE_OPENSHELL_TRUST_PATH]!,
    sources,
    releases,
    selected,
    reviewer: admission.reviewer,
    commentId: admission.commentId,
  };
}

/** Verify unchanged base trust without a new approval; changed trust must pass live admission. */
export async function verifyCandidateInstallerTrust(
  root: string,
  identity: CandidateUpgradeIdentity,
  request: UpgradeRequest,
) {
  if (!isAbsolute(root))
    throw new Error("Candidate verification requires an absolute checkout root");
  const registrySource = readInstallerInput(
    join(root, CANDIDATE_OPENSHELL_TRUST_PATH),
    "candidate OpenShell registry",
  );
  const registry = parseOpenShellTrustRegistry(registrySource);
  const base = readOpenShellTrustRegistry();
  if (isDeepStrictEqual(registry, base)) {
    const sources = Object.fromEntries(
      Object.entries(CANDIDATE_OPENSHELL_SOURCES).map(([key, path]) => [
        key,
        readInstallerInput(join(root, path), path),
      ]),
    ) as Record<keyof typeof CANDIDATE_OPENSHELL_SOURCES, string>;
    return validateInstallerSources(sources, resolveOpenShellTrustRegistry(base));
  }
  const approved = await reviewedCandidateOpenShellTrust(identity, request);
  if (registrySource !== approved.registrySource)
    throw new Error("Candidate registry differs from the approved commit");
  assertCandidateInstallerCheckout(root, approved.sources);
  return approved.selected;
}

/** Refuse a green hash check for bytes other than the independently approved commit. */
export function assertCandidateInstallerCheckout(
  root: string,
  sources: Record<keyof typeof CANDIDATE_OPENSHELL_SOURCES, string>,
): void {
  if (!isAbsolute(root))
    throw new Error("Candidate verification requires an absolute checkout root");
  for (const [key, path] of Object.entries(CANDIDATE_OPENSHELL_SOURCES)) {
    if (readInstallerInput(join(root, path), path) !== sources[key as keyof typeof sources]) {
      throw new Error(`Candidate checkout differs from the approved commit: ${path}`);
    }
  }
}

// This command emits inert records only. The shell check still fetches and hashes
// upstream assets; it never executes the approved candidate installer.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 2 || !process.env.GITHUB_TOKEN)
    throw new Error("Candidate installer verification requires authenticated GitHub access");
  const selected = await verifyCandidateInstallerTrust(
    process.env.UPGRADE_CANDIDATE_ROOT ?? "",
    {
      prNumber: Number(process.env.UPGRADE_PR_NUMBER),
      candidateSha: process.env.UPGRADE_CANDIDATE_SHA ?? "",
      baseSha: process.env.UPGRADE_BASE_SHA ?? "",
    },
    (url) => githubRequest(url, process.env.GITHUB_TOKEN!),
  );
  process.stdout.write(installerReleaseTsv(selected));
}
