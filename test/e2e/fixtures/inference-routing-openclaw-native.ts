// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { getSandbox } from "../../../src/lib/state/registry.ts";
import { ONBOARD_FINAL_HANDOFF_COMMAND_TIMEOUT_MS } from "../../../tools/e2e/onboard-timeout-contract.mts";
import { sandboxAccessEnv } from "./clients/sandbox.ts";
import type { E2ETargetFixtures } from "./e2e-test.ts";
import { startFakeOpenAiCompatibleServer } from "./fake-openai-compatible.ts";
import type { ShellProbeResult } from "./shell-probe.ts";
import {
  cleanupSandbox,
  inferenceSandboxName,
  onboardSandbox,
  requireLivePrerequisites,
} from "../live/inference-routing-helpers.ts";

type NativeOpenClawContext = Pick<
  E2ETargetFixtures,
  "artifacts" | "cleanup" | "host" | "progress" | "runtimeProvider" | "sandbox"
>;

type RestartDiagnosticContext = Pick<NativeOpenClawContext, "artifacts" | "host" | "sandbox"> & {
  owner: string;
  model: string;
  apiKey: string;
  fake: Awaited<ReturnType<typeof startFakeOpenAiCompatibleServer>>;
  attachment: { endpointUrl: string } | null | undefined;
};

/** Preserve the original restart failure while collecting bounded route evidence for HTTP 503. */
export async function captureNativeRestart503Diagnostic(
  start: ShellProbeResult,
  { owner, model, apiKey, fake, attachment, artifacts, host, sandbox }: RestartDiagnosticContext,
): Promise<void> {
  if (
    start.exitCode === 0 ||
    !start.stderr.includes(
      "native local inference check failed: sandbox inference invocation probe returned HTTP 503",
    ) ||
    !attachment
  )
    return;
  try {
    const inspectDirectRoute = async (phase: string, request: "models" | "chat") => {
      const before = fake.requests().length;
      const probe = await sandbox.exec(
        owner,
        [
          "curl",
          "-q",
          "--silent",
          "--output",
          "/dev/null",
          "--write-out",
          "%{http_code}",
          "--connect-timeout",
          "3",
          "--max-time",
          "10",
          "--header",
          `Authorization: Bearer ${apiKey}`,
          ...(request === "chat"
            ? [
                "--header",
                "Content-Type: application/json",
                "--data-binary",
                JSON.stringify({
                  model,
                  messages: [{ role: "user", content: "Reply with OK" }],
                  max_tokens: 1,
                  stream: false,
                }),
              ]
            : []),
          `${attachment.endpointUrl}/${request === "chat" ? "chat/completions" : "models"}`,
        ],
        {
          artifactName: `${owner}-restart-direct-${phase}-${request}`,
          env: sandboxAccessEnv(),
          timeoutMs: 20_000,
          redactionValues: [apiKey],
        },
      );
      return {
        exitCode: probe.exitCode,
        httpStatus: /^[1-5]\d\d$/u.test(probe.stdout.trim()) ? probe.stdout.trim() : "unknown",
        reachedEndpoint: fake.requests().length > before,
      };
    };
    const immediate = await inspectDirectRoute("immediate", "models");
    const immediateChat = await inspectDirectRoute("immediate", "chat");
    await new Promise((resolve) => setTimeout(resolve, 8_000));
    const delayed = await inspectDirectRoute("delayed", "models");
    const delayedChat = await inspectDirectRoute("delayed", "chat");
    const doctor = await host.nemoclaw([owner, "doctor"], {
      artifactName: `${owner}-restart-doctor`,
      env: sandboxAccessEnv(),
      timeoutMs: 120_000,
      redactionValues: [apiKey],
    });
    await artifacts.writeJson(`${owner}-restart-503-diagnostic.json`, {
      immediate,
      immediateChat,
      delayed,
      delayedChat,
      doctorExitCode: doctor.exitCode,
    });
  } catch {
    // Diagnosis must not mask the original start failure.
  }
}

