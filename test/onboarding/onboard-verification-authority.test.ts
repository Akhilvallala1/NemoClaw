// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";

it("passes recorded hosted authority through the onboarding verification caller (#12636)", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-verify-authority-"));
  const repoRoot = path.join(import.meta.dirname, "../..");
  const attachment = {
    schemaVersion: 1,
    profileId: "nemoclaw-openrouter-inference-v1",
    providerName: "nemoclaw-openrouter-api-v1",
    providerId: "owned-openrouter",
  };
  try {
    const openshell = path.join(directory, "openshell");
    fs.writeFileSync(openshell, `#!${process.execPath}\nprocess.exit(0);\n`, { mode: 0o755 });
    const script = path.join(directory, "verify-authority.cjs");
    fs.writeFileSync(
      script,
      `
const root = ${JSON.stringify(repoRoot)};
const load = (name) => require(root + "/src/lib/" + name + ".ts");
const initial = load("onboard/machine/initial-flow-phases");
const core = load("onboard/machine/core-flow-phases");
const final = load("onboard/machine/final-flow-phases");
const composition = load("onboard/machine/final-flow-composition");
const registry = load("state/registry");
const verification = load("verify-deployment");
const { advanceTo, branchTo, completeOnboardMachine } = load("onboard/machine/result");
let verify;
let observed;
const createFinal = composition.createFinalOnboardFlowPhases;
composition.createFinalOnboardFlowPhases = (options) => {
  verify = options.finalizationDeps.verifyDeployment;
  return createFinal(options);
};
verification.verifyOnboardDeployment = async (name, chain, context) => {
  observed = { name, chain, context };
  return { marker: "verification-result" };
};
initial.runInitialOnboardFlowSlice = async ({ context, runtime }) => {
  await runtime.applyResult(advanceTo("preflight", { metadata: { state: "init" } }));
  await runtime.applyResult(advanceTo("gateway", { metadata: { state: "preflight" } }));
  await runtime.applyResult(advanceTo("provider_selection", { metadata: { state: "gateway" } }));
  const session = await runtime.session();
  return { session, context: {
    ...context, session, gpu: null,
    sandboxGpuConfig: { mode: "disabled", hostGpuPlatform: null },
    gpuPassthrough: false, requestedGpuPassthrough: false, resumeHasResolvedGpuIntent: true,
  } };
};
core.runCoreOnboardFlowSlice = async ({ context, runtime }) => {
  await runtime.applyResult(advanceTo("inference", { metadata: { state: "provider_selection" } }));
  await runtime.applyResult(advanceTo("sandbox", {
    metadata: { state: "inference" }, updates: { provider: "openrouter-api", model: "test-model" },
  }));
  await runtime.applyResult(branchTo("openclaw", {
    metadata: { state: "sandbox" }, updates: { sandboxName: "hosted-box" },
  }));
  const getSandbox = registry.getSandbox;
  registry.getSandbox = (name) => name === "hosted-box"
    ? { nativeHostedProviderAttachment: ${JSON.stringify(attachment)} }
    : getSandbox(name);
  const session = await runtime.session();
  return { session, context: {
    ...context, session, sandboxName: "hosted-box", provider: "openrouter-api", model: "test-model",
    endpointUrl: "https://openrouter.ai/api/v1", credentialEnv: "OPENROUTER_API_KEY",
    nimContainer: null, webSearchConfig: null, webSearchSupported: false, selectedMessagingChannels: [],
  } };
};
final.runFinalOnboardFlowSlice = async ({ runtime }) => {
  const result = await verify("hosted-box", { marker: "dashboard-chain" });
  if (result.marker !== "verification-result") throw new Error("verification result was lost");
  await runtime.applyResult(advanceTo("policies", { metadata: { state: "openclaw" } }));
  await runtime.applyResult(advanceTo("finalizing", { metadata: { state: "policies" } }));
  await runtime.applyResult(advanceTo("post_verify", { metadata: { state: "finalizing" } }));
  await runtime.applyResult(completeOnboardMachine(
    { sandboxName: "hosted-box", provider: "openrouter-api", model: "test-model" },
    { state: "post_verify" },
  ));
  return { context: null, session: await runtime.session() };
};
load("onboard").onboard({
  nonInteractive: true, autoYes: true, acceptThirdPartySoftware: true,
  noGpu: true, sandboxName: "hosted-box",
}).then(() => console.log(JSON.stringify(observed))).catch((error) => {
  console.error(error.stack); process.exitCode = 1;
});
`,
    );
    const result = spawnSync(process.execPath, [script], {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: directory,
        PATH: ["/usr/bin", "/bin"].join(path.delimiter),
        TMPDIR: directory,
        NEMOCLAW_TEST_NO_SLEEP: "1",
        NEMOCLAW_OPENSHELL_BIN: openshell,
      },
      timeout: 60_000,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout.trim().split("\n").at(-1)!)).toMatchObject({
      name: "hosted-box",
      chain: { marker: "dashboard-chain" },
      context: {
        sandboxName: "hosted-box",
        provider: "openrouter-api",
        model: "test-model",
        nativeHostedProviderAttachment: attachment,
      },
    });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
