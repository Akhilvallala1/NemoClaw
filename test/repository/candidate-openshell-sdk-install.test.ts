// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareApprovedCandidateOpenShellSdk } from "../../scripts/checks/candidate-openshell-sdk.mts";
import {
  afterCandidateSdkRead,
  candidateSdkCheckout,
  candidateSdkFixture,
  sdkCandidateIdentity,
} from "../support/candidate-openshell-sdk.ts";

const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "nemoclaw-candidate-sdk-install-"));
  roots.push(root);
  const f = candidateSdkFixture();
  return { ...f, preparation: candidateSdkCheckout(root, f), stage: vi.fn() };
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("admitted candidate SDK installation", () => {
  it("stages verified bytes only after rechecking live admission", async () => {
    const f = fixture();
    await prepareApprovedCandidateOpenShellSdk(
      f.preparation,
      sdkCandidateIdentity,
      f.request,
      f.trustedSource,
      f.stage,
    );
    expect(f.stage).toHaveBeenCalledExactlyOnceWith({
      archive: f.bytes,
      artifactName: f.sdk.artifactName,
      cacheDirectory: f.preparation.cacheDirectory,
    });
    expect(f.request.mock.calls.filter(([route]) => route.includes("/contents/"))).toHaveLength(10);
  });

  it.each([
    "package.json",
    "package-lock.json",
    "nemoclaw/package.json",
    "nemoclaw/package-lock.json",
  ])("rejects a checkout that differs from the approved %s", async (path) => {
    const f = fixture();
    writeFileSync(join(f.preparation.targetRoot, path), "{}");
    await expect(
      prepareApprovedCandidateOpenShellSdk(
        f.preparation,
        sdkCandidateIdentity,
        f.request,
        f.trustedSource,
        f.stage,
      ),
    ).rejects.toThrow(/checkout differs/);
    expect(f.stage).not.toHaveBeenCalled();
  });

  it("rejects a symbolic-link input before staging", async () => {
    const f = fixture();
    const path = join(f.preparation.targetRoot, "package.json");
    rmSync(path);
    symlinkSync("nemoclaw/package.json", path);
    await expect(
      prepareApprovedCandidateOpenShellSdk(
        f.preparation,
        sdkCandidateIdentity,
        f.request,
        f.trustedSource,
        f.stage,
      ),
    ).rejects.toThrow(/symbolic-link/);
    expect(f.stage).not.toHaveBeenCalled();
  });

  it("rejects corrupt archive bytes before staging", async () => {
    const f = fixture();
    writeFileSync(join(f.preparation.artifactDirectory, f.sdk.artifactName), "substituted");
    await expect(
      prepareApprovedCandidateOpenShellSdk(
        f.preparation,
        sdkCandidateIdentity,
        f.request,
        f.trustedSource,
        f.stage,
      ),
    ).rejects.toThrow(/integrity mismatch/);
    expect(f.stage).not.toHaveBeenCalled();
  });

  it("rejects a revoked approval before staging verified bytes", async () => {
    const f = fixture();
    const request = afterCandidateSdkRead(f, () => {
      f.records.length = 0;
    });
    await expect(
      prepareApprovedCandidateOpenShellSdk(
        f.preparation,
        sdkCandidateIdentity,
        request,
        f.trustedSource,
        f.stage,
      ),
    ).rejects.toThrow(/independent maintainer/);
    expect(f.stage).not.toHaveBeenCalled();
  });

  it("rejects a replacement approval before staging verified bytes", async () => {
    const f = fixture();
    const request = afterCandidateSdkRead(f, () => {
      f.records[0]!.id = 51;
    });
    await expect(
      prepareApprovedCandidateOpenShellSdk(
        f.preparation,
        sdkCandidateIdentity,
        request,
        f.trustedSource,
        f.stage,
      ),
    ).rejects.toThrow(/admission changed/);
    expect(f.stage).not.toHaveBeenCalled();
  });

  it("rechecks checkout inputs after acquiring the final approval", async () => {
    const f = fixture();
    const request = afterCandidateSdkRead(f, () => {
      writeFileSync(join(f.preparation.targetRoot, "nemoclaw/package-lock.json"), "{}");
    });
    await expect(
      prepareApprovedCandidateOpenShellSdk(
        f.preparation,
        sdkCandidateIdentity,
        request,
        f.trustedSource,
        f.stage,
      ),
    ).rejects.toThrow(/checkout differs/);
    expect(f.stage).not.toHaveBeenCalled();
  });

  it("rejects registry installation without consulting GitHub", async () => {
    const f = fixture();
    await expect(
      prepareApprovedCandidateOpenShellSdk(
        { ...f.preparation, mode: "registry" },
        sdkCandidateIdentity,
        f.request,
        f.trustedSource,
        f.stage,
      ),
    ).rejects.toThrow(/requires artifact mode/);
    expect(f.request).not.toHaveBeenCalled();
    expect(f.stage).not.toHaveBeenCalled();
  });
});
