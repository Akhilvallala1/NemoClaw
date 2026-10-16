// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { fileIdentity, errorDetail } from "./probe-component-workload.mts";
import {
  acquireNativeStateInspection,
  acquireNativeStateSession,
  acquireNativeStateRemoval,
} from "../runtime/native-state.mts";

type Lease = { stateRoot: string; assertHeld(): void; release(): Promise<void> };
type StateOperations = {
  inspect(launcher: string, agent: string): Promise<Lease & { present: boolean }>;
  session(
    launcher: string,
    agent: string,
  ): Promise<Lease & { created: boolean; unrefWithoutRelease(): void }>;
  remove(launcher: string, agent: string): Promise<Lease & { removed: boolean }>;
  mkdir(directory: string): void;
};

const operations: StateOperations = {
  inspect: acquireNativeStateInspection,
  session: acquireNativeStateSession,
  remove: acquireNativeStateRemoval,
  mkdir: (directory) => fs.mkdirSync(directory),
};

export function readRequestedPersonalStateOwnerBuild(
  file: string | null,
  environment: NodeJS.ProcessEnv,
  incompatibleModes: readonly boolean[],
) {
  if (!file) return null;
  if (incompatibleModes.some(Boolean))
    throw new Error(
      "The native state owner is for current ordinary Personal qualification, not historical diagnostic replay.",
    );
  return readPersonalStateOwnerBuild(
    file,
    environment.GITHUB_SHA ?? "",
    environment.GITHUB_RUN_ID ?? "",
    environment.GITHUB_RUN_ATTEMPT ?? "",
  );
}

export function readPersonalStateOwnerBuild(
  file: string,
  sourceRevision: string,
  runId: string,
  runAttempt: string,
  sourceRoot = fileURLToPath(new URL("../launcher/", import.meta.url)),
) {
  assert.match(sourceRevision, /^[a-f0-9]{40}$/u);
  assert.match(runId, /^[1-9]\d*$/u);
  assert.match(runAttempt, /^[1-9]\d*$/u);
  const info = fs.lstatSync(file);
  assert(info.isFile() && !info.isSymbolicLink() && info.size <= 1024 * 1024);
  const record = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(record.schemaVersion, 1);
  assert.equal(record.classification, "personal-native-state-owner-build");
  assert.equal(record.sourceRevision, sourceRevision);
  assert.equal(record.workflowRunId, runId);
  assert.equal(record.workflowRunAttempt, runAttempt);
  assert.equal(record.target, "aarch64-pc-windows-msvc");
  assert.equal(record.immutableRuntime, false);
  assert.equal(record.buildProcessesClosed, true);
  const launcher = path.join(
    path.dirname(file),
    "official-hermes-runtime-build",
    "state-owner-target",
    "aarch64-pc-windows-msvc",
    "release",
    "NemoClaw.exe",
  );
  assert.equal(record.file, launcher);
  assert(fs.lstatSync(launcher).isFile());
  const executable = fileIdentity(launcher);
  assert.equal(executable.architecture, "arm64");
  assert.equal(executable.bytes, record.bytes);
  assert.equal(executable.sha256, record.sha256);
  const names = [
    "Cargo.toml",
    "Cargo.lock",
    ...fs
      .readdirSync(path.join(sourceRoot, "src"), { recursive: true })
      .filter((name): name is string => typeof name === "string" && name.endsWith(".rs"))
      .map((name) => "src/" + name.replaceAll("\\", "/")),
  ].sort();
  assert(Array.isArray(record.sources));
  assert.deepEqual(record.sources.map((row: { file: string }) => row.file).sort(), names);
  for (const row of record.sources) {
    const actual = fileIdentity(path.join(sourceRoot, row.file));
    assert.equal(actual.bytes, row.bytes, row.file);
    assert.equal(actual.sha256, row.sha256, row.file);
  }
  return { launcher, executable, receipt: fileIdentity(file), sources: record.sources };
}

