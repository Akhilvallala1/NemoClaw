// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  installerReleaseTsv,
  resolveOpenShellTrustRegistry,
  validateInstallerSources,
} from "../../../scripts/checks/extract-installer-pins.mts";
import { candidateOpenShellVersion } from "../../../tools/e2e/candidate-openshell-version.mts";
import {
  CANDIDATE_OPENSHELL_SOURCES,
  CANDIDATE_OPENSHELL_TRUST_PATH,
  reviewedCandidateOpenShellTrust,
  assertCandidateInstallerCheckout,
  verifyCandidateInstallerTrust,
} from "../../../tools/e2e/candidate-openshell-trust.mts";
import { parseOpenShellTrustRegistry } from "../../../scripts/checks/openshell-trust-data.mts";
import { copyTrustedInstallerVerifier } from "../../helpers/openshell-installer-template";

const identity = { prNumber: 123, candidateSha: "a".repeat(40), baseSha: "b".repeat(40) };
const version = "9.8.7";
const temporaryRoots: string[] = [];
afterEach(() =>
  temporaryRoots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })),
);

function fixture() {
  const sources = Object.fromEntries(
    Object.entries(CANDIDATE_OPENSHELL_SOURCES).map(([key, path]) => [
      key,
      readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8"),
    ]),
  ) as Record<keyof typeof CANDIDATE_OPENSHELL_SOURCES, string>;
  const current = validateInstallerSources(sources);
  const release = structuredClone(current.installerReleases[0]!);
  const prior = release.version;
  release.version = version;
  release.formula.url = `https://github.com/NVIDIA/OpenShell/releases/download/v${version}/openshell.rb`;
  release.sandboxBuilds = [{ required: false, sha256: "f".repeat(64) }];
  sources.blueprintSource = sources.blueprintSource.replaceAll(`"${prior}"`, `"${version}"`);
  sources.installerSource = sources.installerSource
    .replaceAll(`v${prior}:`, `v${version}:`)
    .replaceAll(`MIN_VERSION="${prior}"`, `MIN_VERSION="${version}"`)
    .replaceAll(`MAX_VERSION="${prior}"`, `MAX_VERSION="${version}"`)
    .replace(
      '  case "$digest" in',
      `  case "$digest" in\n    ${"f".repeat(64)})\n      printf '%s\\n' "${version}"\n      ;;`,
    );
  sources.brevInstallerSource = sources.brevInstallerSource
    .replaceAll(`v${prior}:`, `v${version}:`)
    .replaceAll(`OPENSHELL_VERSION="v${prior}"`, `OPENSHELL_VERSION="v${version}"`);
  const supervisorHeader =
    "const OPENSHELL_SUPERVISOR_MANIFEST_DIGESTS: Readonly<Record<string, string>> = {\n";
  sources.supervisorRuntimeSource = sources.supervisorRuntimeSource
    .replace(
      supervisorHeader,
      `${supervisorHeader}  "${version}": "${release.supervisor!.manifestDigest}",\n`,
    )
    .replace(
      `QUALIFIED_STABLE_OPENSHELL_VERSION = "${prior}"`,
      `QUALIFIED_STABLE_OPENSHELL_VERSION = "${version}"`,
    );
  const normalizedSupervisor = sources.supervisorRuntimeSource.replace(
    /(?<=const OPENSHELL_SUPERVISOR_MANIFEST_DIGESTS: Readonly<Record<string, string>> = \{\n)[\s\S]*?(?=\n\};)/u,
    "<normalized-supervisor-manifest-pins>",
  );
  release.supervisor!.runtimeTemplateSha256 = [
    createHash("sha256").update(normalizedSupervisor).digest("hex"),
  ];
  const files: Record<string, string> = Object.fromEntries(
    Object.entries(CANDIDATE_OPENSHELL_SOURCES).map(([key, path]) => [
      path,
      sources[key as keyof typeof sources],
    ]),
  );
  files[CANDIDATE_OPENSHELL_TRUST_PATH] = JSON.stringify({
    schemaVersion: 1,
    releases: [release],
    revokedTemplateSha256: [],
  });
  const repository = { full_name: "NVIDIA/NemoClaw" };
  const approvals = [
    {
      id: 50,
      user: { type: "User", login: "reviewer" },
      created_at: "2026-10-14T00:00:00Z",
      updated_at: "2026-10-14T00:00:00Z",
      body: `NemoClaw-Upgrade-E2E: approve ${identity.candidateSha} ${identity.baseSha}`,
    },
  ];
  const routes: Record<string, unknown> = {
    "/repos/NVIDIA/NemoClaw/pulls/123": {
      number: 123,
      state: "open",
      user: { login: "author" },
      head: { sha: identity.candidateSha, repo: repository },
      base: { sha: identity.baseSha, ref: "main", repo: repository },
    },
    "/repos/NVIDIA/NemoClaw/issues/123/comments?per_page=100&page=1": approvals,
    "/repos/NVIDIA/NemoClaw/collaborators/reviewer/permission": { role_name: "maintain" },
  };
  const request = vi.fn(async (path: string): Promise<unknown> => {
    const sourcePath = new URL(path, "https://api.github.com").pathname.replace(
      "/repos/NVIDIA/NemoClaw/contents/",
      "",
    );
    const content = files[sourcePath];
    return content === undefined
      ? routes[path]
      : {
          type: "file",
          path: sourcePath,
          encoding: "base64",
          size: Buffer.byteLength(content),
          content: Buffer.from(content).toString("base64"),
        };
  });
  return { files, sources, release, approvals, request };
}