// The real OpenClaw process must consume its scoped native-local attachment.
// llama.cpp exercises authenticated attachment; vLLM exercises sentinel auth.
export async function onboardNativeOpenClaw(
  authenticated: boolean,
  { artifacts, cleanup, host, progress, runtimeProvider, sandbox }: NativeOpenClawContext,
) {
  await requireLivePrerequisites(host, runtimeProvider);
  const owner = inferenceSandboxName(authenticated ? "e2e-oc-auth" : "e2e-oc-none");
  const model = "nemoclaw-openclaw-native-local";
  const switchedModel = "nemoclaw-openclaw-native-local-switched";
  const apiKey = authenticated ? "sk-openclaw-native-TEST-NOT-A-REAL-VALUE" : "dummy";
  const fake = await startFakeOpenAiCompatibleServer({
    apiKey,
    model,
    additionalModels: authenticated ? [switchedModel] : [],
    chatContent: "PONG",
    host: "0.0.0.0",
    port: authenticated ? 8081 : 8000,
    publicHost: "host.openshell.internal",
    requireAuth: true,
    allowMissingAuth: !authenticated,
    requireAuthModels: authenticated,
    llamaCppFingerprint: authenticated,
    progress,
  });
  cleanup.add(`close ${owner} endpoint`, async () => {
    try {
      await artifacts.writeJson(`${owner}-requests.json`, fake.requests());
    } finally {
      await fake.close();
    }
  });
  cleanup.add(`remove ${owner}`, () => cleanupSandbox(host, sandbox, owner, { strict: true }));
  await cleanupSandbox(host, sandbox, owner);
  await artifacts.target.declare({
    id: `openclaw-native-local-${authenticated ? "authenticated" : "credentialless"}`,
    contract: [
      "OpenClaw consumes its native local endpoint after onboarding",
      ...(authenticated
        ? [
            "rebuild and restart preserve the attachment",
            "an unattached sibling cannot reach the endpoint",
            "the raw credential is absent from sandbox observations",
          ]
        : ["credentialless vLLM uses sentinel authentication"]),
    ],
    model,
    switchedModel,
  });
  const onboard = await onboardSandbox(
    artifacts,
    owner,
    {
      NEMOCLAW_AGENT: "openclaw",
      NEMOCLAW_PROVIDER: authenticated ? "llama-cpp" : "vllm",
      NEMOCLAW_MODEL: model,
      ...(authenticated ? { NEMOCLAW_LLAMACPP_LOCAL_TOKEN: apiKey } : {}),
    },
    [apiKey],
    `${owner}-onboard`,
    progress,
    ONBOARD_FINAL_HANDOFF_COMMAND_TIMEOUT_MS,
  );
  return {
    owner,
    model,
    switchedModel,
    apiKey,
    fake,
    onboard,
    attachment: getSandbox(owner)?.nativeLocalProviderAttachment,
  };
}

export async function requestNativeOpenClaw(
  owner: string,
  apiKey: string,
  fake: Awaited<ReturnType<typeof startFakeOpenAiCompatibleServer>>,
  host: NativeOpenClawContext["host"],
  model = "nemoclaw-openclaw-native-local",
) {
  const requestOffset = fake.requests().length;
  const turn = await host.nemoclaw(
    [
      owner,
      "agent",
      "--agent",
      "main",
      "--json",
      "--session-id",
      `${owner}-${Date.now()}`,
      "-m",
      "Reply with exactly one word: PONG",
    ],
    {
      artifactName: `${owner}-turn`,
      env: sandboxAccessEnv(),
      timeoutMs: 5 * 60_000,
      redactionValues: [apiKey],
    },
  );
  const requests = fake
    .requests()
    .slice(requestOffset)
    .filter((request) => request.model === model);
  return { turn, requests };
}
