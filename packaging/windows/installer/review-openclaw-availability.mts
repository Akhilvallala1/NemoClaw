// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// The caller must authenticate a successful protected controller and independently
// approve its evidence. Content checks here do not authenticate an Actions run.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { readOpenedRegularFile } from "../runtime/native-security.mts";
import {
  validateOpenClawArtifactSourceSnapshot,
  validateOpenClawColdReceipt,
  validateOpenClawWarmReceipt,
} from "./qualify-installed-openclaw.mts";

const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const object = (value: unknown): Record<string, unknown> => {
  assert(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
};
const text = (value: unknown): string => {
  assert.equal(typeof value, "string");
  return value as string;
};

export function reviewOpenClawAvailability(input: {
  evidenceRoot: string;
  evidenceManifestSha256: string;
  sourceRevision: string;
  controllerSourceRevision: string;
  controllerRun: string;
}) {
  assert.match(input.evidenceManifestSha256, /^[a-f0-9]{64}$/u);
  assert.match(input.sourceRevision, /^[a-f0-9]{40}$/u);
  assert.match(input.controllerSourceRevision, /^[a-f0-9]{40}$/u);
  assert.match(input.controllerRun, /^[1-9]\d*:[1-9]\d*$/u);
  const root = path.resolve(input.evidenceRoot);
  function read(relative: string) {
    const file = path.join(root, relative);
    for (let parent = path.dirname(file); ; parent = path.dirname(parent)) {
      const stat = fs.lstatSync(parent);
      assert(
        stat.isDirectory() && !stat.isSymbolicLink(),
        "Evidence traverses a linked directory.",
      );
      if (parent === root) break;
      assert(parent.startsWith(root + path.sep), "Evidence escaped its root.");
    }
    const bytes = readOpenedRegularFile(file, {
      maxBytes: 2 * 1024 * 1024,
      rejectLinks: true,
      rejectHardLinks: true,
    });
    assert(bytes && bytes.length > 0, "Required qualification evidence is missing.");
    return bytes;
  }
  const manifestBytes = read("evidence-manifest.json");
  assert.equal(digest(manifestBytes), input.evidenceManifestSha256);
  const manifest = object(JSON.parse(manifestBytes.toString("utf8")));
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.classification, "accidental-runnable-free-windows-evidence");
  assert(
    Array.isArray(manifest.files) && manifest.files.length > 0 && manifest.files.length <= 4096,
  );
  const entries = new Map<string, { bytes: number; sha256: string }>();
  for (const value of manifest.files) {
    const row = object(value);
    const name = text(row.path);
    assert(!name.includes("\\") && !name.includes("\0") && !path.isAbsolute(name));
    assert(name.split("/").every((part) => part && part !== "." && part !== ".."));
    assert(!entries.has(name.toLowerCase()), "Duplicate evidence path.");
    assert(typeof row.bytes === "number" && Number.isSafeInteger(row.bytes) && row.bytes >= 0);
    assert.match(text(row.sha256), /^[a-f0-9]{64}$/u);
    entries.set(name.toLowerCase(), { bytes: row.bytes, sha256: text(row.sha256) });
  }
  function document(relative: string) {
    const entry = entries.get(relative.toLowerCase());
    assert(entry, "Required qualification receipt is absent from the manifest.");
    const bytes = read(relative);
    assert.equal(bytes.length, entry.bytes);
    assert.equal(digest(bytes), entry.sha256, "Qualification receipt changed after staging.");
    return { bytes, sha256: entry.sha256, value: object(JSON.parse(bytes.toString("utf8"))) };
  }
  const build = document("package/immutable-package-build.json");
  assert.equal(build.value.schemaVersion, 1);
  assert.equal(build.value.classification, "finished-native-runtime-package-build");
  assert.equal(build.value.sourceRevision, input.sourceRevision);
  assert.equal(build.value.status, "candidate-built-for-installed-qualification");
  assert.equal(build.value.installedAcceptance, false);
  assert.equal(build.value.activationAllowed, false);
  const runtime = object(build.value.runtime);
  assert.deepEqual(Object.keys(runtime).sort(), [
    "manifestSha256",
    "nodeSha256",
    "nodeVersion",
    "runtimeId",
    "sourceRevision",
  ]);
  assert.equal(runtime.sourceRevision, input.sourceRevision);
  const launcher = document("package/launcher-build-inputs.json").value;
  assert.equal(launcher.classification, "package-selected-launcher-build-inputs");
  assert.equal(launcher.sourceRevision, input.sourceRevision);
  assert.equal(`${launcher.workflowRunId}:${launcher.workflowRunAttempt}`, input.controllerRun);
  const snapshot = document("openclaw-artifact-source.json");
  validateOpenClawArtifactSourceSnapshot({
    bytes: snapshot.bytes,
    sha256: snapshot.sha256,
    sourceRevision: input.sourceRevision,
    controllerSourceRevision: input.controllerSourceRevision,
    controllerRun: input.controllerRun,
  });
  const coldPath = "installed-acceptance/installed-openclaw-acceptance.json";
  const warmPath = "installed-acceptance-warm/installed-openclaw-acceptance.json";
  const cold = document(coldPath).value;
  const warm = document(warmPath).value;
  const restart = object(cold.restart);
  const installation = text(restart.installation);
  assert.match(installation, /^[A-Z]:\\Program Files\\NVIDIA\\NemoClaw$/u);
  const launcherSha256 = text(object(launcher.retainedLauncher).sha256);
  assert.match(launcherSha256, /^[a-f0-9]{64}$/u);
  const expected = {
    controllerRun: input.controllerRun,
    controllerSourceRevision: input.controllerSourceRevision,
    installation,
    runtime,
    handoff: text(restart.handoff),
    model: text(restart.model),
    launcherSha256,
    packageBuildSha256: build.sha256,
    artifactSourceSnapshotSha256: snapshot.sha256,
  };
  assert(expected.model.length > 0 && expected.model.length <= 256);
  validateOpenClawColdReceipt(cold, expected);
  validateOpenClawWarmReceipt(warm, cold, expected);
  const timings = document("installed-stage-timings.json").value;
  for (const [key, value] of Object.entries({
    schemaVersion: 1,
    sourceRevision: input.sourceRevision,
    artifactSourceRevision: input.sourceRevision,
    controllerSourceRevision: input.controllerSourceRevision,
    currentHeadQualification: input.sourceRevision === input.controllerSourceRevision,
    mode: "current-build",
    measurement: "fresh-runner-installed-preview",
    agent: "openclaw",
    validationScope: "full-acceptance",
    fullInstalledQualification: true,
    hostPreparationRunBeforeInstall: false,
    installTargetMilliseconds: 30000,
    installTargetSatisfied: true,
    primaryException: null,
    nativeRuntimeFailure: null,
    startupComparisonAvailable: true,
    installationRootRemoved: true,
  }))
    assert.equal(timings[key], value, `Incomplete installed acceptance: ${key}`);
  for (const flag of ["uninstallDeferredForRecovery", "uninstallDeferredForSetupTransaction"])
    if (Object.hasOwn(timings, flag)) assert.equal(timings[flag], false);
  for (const action of ["-install", "-uninstall"]) {
    const stage = object(object(timings.stages)[action]);
    assert.equal(stage.exitCode, 0);
    assert.equal(stage.transactionStopped, true);
    assert(
      typeof stage.elapsedMilliseconds === "number" &&
        Number.isSafeInteger(stage.elapsedMilliseconds) &&
        stage.elapsedMilliseconds >= 0,
    );
    if (action === "-install") assert(stage.elapsedMilliseconds < 30000);
  }
  for (const [name, receipt] of [
    ["firstInstalledLaunch", coldPath],
    ["warmInstalledLaunch", warmPath],
  ]) {
    const stage = object(timings[name]);
    assert.equal(stage.exitCode, 0);
    assert.equal(stage.receipt, receipt);
    assert.equal(stage.agentStateResetPerCase, false);
  }
  assert.deepEqual(timings.restartPersistence, {
    qualified: true,
    configurationRewritten: false,
    credentialRecreated: false,
    sameConversation: true,
    sameOwnedState: true,
    coldReceipt: coldPath,
    warmReceipt: warmPath,
  });
  const remaining = object(timings.remainingInstallation);
  assert.deepEqual(remaining.entries, []);
  assert.equal(remaining.truncated, false);
  return {
    schemaVersion: 1,
    classification: "reviewed-native-runtime-availability",
    runtime,
    agents: [{ agent: "openclaw", evidenceSha256: input.evidenceManifestSha256 }],
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: Object.fromEntries(
      [
        "evidence-root",
        "evidence-manifest-sha256",
        "source-revision",
        "controller-source-revision",
        "controller-run",
        "output",
      ].map((name) => [name, { type: "string" as const }]),
    ),
  });
  const decision = reviewOpenClawAvailability({
    evidenceRoot: text(values["evidence-root"]),
    evidenceManifestSha256: text(values["evidence-manifest-sha256"]),
    sourceRevision: text(values["source-revision"]),
    controllerSourceRevision: text(values["controller-source-revision"]),
    controllerRun: text(values["controller-run"]),
  });
  const bytes = Buffer.from(JSON.stringify(decision, null, 2) + "\n");
  fs.writeFileSync(text(values.output), bytes, { flag: "wx" });
  process.stdout.write(digest(bytes) + "\n");
}