describe("reviewed candidate OpenShell trust", () => {
  it("validates the merged registry without the old PR remaining open", () => {
    const f = fixture();
    const registry = parseOpenShellTrustRegistry(f.files[CANDIDATE_OPENSHELL_TRUST_PATH]!);
    const mergedTrust = resolveOpenShellTrustRegistry(registry);
    expect(validateInstallerSources(f.sources, mergedTrust).releaseVersion).toBe(version);
    const next = structuredClone(registry);
    const nextRelease = structuredClone(f.release);
    nextRelease.version = "9.8.8";
    nextRelease.formula.url =
      "https://github.com/NVIDIA/OpenShell/releases/download/v9.8.8/openshell.rb";
    const nextRegistry = { ...next, releases: [...next.releases, nextRelease] };
    const nextTrust = resolveOpenShellTrustRegistry(nextRegistry, registry);
    expect(validateInstallerSources(f.sources, nextTrust).releaseVersion).toBe(version);
    expect(nextTrust.find((entry) => entry.version === "9.8.8")?.formula).toEqual(
      nextRelease.formula,
    );
  });

  it("keeps revoked templates forbidden after merge and across later upgrades", () => {
    const f = fixture();
    const selected = validateInstallerSources(
      f.sources,
      resolveOpenShellTrustRegistry(
        parseOpenShellTrustRegistry(f.files[CANDIDATE_OPENSHELL_TRUST_PATH]!),
      ),
    );
    const registry = parseOpenShellTrustRegistry(f.files[CANDIDATE_OPENSHELL_TRUST_PATH]!);
    const revoked = { ...registry, revokedTemplateSha256: [selected.installerTemplateSha256] };
    expect(() =>
      validateInstallerSources(f.sources, resolveOpenShellTrustRegistry(revoked)),
    ).toThrow(/operational template/);
    expect(() => resolveOpenShellTrustRegistry(registry, revoked)).toThrow(
      /remove a template revocation/,
    );
  });

  it.each([
    [
      "release history",
      (registry: ReturnType<typeof parseOpenShellTrustRegistry>) => ({ ...registry, releases: [] }),
    ],
    [
      "artifact identity",
      (registry: ReturnType<typeof parseOpenShellTrustRegistry>) => ({
        ...registry,
        releases: registry.releases.map((release) => ({
          ...release,
          formula: { ...release.formula, sha256: "0".repeat(64) },
        })),
      }),
    ],
    [
      "template history",
      (registry: ReturnType<typeof parseOpenShellTrustRegistry>) => ({
        ...registry,
        releases: registry.releases.map((release) => ({
          ...release,
          installerTemplateSha256: ["0".repeat(64)],
        })),
      }),
    ],
  ] as const)("rejects removal or replacement of %s", (_label, mutate) => {
    const f = fixture();
    const registry = parseOpenShellTrustRegistry(f.files[CANDIDATE_OPENSHELL_TRUST_PATH]!);
    expect(() => resolveOpenShellTrustRegistry(mutate(registry), registry)).toThrow(
      /retain previous|replace an existing/,
    );
  });

  it("binds the inspected checkout and complete upstream verification records to the approved source", async () => {
    const f = fixture();
    const approved = await reviewedCandidateOpenShellTrust(identity, f.request);
    const root = mkdtempSync(join(tmpdir(), "candidate-installer-trust-"));
    temporaryRoots.push(root);
    Object.entries(CANDIDATE_OPENSHELL_SOURCES).forEach(([key, path]) => {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), approved.sources[key as keyof typeof approved.sources]);
    });
    mkdirSync(join(root, "ci"), { recursive: true });
    writeFileSync(
      join(root, CANDIDATE_OPENSHELL_TRUST_PATH),
      f.files[CANDIDATE_OPENSHELL_TRUST_PATH]!,
    );
    await expect(verifyCandidateInstallerTrust(root, identity, f.request)).resolves.toEqual(
      approved.selected,
    );
    expect(() => assertCandidateInstallerCheckout(root, approved.sources)).not.toThrow();
    const records = installerReleaseTsv(approved.selected).trimEnd().split("\n");
    expect(records.filter((line) => line.startsWith(`manifest\t${version}\t`))).toHaveLength(3);
    expect(records).toContain(
      `formula\t${version}\t${f.release.formula.url}\topenshell.rb\t${f.release.formula.sha256}`,
    );
    expect(records.filter((line) => line.startsWith("pin\t"))).toHaveLength(
      approved.selected.pins.length,
    );
    writeFileSync(
      join(root, CANDIDATE_OPENSHELL_SOURCES.installerSource),
      "unapproved replacement",
    );
    expect(() => assertCandidateInstallerCheckout(root, approved.sources)).toThrow(
      /differs from the approved commit/,
    );
    await expect(verifyCandidateInstallerTrust(root, identity, f.request)).rejects.toThrow(
      /differs from the approved commit/,
    );
  });

  it("checks unchanged registry consumers without requesting another approval", async () => {
    const request = vi.fn();
    const root = new URL("../../../", import.meta.url).pathname;
    const selected = await verifyCandidateInstallerTrust(root, identity, request);
    expect(selected.pins.length).toBeGreaterThan(0);
    expect(request).not.toHaveBeenCalled();
  });

  it("loads merged trust beside the CLI verifier instead of the candidate working directory", () => {
    const f = fixture();
    const root = mkdtempSync(join(tmpdir(), "merged-installer-trust-"));
    temporaryRoots.push(root);
    const trusted = join(root, "trusted");
    const candidate = join(root, "candidate");
    copyTrustedInstallerVerifier(new URL("../../../", import.meta.url).pathname, trusted);
    Object.entries(f.files).forEach(([path, source]) => {
      mkdirSync(dirname(join(candidate, path)), { recursive: true });
      writeFileSync(join(candidate, path), source);
    });
    writeFileSync(
      join(trusted, CANDIDATE_OPENSHELL_TRUST_PATH),
      f.files[CANDIDATE_OPENSHELL_TRUST_PATH]!,
    );
    writeFileSync(
      join(candidate, CANDIDATE_OPENSHELL_TRUST_PATH),
      '{"candidateSelfApproval":true}',
    );
    const args = [
      join(trusted, "scripts/checks/extract-installer-pins.mts"),
      "--blueprint",
      join(candidate, CANDIDATE_OPENSHELL_SOURCES.blueprintSource),
      "--installer",
      join(candidate, CANDIDATE_OPENSHELL_SOURCES.installerSource),
      "--brev-installer",
      join(candidate, CANDIDATE_OPENSHELL_SOURCES.brevInstallerSource),
      "--supervisor-runtime",
      join(candidate, CANDIDATE_OPENSHELL_SOURCES.supervisorRuntimeSource),
      "--format",
      "release-tsv",
    ];
    const result = spawnSync(process.execPath, args, { cwd: candidate, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`manifest\t${version}\t`);
    const merged = parseOpenShellTrustRegistry(f.files[CANDIDATE_OPENSHELL_TRUST_PATH]!);
    writeFileSync(
      join(trusted, CANDIDATE_OPENSHELL_TRUST_PATH),
      JSON.stringify({
        ...merged,
        revokedTemplateSha256: f.release.installerTemplateSha256,
      }),
    );
    const revoked = spawnSync(process.execPath, args, { cwd: candidate, encoding: "utf8" });
    expect(revoked.status).toBe(1);
    expect(revoked.stdout).toBe("");
    expect(revoked.stderr).toContain("operational template");
  });

  it("admits a previously unknown release through the real verifier after independent approval", async () => {
    const f = fixture();
    expect(() => validateInstallerSources(f.sources)).toThrow(
      /not in the base-trusted release records/,
    );
    await expect(
      candidateOpenShellVersion("NVIDIA/NemoClaw", identity.candidateSha, f.request, identity),
    ).resolves.toBe(version);
    expect(f.request.mock.calls.some(([path]) => path.includes("/permission"))).toBe(true);
  });

  it("does not let a candidate manifest approve its own release", async () => {
    const f = fixture();
    f.approvals.length = 0;
    await expect(reviewedCandidateOpenShellTrust(identity, f.request)).rejects.toThrow(
      /independent maintainer/,
    );
  });

  it("still rejects operations that differ from the approved template", async () => {
    const f = fixture();
    f.files[CANDIDATE_OPENSHELL_SOURCES.installerSource] += "\nunreviewed_operation\n";
    await expect(reviewedCandidateOpenShellTrust(identity, f.request)).rejects.toThrow(
      /operational template/,
    );
  });

  it.each([{ schemaVersion: 2 }, { extra: true }, { releases: [{}] }])(
    "rejects malformed reviewed data %j",
    (change) => {
      const f = fixture();
      expect(() =>
        parseOpenShellTrustRegistry(
          JSON.stringify({
            schemaVersion: 1,
            releases: [f.release],
            revokedTemplateSha256: [],
            ...change,
          }),
        ),
      ).toThrow();
    },
  );
});
