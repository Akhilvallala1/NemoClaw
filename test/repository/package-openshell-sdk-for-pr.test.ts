// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { afterEach, describe, expect, it, vi } from "vitest";

import { packageReviewedOpenShellSdk } from "../../scripts/checks/package-openshell-sdk-for-pr.mts";
import type { ReviewedNpmArchiveRequest } from "../../scripts/lib/reviewed-npm-archive.mts";
import { sparseSdkWorkflowCheckout } from "../support/candidate-openshell-sdk.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { force: true, recursive: true });
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-sdk-package-transition-"));
  roots.push(root);
  const source = path.join(root, "source");
  const output = path.join(root, "output");
  fs.mkdirSync(source);
  const requests: ReviewedNpmArchiveRequest[] = [];
  const pack = vi.fn((request: ReviewedNpmArchiveRequest) => {
    requests.push(request);
    const archivePath = path.join(source, `${String(requests.length)}.tgz`);
    fs.writeFileSync(archivePath, request.packageSpec);
    return { archivePath, rootDirectory: source };
  });
  const remove = vi.fn();
  return { output, pack, remove, requests };
}

describe("reviewed OpenShell SDK transition packaging", () => {
  it("loads the ordinary producer from the main workflow sparse checkout", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-main-sdk-sparse-"));
    roots.push(root);
    sparseSdkWorkflowCheckout(root, ".github/workflows/main.yaml", "package-openshell-sdk");
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        "const producer = await import('./scripts/checks/package-openshell-sdk-for-pr.mts'); console.log(typeof producer.packageReviewedOpenShellSdk)",
      ],
      {
        cwd: root,
        encoding: "utf8",
        timeout: 10_000,
      },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("function");
  });

  it("loads the ordinary consumer from the PR workflow sparse checkouts", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-pr-sdk-sparse-"));
    roots.push(root);
    sparseSdkWorkflowCheckout(root, ".github/workflows/pr.yaml", "openshell-sdk-package");
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        "const consumer = await import('./scripts/checks/prepare-ci-npm-install.mts'); console.log(typeof consumer.prepareCiNpmInstall)",
      ],
      {
        cwd: root,
        encoding: "utf8",
        timeout: 10_000,
      },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("function");
  });

  it("fails closed when replacement packaging lacks replacement metadata", () => {
    const source = fixture();
    const configPath = path.resolve("ci/reviewed-npm-audit.json");
    const config = JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
    delete config.sourceRegistryPackageReplacement;

    expect(() =>
      packageReviewedOpenShellSdk(source.output, "require", {
        ...source,
        readAuditConfig: () => JSON.stringify(config),
      }),
    ).toThrow("reviewed OpenShell SDK replacement metadata is required");
    expect(source.pack).not.toHaveBeenCalled();
  });

  it("keeps the default package result to the active SDK archive", () => {
    const source = fixture();

    const artifact = packageReviewedOpenShellSdk(source.output, "exclude", source);

    expect(path.basename(artifact)).toBe("nvidia-openshell-sdk-0.0.116.tgz");
    expect(source.requests.map(({ packageSpec }) => packageSpec)).toEqual([
      "@nvidia/openshell-sdk@0.0.116",
    ]);
    expect(source.remove).toHaveBeenCalledOnce();
  });

  it("packages exactly the active and replacement identities for PR selection", () => {
    const source = fixture();
    const configPath = path.resolve("ci/reviewed-npm-audit.json");
    const config = JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
    const replacement = config.sourceRegistryPackage;
    config.sourceRegistryPackage = {
      artifactName: "nvidia-openshell-sdk-0.0.106.tgz",
      label: "OpenShell TypeScript SDK 0.0.106",
      packageSpec: "@nvidia/openshell-sdk@0.0.106",
      integrity:
        "sha512-dB4mLex23Pnw61caGMR2CMHQihy9bj7IK2elJJd718k3yevm+fOt/vG6dJg8/5us4la2BwcOdRwLvOia3tdwFw==",
      tarballUrl:
        "https://npm.pkg.github.com/download/@nvidia/openshell-sdk/0.0.106/dc32180ba1d658fc4ec309bdf89d2b162196928d",
    };
    config.sourceRegistryPackageReplacement = replacement;

    const artifactDirectory = packageReviewedOpenShellSdk(source.output, "require", {
      ...source,
      readAuditConfig: () => JSON.stringify(config),
    });

    expect(artifactDirectory).toBe(source.output);
    expect(fs.readdirSync(artifactDirectory).sort()).toEqual([
      "nvidia-openshell-sdk-0.0.106.tgz",
      "nvidia-openshell-sdk-0.0.116.tgz",
    ]);
    expect(source.requests.map(({ packageSpec }) => packageSpec)).toEqual([
      "@nvidia/openshell-sdk@0.0.106",
      "@nvidia/openshell-sdk@0.0.116",
    ]);
    expect(source.remove).toHaveBeenCalledTimes(2);
  });

  it("packages the replacement when available without requiring transition metadata", () => {
    const source = fixture();
    const configPath = path.resolve("ci/reviewed-npm-audit.json");
    const config = JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
    const replacement = config.sourceRegistryPackage;
    config.sourceRegistryPackage = {
      artifactName: "nvidia-openshell-sdk-0.0.106.tgz",
      label: "OpenShell TypeScript SDK 0.0.106",
      packageSpec: "@nvidia/openshell-sdk@0.0.106",
      integrity:
        "sha512-dB4mLex23Pnw61caGMR2CMHQihy9bj7IK2elJJd718k3yevm+fOt/vG6dJg8/5us4la2BwcOdRwLvOia3tdwFw==",
      tarballUrl:
        "https://npm.pkg.github.com/download/@nvidia/openshell-sdk/0.0.106/dc32180ba1d658fc4ec309bdf89d2b162196928d",
    };
    config.sourceRegistryPackageReplacement = replacement;

    const artifactDirectory = packageReviewedOpenShellSdk(source.output, "if-present", {
      ...source,
      readAuditConfig: () => JSON.stringify(config),
    });

    expect(artifactDirectory).toBe(source.output);
    expect(source.requests.map(({ packageSpec }) => packageSpec)).toEqual([
      "@nvidia/openshell-sdk@0.0.106",
      "@nvidia/openshell-sdk@0.0.116",
    ]);
  });

  it("keeps the active archive when optional transition metadata is absent", () => {
    const source = fixture();
    const configPath = path.resolve("ci/reviewed-npm-audit.json");
    const config = JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
    delete config.sourceRegistryPackageReplacement;

    const artifact = packageReviewedOpenShellSdk(source.output, "if-present", {
      ...source,
      readAuditConfig: () => JSON.stringify(config),
    });

    expect(path.basename(artifact)).toBe("nvidia-openshell-sdk-0.0.116.tgz");
    expect(source.requests.map(({ packageSpec }) => packageSpec)).toEqual([
      "@nvidia/openshell-sdk@0.0.116",
    ]);
  });
});
