// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import {
  preparedReleaseArgs,
  prepareReleaseFixtureRuntime,
} from "../helpers/openshell-installer-template";

const GUARDED_INSTALLER_SHA256 = "3ac277104b411ea27963cbf9df41ce6f9e2d39b7c430781c73f88c5489ef4af5";

function guardedInstaller(repoRoot: string, source: string): string {
  const fixture = fs.readFileSync(
    path.join(repoRoot, "test/fixtures/openshell-v012-installer-legacy-guard.sh"),
    "utf8",
  );
  const marker = "# Every installation entrypoint";
  assert.ok(fixture.includes(marker));
  const guard = fixture.slice(fixture.indexOf(marker)).trimEnd() + "\n\n";
  const before = [
    "  # MCP policy enforcement and credential replacement execute in",
    "  # openshell-sandbox. When that host artifact is present, require the native",
    "  # MCP policy marker from that exact binary.",
  ].join("\n");
  const after = [
    "  # OpenShell 0.1.2 enforces MCP policy in its supervisor image. Recognize",
    "  # only its exact pinned sandbox artifacts here, not version text alone.",
    "  # Runtime policy verification still precedes credential/provider changes.",
  ].join("\n");
  const fallback =
    [
      "    local sandbox_digest",
      '    sandbox_digest="$(file_sha256 "$sandbox_bin")" || return 1',
      '    if [ "$(pinned_sandbox_build_version "$sandbox_digest")" = "0.1.2" ]; then',
      "      return 0",
      "    fi",
    ].join("\n") + "\n";
  const featureCheck =
    '  if [[ "$sandbox_strings" != *"$OPENSHELL_SANDBOX_MCP_FEATURE"* ]]; then\n';
  const installStart = "# invalidState: a consumed";
  for (const required of [before, featureCheck, installStart]) assert.ok(source.includes(required));
  return source
    .replace(before, after)
    .replace(featureCheck, featureCheck + fallback)
    .replace(installStart, guard + installStart);
}

// Share the collected test file's fixture lifecycle and temporary-directory cleanup.
export function registerV012TemplateCases(
  repoRoot: string,
  createFixture: (version: string) => string,
): void {
  it("admits only the exact thread-group supervisor template with OpenShell 0.1.2", () => {
    const root = createFixture("0.1.2");
    prepareReleaseFixtureRuntime(repoRoot, root, { currentProcessReader: true });
    const run = () => spawnSync("node", preparedReleaseArgs(repoRoot, root), { encoding: "utf8" });
    expect(run().status).toBe(0);
    fs.appendFileSync(path.join(root, "src/lib/onboard/docker-driver-gateway-runtime.ts"), "//x");
    expect(run()).toMatchObject({ status: 1, stderr: expect.stringContaining("not base-trusted") });
  });

  it("admits the exact standalone legacy guard but rejects altered guard behavior", () => {
    const root = createFixture("0.1.2");
    prepareReleaseFixtureRuntime(repoRoot, root);
    const installer = path.join(root, "scripts/install-openshell.sh");
    const source = guardedInstaller(repoRoot, fs.readFileSync(installer, "utf8"));
    fs.writeFileSync(installer, source);
    const run = () => spawnSync("node", preparedReleaseArgs(repoRoot, root), { encoding: "utf8" });
    const accepted = run();
    expect(accepted.status, accepted.stderr).toBe(0);
    const pins = JSON.parse(accepted.stdout) as {
      source: string;
      operationalTemplateSha256: string;
    }[];
    const installers = pins.filter((pin) => pin.source === "installer");
    expect(installers.length).toBeGreaterThan(0);
    expect(
      installers.every((pin) => pin.operationalTemplateSha256 === GUARDED_INSTALLER_SHA256),
    ).toBe(true);

    for (const [original, replacement] of [
      ["constants.O_NOFOLLOW", "0"],
      ["  verify();", "  // verify();"],
      ["if (missing(error)) continue;", "continue;"],
    ]) {
      const mutated = source.replace(original, replacement);
      expect(mutated).not.toBe(source);
      fs.writeFileSync(installer, mutated);
      const denied = run();
      expect(denied).toMatchObject({
        status: 1,
        stdout: "",
        stderr: expect.stringContaining("installer operational template is not base-trusted"),
      });
    }
  });
}