export function personalNativeStateReceipt() {
  return {
    schemaVersion: 1,
    classification: "personal-native-state-owner",
    stateRoot: null as string | null,
    inspectionClosed: false,
    sessionAttempted: false,
    created: false,
    sessionReleased: false,
    removalAttempted: false,
    removed: false,
    removalReleased: false,
    ownerUnreferenced: false,
    retained: false,
    complete: false,
  };
}

export async function acquirePersonalNativeState(
  launcher: string,
  systemRoot: string,
  receipt: ReturnType<typeof personalNativeStateReceipt>,
  owner: StateOperations = operations,
) {
  if (!/^[A-Z]:\\$/u.test(systemRoot)) throw new Error("Invalid Personal system drive.");
  const inspection = await owner.inspect(launcher, "hermes");
  let expected: string;
  try {
    inspection.assertHeld();
    expected = inspection.stateRoot;
    if (
      !/^[A-Z]:\\NemoClawState-S-1-(?:\d+-)*\d+-hermes$/u.test(expected) ||
      path.win32.parse(expected).root !== systemRoot
    )
      throw new Error("The Personal state owner returned a different native state identity.");
    if (inspection.present !== false)
      throw new Error("Personal qualification refuses existing Hermes user state.");
  } finally {
    await inspection.release();
    receipt.inspectionClosed = true;
  }
  receipt.stateRoot = expected;
  // A failed acquisition may have created state before its readiness was lost.
  // Only the native owner's positive creation receipt grants removal custody.
  receipt.sessionAttempted = true;
  receipt.retained = true;
  const session = await owner.session(launcher, "hermes");
  if (session.stateRoot !== expected || session.created !== true) {
    await session.release();
    receipt.sessionReleased = true;
    throw new Error("Personal qualification did not exclusively create the inspected state.");
  }
  receipt.created = true;
  let finishing: Promise<boolean> | undefined;
  const finish = async (childrenClosed: boolean) => {
    if (finishing) return await finishing;
    if (!childrenClosed) {
      if (!receipt.ownerUnreferenced) {
        session.unrefWithoutRelease();
        receipt.ownerUnreferenced = true;
      }
      return false;
    }
    finishing = (async () => {
      await session.release();
      receipt.sessionReleased = true;
      receipt.removalAttempted = true;
      const removal = await owner.remove(launcher, "hermes");
      try {
        removal.assertHeld();
        if (removal.stateRoot !== expected || removal.removed !== true)
          throw new Error("The native owner did not confirm removal of the created Hermes state.");
        receipt.removed = true;
      } finally {
        await removal.release();
        receipt.removalReleased = true;
      }
      receipt.retained = false;
      receipt.complete = true;
      return true;
    })();
    return await finishing;
  };
  try {
    session.assertHeld();
    owner.mkdir(path.win32.join(expected, "home"));
    owner.mkdir(path.win32.join(expected, "temp"));
  } catch (error) {
    try {
      await finish(true);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Personal state preparation and cleanup failed.",
      );
    }
    throw error;
  }
  return { stateRoot: expected, assertHeld: () => session.assertHeld(), finish };
}

export async function finishPersonalStateOwnership(options: {
  enabled: boolean;
  state: Awaited<ReturnType<typeof acquirePersonalNativeState>> | undefined;
  receipt: ReturnType<typeof personalNativeStateReceipt>;
  resourceOwnerAttempted: boolean;
  allClosed: boolean;
}) {
  const result = {
    complete: true,
    resourceOwnerAttempted: options.resourceOwnerAttempted,
    allClosed: options.allClosed,
    errors: [] as Record<string, unknown>[],
  };
  if (!options.enabled) return result;
  try {
    result.complete = options.state
      ? await options.state.finish(!options.resourceOwnerAttempted || options.allClosed)
      : !options.receipt.sessionAttempted || options.receipt.complete;
  } catch (error) {
    result.complete = false;
    result.errors.push({ nativeStateCleanup: errorDetail(error) });
  }
  result.allClosed = (!options.resourceOwnerAttempted || options.allClosed) && result.complete;
  result.resourceOwnerAttempted ||= options.receipt.sessionAttempted;
  return result;
}
