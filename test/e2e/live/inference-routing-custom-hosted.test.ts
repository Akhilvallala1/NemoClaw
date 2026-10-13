// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  CANDIDATE_AGENT_FEATURE_ENV,
  CANDIDATE_QUALIFICATION_RECEIPT_ENV,
  readCandidateQualificationReceipt,
} from "../../../src/lib/agent/candidate.ts";
import { isNativeCustomCredentialReference } from "../../../src/lib/inference/native-custom/credential-reference.ts";
import { getSandbox } from "../../../src/lib/state/registry.ts";
import { normalizeNativeCustomProviderAttachment } from "../../../src/lib/inference/native-custom/index.ts";
import {
  buildHttpsPinRouteLoopbackBaseUrl,
  computeHttpsPinRouteId,
} from "../../../src/lib/inference/https-pin-runtime.ts";
import { parseOpenClawAgentText } from "../fixtures/openclaw-agent-output.ts";
import { approveOpenClawAdminScope } from "./openclaw-admin-scope.ts";
import { captureSandboxFailureDiagnostics } from "../fixtures/sandbox-failure-diagnostics.ts";

import {
  ONBOARD_FINAL_HANDOFF_COMMAND_TIMEOUT_MS,
  CUSTOM_HOSTED_LIFECYCLE_TEST_TIMEOUT_MS,
  NATIVE_TERMINAL_LIFECYCLE_TEST_TIMEOUT_MS,
  CUSTOM_HOSTED_INFERENCE_SWITCH_COMMAND_TIMEOUT_MS,
} from "../../../tools/e2e/onboard-timeout-contract.mts";
import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { resultText, shellQuote } from "../fixtures/clients/command.ts";
import { expect, test, type E2ETargetFixtures } from "../fixtures/e2e-test.ts";
import { verifyFreshNativeAnthropicEndpoint } from "./inference-routing-native-anthropic.ts";
import { verifyFreshNativeHermesEndpoint } from "./inference-routing-native-hermes.ts";
import {
  startFakeOpenAiCompatibleServer,
  type FakeOpenAiCompatibleServer,
} from "../fixtures/fake-openai-compatible.ts";

import { CLI_ENTRYPOINT, REPO_ROOT } from "../fixtures/paths.ts";
import { resolveVerifiedCloudflaredBinary } from "./cloudflared-prerequisite.ts";
import {
  remapDnsRebindingHostname,
  restoreDnsRebindingHostsFixture,
  setupDnsRebindingHostsFixture,
} from "./dns-rebinding-hosts-fixture.ts";
import { startFakeHttpsCompatibleServer } from "./https-pin-compatible-server.ts";
import {
  captureOpenClawPairingDiagnosticsAfterFailedOnboard,
  cleanupSandbox,
  expectOnboardSuccess,
  expectOpenAiChatThroughSandbox,
  inferenceSandboxName,
  nativeCustomChatCommand,
  onboardSandbox,
  redactedResultText,
  requireLivePrerequisites,
  runNemoclawCli,
  sandboxGatewayEnv,
} from "./inference-routing-helpers.ts";
import { startPublicMcpHttpsTunnel } from "./mcp-bridge-servers.ts";

// Native custom hosted lifecycle evidence has its own bounded catalogue job.
process.env.NEMOCLAW_CLI_BIN ??= CLI_ENTRYPOINT;

async function waitForNativeCredentialProjection(
  sandbox: E2ETargetFixtures["sandbox"],
  sandboxName: string,
  attached: boolean,
): Promise<string> {
  let reference = "";
  let attempt = 0;
  // OpenShell 0.0.116 refreshes provider state on its ten-second poll.
  // Observe fresh child environments without sending an inference request.
  await expect
    .poll(
      async () => {
        const probe = await sandbox.exec(
          sandboxName,
          ["sh", "-c", 'printf %s "${COMPATIBLE_API_KEY-}"'],
          {
            artifactName: `tc-inf-11-credential-${attached ? "attached" : "detached"}-${++attempt}`,
            env: buildAvailabilityProbeEnv(),
            timeoutMs: 15_000,
            persistArtifacts: false,
          },
        );
        reference = probe.stdout.trim();
        return (
          probe.exitCode === 0 &&
          (attached
            ? isNativeCustomCredentialReference(reference, "COMPATIBLE_API_KEY")
            : reference === "")
        );
      },
      { interval: 1_000, timeout: 30_000 },
    )
    .toBe(true);
  return reference;
}

interface NativeTerminalCase {
  agent: "langchain-deepagents-code" | "pi";
  environment: (artifacts: E2ETargetFixtures["artifacts"]) => Promise<NodeJS.ProcessEnv>;
  command: (model: string) => string[];
  responseText: (stdout: string) => string;
}

const NATIVE_TERMINAL_CASES: Record<"dcode" | "pi", NativeTerminalCase> = {
  dcode: {
    agent: "langchain-deepagents-code",
    environment: async () => buildAvailabilityProbeEnv(),
    command: () => ["dcode", "-n", "Reply with the fixture response.", "--json"],
    responseText: (stdout) => {
      const response = JSON.parse(stdout).data;
      expect(response).toMatchObject({ status: "success", exit_code: 0 });
      return response.response;
    },
  },
  pi: {
    agent: "pi",
    environment: async (artifacts) => {
      const env = buildAvailabilityProbeEnv();
      env[CANDIDATE_AGENT_FEATURE_ENV] = "1";
      env[CANDIDATE_QUALIFICATION_RECEIPT_ENV] =
        `${REPO_ROOT}/ci/pi-agent-qualification-v1-linux-${process.arch === "arm64" ? "arm64" : "amd64"}.json`;
      const contract = readCandidateQualificationReceipt("pi", env);
      env.NEMOCLAW_E2E_MANAGED_IMAGE_CATALOG = await artifacts.writeJson(
        "tc-inf-11-native-pi-catalog.json",
        { pi: contract },
      );
      env.NEMOCLAW_E2E_MANAGED_IMAGE_CATALOG_JSON = "";
      env.NEMOCLAW_E2E_MANAGED_IMAGE_REVISION = contract.source.revision;
      return env;
    },
    command: (model) => [
      "pi",
      "--no-approve",
      "--print",
      "--no-session",
      "--no-tools",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--no-context-files",
      "--system-prompt",
      "Reply to the supplied prompt.",
      "--provider",
      "openshell",
      "--model",
      model,
      "Reply with the fixture response.",
    ],
    responseText: (stdout) => stdout,
  },
};

async function verifyFreshNativeTerminalEndpoint(
  fixtures: Pick<E2ETargetFixtures, "artifacts" | "cleanup" | "host" | "progress" | "sandbox">,
  selected: NativeTerminalCase,
  endpoint: FakeOpenAiCompatibleServer,
  apiKey: string,
  model: string,
): Promise<void> {
  const { artifacts, cleanup, host, progress, sandbox } = fixtures;
  const { agent } = selected;
  const label = agent === "pi" ? "pi" : "dcode";
  const sandboxName = inferenceSandboxName(`e2e-native-${label}`);
  const env = await selected.environment(artifacts);
  delete env.COMPATIBLE_API_KEY;
  cleanup.add(`strict native ${agent} cleanup for ${sandboxName}`, () =>
    cleanupSandbox(host, sandbox, sandboxName, { strict: true, env }),
  );
  const onboard = await onboardSandbox(
    artifacts,
    sandboxName,
    {
      ...env,
      NEMOCLAW_AGENT: agent,
      NEMOCLAW_PROVIDER: "custom",
      NEMOCLAW_ENDPOINT_URL: endpoint.baseUrl,
      NEMOCLAW_MODEL: model,
      NEMOCLAW_PREFERRED_API: "openai-completions",
      COMPATIBLE_API_KEY: apiKey,
    },
    [apiKey],
    `tc-inf-11-onboard-native-${label}`,
    progress,
    ONBOARD_FINAL_HANDOFF_COMMAND_TIMEOUT_MS,
  );
  expectOnboardSuccess(onboard, `TC-INF-11 fresh native ${agent} onboard`);
  const receipt = normalizeNativeCustomProviderAttachment(
    getSandbox(sandboxName)?.nativeCustomProviderAttachment,
    sandboxName,
  )!;
  const stopped = await runNemoclawCli([sandboxName, "stop"], {
    artifactName: `tc-inf-11-native-${label}-stop`,
    artifacts,
    env,
    progress,
    redactionValues: [apiKey],
    timeoutMs: 120_000,
  });
  expect(stopped.exitCode, redactedResultText(stopped)).toBe(0);
  const restarted = await runNemoclawCli([sandboxName, "start"], {
    artifactName: `tc-inf-11-native-${label}-start`,
    artifacts,
    env,
    progress,
    redactionValues: [apiKey],
    timeoutMs: 240_000,
  });
  expect(restarted.exitCode, redactedResultText(restarted)).toBe(0);
  await waitForNativeCredentialProjection(sandbox, sandboxName, true);
  const offset = endpoint.requests().length;
  const turn = await sandbox.exec(sandboxName, selected.command(model), {
    artifactName: `tc-inf-11-native-${label}-fresh-agent-turn`,
    env,
    redactionValues: [apiKey],
    timeoutMs: 180_000,
  });
  expect(turn.exitCode, resultText(turn)).toBe(0);
  expect(selected.responseText(turn.stdout).trim()).toBe("PONG");
  expect(
    endpoint
      .requests()
      .slice(offset)
      .some(
        (request) =>
          request.auth === "ok" &&
          request.method === "POST" &&
          request.path === "/v1/chat/completions" &&
          request.model === model,
      ),
  ).toBe(true);
  const copied = await sandbox.exec(
    sandboxName,
    ["sh", "-c", 'cp "$(command -v curl)" /tmp/nemoclaw-unapproved-curl'],
    {
      artifactName: `tc-inf-11-${label}-copy-unapproved-client`,
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 30_000,
    },
  );
  expect(copied.exitCode, resultText(copied)).toBe(0);
  const denialOffset = endpoint.requests().length;
  const denied = await sandbox.exec(
    sandboxName,
    nativeCustomChatCommand(
      receipt,
      JSON.stringify({
        model,
        messages: [{ role: "user", content: "Reply with only: PONG" }],
        max_tokens: 50,
      }),
      ["--fail"],
      "/tmp/nemoclaw-unapproved-curl",
    ),
    {
      artifactName: `tc-inf-11-${label}-unapproved-executable-denied`,
      env: buildAvailabilityProbeEnv(),
      redactionValues: [apiKey],
      timeoutMs: 90_000,
    },
  );
  expect(denied.exitCode, resultText(denied)).toBeGreaterThan(0);
  expect(denied.timedOut || denied.exitCode === 28, resultText(denied)).toBe(false);
  expect(endpoint.requests()).toHaveLength(denialOffset);
  await cleanupSandbox(host, sandbox, sandboxName, { strict: true, env });
  const absent = await sandbox.openshell(["provider", "get", receipt.providerName], {
    artifactName: `tc-inf-11-native-${label}-provider-absent`,
    env,
    timeoutMs: 30_000,
  });
  expect(absent.exitCode, resultText(absent)).not.toBe(0);
  expect(resultText(absent)).toMatch(/\bNotFound\b|\bnot\s+found\b|does\s+not\s+exist/iu);
  await artifacts.writeJson(`tc-inf-11-native-${label}-receipt.json`, receipt);
}

async function prepareOwnedPublicHttpAddress(
  { host, cleanup }: Pick<E2ETargetFixtures, "host" | "cleanup">,
  artifactPrefix: string,
): Promise<string> {
  const publicHttpAddress = "93.184.216.34";
  const existingAddresses = await host.command("ip", ["-j", "address", "show", "dev", "lo"], {
    artifactName: `${artifactPrefix}-before`,
    timeoutMs: 30_000,
  });
  expect(existingAddresses.exitCode, resultText(existingAddresses)).toBe(0);
  expect(existingAddresses.stdout).not.toContain(publicHttpAddress);
  cleanup.add("remove owned public HTTP endpoint address", async () => {
    const current = await host.command("ip", ["-j", "address", "show", "dev", "lo"], {
      artifactName: `${artifactPrefix}-cleanup-before`,
      timeoutMs: 30_000,
    });
    expect(current.exitCode, resultText(current)).toBe(0);
    const removed = await host.command(
      "sudo",
      ["ip", "address", "del", `${publicHttpAddress}/32`, "dev", "lo"],
      {
        artifactName: `${artifactPrefix}-cleanup`,
        timeoutMs: 30_000,
      },
    );
    expect(removed.exitCode, resultText(removed)).toBe(0);
    const after = await host.command("ip", ["-j", "address", "show", "dev", "lo"], {
      artifactName: `${artifactPrefix}-cleanup-after`,
      timeoutMs: 30_000,
    });
    expect(after.exitCode, resultText(after)).toBe(0);
    expect(after.stdout).not.toContain(publicHttpAddress);
  });
  const added = await host.command(
    "sudo",
    ["ip", "address", "add", `${publicHttpAddress}/32`, "dev", "lo"],
    {
      artifactName: `${artifactPrefix}-add`,
      timeoutMs: 30_000,
    },
  );
  expect(added.exitCode, resultText(added)).toBe(0);
  return publicHttpAddress;
}

test(
  "TC-INF-11-custom-hosted DNS-backed HTTPS routes through the local pinning adapter (#6141)",
  {
    timeout: CUSTOM_HOSTED_LIFECYCLE_TEST_TIMEOUT_MS,
    meta: {
      e2ePhases: [
        "prepare the live HTTPS endpoint",
        "onboard the native HTTPS endpoint",
        "switch to the DNS-backed HTTPS endpoint",
        "verify pinned route isolation",
        "restart and verify a fresh native agent turn",
        "verify peer attachment and isolation",
        "verify executable and detached credential denial",
        "verify DNS rebinding resistance",
        "verify private redirect rejection",
        "destroy the selected sandbox and verify peer continuity",
        "verify direct native public HTTP and Anthropic routing",
        "verify final native provider cleanup",
      ],
    },
  },
  async ({ artifacts, cleanup, host, progress, runtimeProvider, sandbox }) => {
    const fixtures = { artifacts, cleanup, host, progress, sandbox };
    progress.phase("prepare the live HTTPS endpoint");
    await requireLivePrerequisites(host, runtimeProvider);
    const model = "nemoclaw-e2e-https-pin";
    const apiKey = "sk-https-pin-TEST-NOT-A-REAL-VALUE";
    const sandboxName = inferenceSandboxName("e2e-https");
    cleanup.add(`strict inference-routing https-pin cleanup for ${sandboxName}`, () =>
      cleanupSandbox(host, sandbox, sandboxName, { strict: true }),
    );
    await cleanupSandbox(host, sandbox, sandboxName);
    const fake = await startFakeHttpsCompatibleServer({ apiKey, chatContent: "PONG", model });
    cleanup.add("close https-pin fake HTTPS compatible server", async () => {
      try {
        await artifacts.writeJson("tc-inf-11-https-pin-endpoint-requests.json", fake.requests());
      } finally {
        await fake.close();
      }
    });
    // A genuinely public, DNS-resolvable, publicly-trusted-certificate origin
    // is required: the adapter's SSRF preflight rejects loopback/private
    // addresses, and only a real TLS trust chain exercises its SNI-pinned
    // certificate validation. This reuses the same trycloudflare.com quick
    // tunnel mechanism as the MCP-bridge DNS-rebinding coverage.
    const cloudflaredBin = await resolveVerifiedCloudflaredBinary(cleanup, host);
    const tunnel = await startPublicMcpHttpsTunnel({
      cloudflaredBin,
      cleanup,
      label: "https-pin inference routing",
      progress,
      readinessPath: "/v1/models",
      readinessStatus: 401,
      server: fake,
    });
    const endpointUrl = `${tunnel.origin}/v1`;
    const endpointHostname = new URL(tunnel.origin).hostname;
    await artifacts.target.declare({
      id: "https-pin-runtime-adapter-dns-backed-endpoint",
      issue: 6141,
      contract: [
        "inference set routes a DNS-backed HTTPS endpoint through the local pinning adapter",
        "OpenShell's own policy view never references the real upstream hostname",
        "a real chat completion round-trips through the pinned TLS connection to the public endpoint",
        "a DNS rebind of the upstream hostname after inference set does not redirect adapter traffic",
        "an upstream redirect to a private target is rejected without relaying Location or reaching the target",
        "a fresh native agent turn succeeds after stop/start using the saved attachment",
        "unapproved executables and detached attachments cannot authorize an upstream request",
        "selected detach/delete leaves an independently attached peer working",
        "destroy removes the owned provider and HTTPS route",
        "native Anthropic serves authenticated Messages after stop/start",
        "ordinary native Hermes serves a fresh authenticated OpenAI request after restart",
      ],
      endpointUrl,
      model,
    });
    // Keep a private sink solely for the redirect-denial proof. Fresh hosted
    // onboarding below exercises the native provider instead of migrating the
    // existing host-local placeholder contract covered by TC-INF-09.
    const placeholder = await startFakeOpenAiCompatibleServer({
      apiKey,
      chatContent: "placeholder",
      host: "0.0.0.0",
      model,
      port: 8000,
      progress,
      publicHost: "localhost",
      requireAuth: true,
      requireAuthModels: true,
    });
    cleanup.add("close https-pin onboarding placeholder endpoint", () => placeholder.close());
    progress.phase("onboard the native HTTPS endpoint");
    const onboard = await onboardSandbox(
      artifacts,
      sandboxName,
      {
        COMPATIBLE_API_KEY: apiKey,
        NEMOCLAW_ENDPOINT_URL: endpointUrl,
        NEMOCLAW_MODEL: model,
        NEMOCLAW_PREFERRED_API: "openai-completions",
        NEMOCLAW_PROVIDER: "custom",
      },
      [apiKey],
      "tc-inf-11-onboard-native-https-pin",
      progress,
      ONBOARD_FINAL_HANDOFF_COMMAND_TIMEOUT_MS,
    );
    await captureOpenClawPairingDiagnosticsAfterFailedOnboard(onboard, sandbox, sandboxName, [
      apiKey,
    ]);
    expectOnboardSuccess(onboard, "TC-INF-11 native https-pin endpoint onboard");
    await approveOpenClawAdminScope(
      host,
      sandbox,
      sandboxName,
      buildAvailabilityProbeEnv(),
      [apiKey],
      false,
    );
    progress.phase("switch to the DNS-backed HTTPS endpoint");
    const inferenceSet = await runNemoclawCli(
      [
        "inference",
        "set",
        "--provider",
        "compatible-endpoint",
        "--model",
        model,
        "--sandbox",
        sandboxName,
        "--endpoint-url",
        endpointUrl,
        "--credential-env",
        "COMPATIBLE_API_KEY",
        "--inference-api",
        "openai-completions",
      ],
      {
        artifactName: "tc-inf-11-inference-set-https-pin-endpoint",
        artifacts,
        env: { ...buildAvailabilityProbeEnv(), COMPATIBLE_API_KEY: apiKey },
        progress,
        redactionValues: [apiKey],
        timeoutMs: CUSTOM_HOSTED_INFERENCE_SWITCH_COMMAND_TIMEOUT_MS,
      },
    );
    expect(
      inferenceSet.exitCode,
      `TC-INF-11 inference set https-pin endpoint failed\n${redactedResultText(inferenceSet)}`,
    ).toBe(0);
    const registered = getSandbox(sandboxName)!;
    const receipt = normalizeNativeCustomProviderAttachment(
      registered?.nativeCustomProviderAttachment,
      sandboxName,
    )!;
    progress.phase("verify pinned route isolation");
    // OpenShell's own network-policy view is a second, independent witness:
    // it must never learn the real upstream hostname either, only the local
    // adapter's host.openshell.internal boundary that everything else here
    // already resolves through.
    const policy = await sandbox.openshell(["policy", "get", "--full", sandboxName], {
      artifactName: "tc-inf-11-policy-get-https-pin",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 30_000,
    });
    const policyText = resultText(policy).replace(/\u001b\[[0-9;]*m/g, "");
    expect(policy.exitCode, policyText).toBe(0);
    expect(policyText).not.toContain(endpointHostname);
    const sandboxRequestOffset = fake.requests().length;
    // Poll only the read-only request and require authenticated traffic at
    // the real pinned upstream; provider identity alone cannot prove routing.
    let routeProbeAttempt = 0;
    await expect
      .poll(
        async () => {
          routeProbeAttempt += 1;
          await expectOpenAiChatThroughSandbox(
            sandbox,
            sandboxName,
            model,
            [apiKey],
            `https-pin-endpoint-native-chat-${routeProbeAttempt}`,
            receipt,
          );
          return fake
            .requests()
            .slice(sandboxRequestOffset)
            .some(
              (request) =>
                request.auth === "ok" &&
                request.method === "POST" &&
                request.path === "/v1/chat/completions",
            );
        },
        { interval: 5_000, timeout: 11_000 },
      )
      .toBe(true);
    progress.phase("restart and verify a fresh native agent turn");
    const stopped = await runNemoclawCli([sandboxName, "stop"], {
      artifacts,
      artifactName: "tc-inf-11-stop-native",
      env: buildAvailabilityProbeEnv(),
      progress,
      redactionValues: [apiKey],
      timeoutMs: 120_000,
    });
    expect(stopped.exitCode, redactedResultText(stopped)).toBe(0);
    const started = await runNemoclawCli([sandboxName, "start"], {
      artifacts,
      artifactName: "tc-inf-11-start-native-p1",
      env: buildAvailabilityProbeEnv(),
      progress,
      redactionValues: [apiKey],
      timeoutMs: 240_000,
    });
    expect(started.exitCode, redactedResultText(started)).toBe(0);
    const selected = await runNemoclawCli([sandboxName, "inference", "get", "--json"], {
      artifacts,
      artifactName: "tc-inf-11-native-readback",
      env: buildAvailabilityProbeEnv(),
      progress,
      redactionValues: [apiKey],
      timeoutMs: 30_000,
    });
    expect(selected.exitCode, redactedResultText(selected)).toBe(0);
    expect(JSON.parse(selected.stdout)).toMatchObject({
      provider: "compatible-endpoint",
      model,
    });
    const statusRequestOffset = fake.requests().length;
    const status = await runNemoclawCli([sandboxName, "status"], {
      artifacts,
      artifactName: "tc-inf-11-native-status",
      env: buildAvailabilityProbeEnv(),
      progress,
      redactionValues: [apiKey],
      timeoutMs: 60_000,
    });
    expect(status.exitCode, redactedResultText(status)).toBe(0);
    expect(
      fake
        .requests()
        .slice(statusRequestOffset)
        .some(
          (request) =>
            request.auth === "ok" &&
            request.method === "POST" &&
            request.path === "/v1/chat/completions" &&
            JSON.parse(request.body).model === model,
        ),
    ).toBe(true);
    const restartRequestOffset = fake.requests().length;
    const nativeTurn = await sandbox.exec(
      sandboxName,
      [
        "nemoclaw-start",
        "openclaw",
        "agent",
        "--agent",
        "main",
        "--json",
        "--session-id",
        `native-custom-p1-${Date.now()}`,
        "-m",
        "Reply with only: PONG",
      ],
      {
        artifactName: "tc-inf-11-fresh-native-agent-after-start",
        env: buildAvailabilityProbeEnv(),
        redactionValues: [apiKey],
        timeoutMs: 240_000,
      },
    );
    expect(nativeTurn.exitCode, resultText(nativeTurn)).toBe(0);
    expect(parseOpenClawAgentText(nativeTurn.stdout)).toMatch(/PONG/u);
    expect(
      fake
        .requests()
        .slice(restartRequestOffset)
        .some(
          (request) =>
            request.auth === "ok" &&
            request.method === "POST" &&
            request.path === "/v1/chat/completions" &&
            JSON.parse(request.body).model === model,
        ),
    ).toBe(true);
    progress.phase("verify peer attachment and isolation");
    const peerName = inferenceSandboxName("e2e-https-peer");
    cleanup.add(`strict native HTTPS peer cleanup for ${peerName}`, () =>
      cleanupSandbox(host, sandbox, peerName, { strict: true }),
    );
    await cleanupSandbox(host, sandbox, peerName);
    const peerOnboard = await onboardSandbox(
      artifacts,
      peerName,
      {
        COMPATIBLE_API_KEY: apiKey,
        NEMOCLAW_ENDPOINT_URL: endpointUrl,
        NEMOCLAW_MODEL: model,
        NEMOCLAW_PREFERRED_API: "openai-completions",
        NEMOCLAW_PROVIDER: "custom",
      },
      [apiKey],
      "tc-inf-11-onboard-native-peer",
      progress,
      ONBOARD_FINAL_HANDOFF_COMMAND_TIMEOUT_MS,
    );
    await captureSandboxFailureDiagnostics(host, peerOnboard, {
      sandboxName: peerName,
      artifactPrefix: "tc-inf-11-peer-onboard",
      redactionValues: [apiKey],
    });
    expectOnboardSuccess(peerOnboard, "TC-INF-11 native HTTPS peer onboard");
    const peerReceipt = normalizeNativeCustomProviderAttachment(
      getSandbox(peerName)?.nativeCustomProviderAttachment,
      peerName,
    )!;
    const peerGatewayEnv = sandboxGatewayEnv(peerName);
    expect(peerReceipt.providerId).not.toBe(receipt.providerId);
    await expectOpenAiChatThroughSandbox(
      sandbox,
      peerName,
      model,
      [apiKey],
      "https-pin-native-peer-before-detach",
      peerReceipt,
    );
    progress.phase("verify executable and detached credential denial");
    const securityPayload = JSON.stringify({
      model,
      messages: [{ role: "user", content: "Reply with only: PONG" }],
      max_tokens: 50,
    });
    const copiedCurl = await sandbox.exec(
      sandboxName,
      ["sh", "-c", 'cp "$(command -v curl)" /tmp/nemoclaw-unapproved-curl'],
      {
        artifactName: "tc-inf-11-copy-unapproved-client",
        env: buildAvailabilityProbeEnv(),
        timeoutMs: 30_000,
      },
    );
    expect(copiedCurl.exitCode, resultText(copiedCurl)).toBe(0);
    const deniedRequestOffset = fake.requests().length;
    const unapproved = await sandbox.exec(
      sandboxName,
      nativeCustomChatCommand(
        receipt,
        securityPayload,
        ["--fail"],
        "/tmp/nemoclaw-unapproved-curl",
      ),
      {
        artifactName: "tc-inf-11-unapproved-executable-denied",
        env: buildAvailabilityProbeEnv(),
        redactionValues: [apiKey],
        timeoutMs: 90_000,
      },
    );
    expect(unapproved.exitCode, resultText(unapproved)).toBeGreaterThan(0);
    expect(unapproved.timedOut || unapproved.exitCode === 28, resultText(unapproved)).toBe(false);
    expect(fake.requests()).toHaveLength(deniedRequestOffset);
    let restoreAttachment: () => Promise<void> = async () => {
      const restored = await sandbox.openshell(
        ["sandbox", "provider", "attach", sandboxName, receipt.providerName],
        {
          artifactName: "tc-inf-11-cleanup-restore-provider",
          env: buildAvailabilityProbeEnv(),
          timeoutMs: 30_000,
        },
      );
      expect(restored.exitCode, resultText(restored)).toBe(0);
    };
    cleanup.add(`restore pending native attachment for ${sandboxName}`, () => restoreAttachment());
    const issuedReference = await waitForNativeCredentialProjection(sandbox, sandboxName, true);
    const detach = await sandbox.openshell(
      ["sandbox", "provider", "detach", sandboxName, receipt.providerName],
      {
        artifactName: "tc-inf-11-detach-native-provider",
        env: buildAvailabilityProbeEnv(),
        timeoutMs: 30_000,
      },
    );
    expect(detach.exitCode, resultText(detach)).toBe(0);
    await waitForNativeCredentialProjection(sandbox, sandboxName, false);
    const revokedRequestOffset = fake.requests().length;
    const revokedCommand = nativeCustomChatCommand(receipt, securityPayload, ["--fail"]);
    // Exercise the revoked reference itself, rather than failing shell expansion
    // merely because the refreshed environment no longer contains a credential.
    revokedCommand[2] = `COMPATIBLE_API_KEY=${shellQuote(issuedReference)}; ${revokedCommand[2]}`;
    const revoked = await sandbox.exec(sandboxName, revokedCommand, {
      artifactName: "tc-inf-11-detached-credential-denied",
      env: buildAvailabilityProbeEnv(),
      redactionValues: [apiKey],
      timeoutMs: 90_000,
    });
    expect(revoked.timedOut || revoked.exitCode === 28, resultText(revoked)).toBe(false);
    expect(revoked.exitCode, resultText(revoked)).toBeGreaterThan(0);
    expect(fake.requests()).toHaveLength(revokedRequestOffset);
    await expectOpenAiChatThroughSandbox(
      sandbox,
      peerName,
      model,
      [apiKey],
      "https-pin-native-peer-after-selected-detach",
      peerReceipt,
    );
    const attach = await sandbox.openshell(
      ["sandbox", "provider", "attach", sandboxName, receipt.providerName],
      {
        artifactName: "tc-inf-11-restore-native-provider",
        env: buildAvailabilityProbeEnv(),
        timeoutMs: 30_000,
      },
    );
    expect(attach.exitCode, resultText(attach)).toBe(0);
    await waitForNativeCredentialProjection(sandbox, sandboxName, true);
    await expectOpenAiChatThroughSandbox(
      sandbox,
      sandboxName,
      model,
      [apiKey],
      "https-pin-native-after-reattach",
      receipt,
    );
    restoreAttachment = async () => undefined;
    // The assertions above only prove the *initial* `inference set` reached
    // the real target. They do not prove the adapter is resistant to a DNS
    // record changing after the route is already pinned -- the exact
    // SSRF/DNS-rebinding vulnerability the pinning mechanism exists to close.
    // Rebind the tunnel hostname to a reserved, unreachable documentation
    // address (RFC 5737 TEST-NET-1) now that the route is registered: if the
    // adapter re-resolved DNS per request instead of using the addresses it
    // already pinned, this chat call would fail to connect instead of
    // succeeding.
    progress.phase("verify DNS rebinding resistance");
    const hostsFixture = await setupDnsRebindingHostsFixture(host, sandboxName, endpointHostname);
    cleanup.add(`restore https-pin DNS rebinding hosts fixture for ${sandboxName}`, () =>
      restoreDnsRebindingHostsFixture(host, sandboxName, hostsFixture),
    );
    await remapDnsRebindingHostname(
      host,
      sandboxName,
      hostsFixture,
      "192.0.2.1",
      "tc-inf-11-dns-rebind-after-inference-set",
    );
    const rebindRequestOffset = fake.requests().length;
    await expectOpenAiChatThroughSandbox(
      sandbox,
      sandboxName,
      model,
      [apiKey],
      "https-pin-endpoint-dns-rebinding-chat",
      receipt,
    );
    expect(
      fake
        .requests()
        .slice(rebindRequestOffset)
        .some(
          (request) =>
            request.auth === "ok" &&
            request.method === "POST" &&
            request.path === "/v1/chat/completions",
        ),
    ).toBe(true);
    await restoreDnsRebindingHostsFixture(host, sandboxName, hostsFixture);
    progress.phase("verify private redirect rejection");
    const privateTargetRequestOffset = placeholder.requests().length;
    const redirectTarget = new URL("chat/completions", `${placeholder.baseUrl}/`).toString();
    fake.setChatRedirect(redirectTarget);
    const redirectPayload = JSON.stringify({
      model,
      messages: [{ role: "user", content: "Reply with exactly one word: PONG" }],
      max_tokens: 50,
    });
    const redirect = await sandbox.exec(
      sandboxName,
      nativeCustomChatCommand(receipt, redirectPayload, [
        "--include",
        "--location",
        "--max-redirs",
        "3",
      ]),
      {
        artifactName: "tc-inf-11-private-redirect-rejection",
        env: buildAvailabilityProbeEnv(),
        redactionValues: [apiKey],
        timeoutMs: 90_000,
      },
    );
    const redirectText = resultText(redirect);
    expect(redirect.exitCode, redirectText).toBe(0);
    expect(redirectText).toMatch(/HTTP\/1\.[01] 502/u);
    expect(redirectText.toLowerCase()).not.toContain("location:");
    expect(placeholder.requests()).toHaveLength(privateTargetRequestOffset);
    const routeId = computeHttpsPinRouteId(
      registered.gatewayName!,
      "compatible-endpoint",
      endpointUrl,
      sandboxName,
    );
    const localRoute = `${buildHttpsPinRouteLoopbackBaseUrl(routeId)}/v1/chat/completions`;
    const routeBeforeDestroy = await host.command("curl", ["-sS", "--include", localRoute], {
      artifactName: "tc-inf-11-owned-route-before-destroy",
      timeoutMs: 30_000,
    });
    expect(routeBeforeDestroy.exitCode, resultText(routeBeforeDestroy)).toBe(0);
    expect(routeBeforeDestroy.stdout).toMatch(/HTTP\/1\.[01] 401/u);
    progress.phase("destroy the selected sandbox and verify peer continuity");
    const destroyed = await runNemoclawCli([sandboxName, "destroy", "--yes"], {
      artifacts,
      artifactName: "tc-inf-11-destroy-native",
      env: buildAvailabilityProbeEnv(),
      progress,
      redactionValues: [apiKey],
      timeoutMs: 120_000,
    });
    expect(destroyed.exitCode, redactedResultText(destroyed)).toBe(0);
    const providerAfterDestroy = await sandbox.openshell(
      ["provider", "get", receipt.providerName],
      {
        artifactName: "tc-inf-11-provider-absent-after-destroy",
        env: buildAvailabilityProbeEnv(),
        timeoutMs: 30_000,
      },
    );
    expect(providerAfterDestroy.exitCode, resultText(providerAfterDestroy)).not.toBe(0);
    expect(resultText(providerAfterDestroy)).toMatch(
      /\bNotFound\b|\bnot\s+found\b|does\s+not\s+exist/iu,
    );
    const routeAfterDestroy = await host.command("curl", ["-sS", "--include", localRoute], {
      artifactName: "tc-inf-11-owned-route-absent-after-destroy",
      timeoutMs: 30_000,
    });
    expect(routeAfterDestroy.exitCode, resultText(routeAfterDestroy)).toBe(0);
    expect(routeAfterDestroy.stdout).toMatch(/HTTP\/1\.[01] 404/u);
    fake.setChatRedirect(null);
    await expectOpenAiChatThroughSandbox(
      sandbox,
      peerName,
      model,
      [apiKey],
      "https-pin-native-peer-after-selected-destroy",
      peerReceipt,
    );
    progress.phase("verify direct native public HTTP and Anthropic routing");
    const publicHttpAddress = await prepareOwnedPublicHttpAddress(
      fixtures,
      "tc-inf-11-public-http-address",
    );
    const responsesCanary = `native-responses-${Date.now()}`;
    const publicHttp = await startFakeOpenAiCompatibleServer({
      apiKey,
      chatContent: "PONG",
      host: "0.0.0.0",
      model,
      progress,
      publicHost: publicHttpAddress,
      requireAuth: true,
      requireAuthModels: true,
      requestCanaryMarker: responsesCanary,
    });
    cleanup.add("close direct native public HTTP endpoint", async () => {
      try {
        await artifacts.writeJson("tc-inf-11-public-http-requests.json", publicHttp.requests());
      } finally {
        await publicHttp.close();
      }
    });
    const httpSwitch = await runNemoclawCli(
      [
        "inference",
        "set",
        "--provider",
        "compatible-endpoint",
        "--model",
        model,
        "--sandbox",
        peerName,
        "--endpoint-url",
        publicHttp.baseUrl,
        "--credential-env",
        "COMPATIBLE_API_KEY",
        "--inference-api",
        "openai-responses",
      ],
      {
        artifactName: "tc-inf-11-switch-native-public-http",
        artifacts,
        env: { ...buildAvailabilityProbeEnv(), COMPATIBLE_API_KEY: apiKey },
        progress,
        redactionValues: [apiKey],
        timeoutMs: CUSTOM_HOSTED_INFERENCE_SWITCH_COMMAND_TIMEOUT_MS,
      },
    );
    await captureSandboxFailureDiagnostics(host, httpSwitch, {
      sandboxName: peerName,
      artifactPrefix: "tc-inf-11-public-http-switch",
      redactionValues: [apiKey],
    });
    expect(httpSwitch.exitCode, redactedResultText(httpSwitch)).toBe(0);
    const httpReceipt = normalizeNativeCustomProviderAttachment(
      getSandbox(peerName)?.nativeCustomProviderAttachment,
      peerName,
    )!;
    const httpConfig = await sandbox.exec(peerName, ["cat", "/sandbox/.openclaw/openclaw.json"], {
      artifactName: "tc-inf-11-direct-http-native-agent-config",
      env: peerGatewayEnv,
      timeoutMs: 30_000,
    });
    expect(httpConfig.exitCode, resultText(httpConfig)).toBe(0);
    expect(httpConfig.stdout).not.toContain("inference.local");
    const responsesStopped = await runNemoclawCli([peerName, "stop"], {
      artifacts,
      artifactName: "tc-inf-11-responses-stop",
      progress,
      env: buildAvailabilityProbeEnv(),
      redactionValues: [apiKey],
      timeoutMs: 120_000,
    });
    expect(responsesStopped.exitCode, redactedResultText(responsesStopped)).toBe(0);
    const responsesStarted = await runNemoclawCli([peerName, "start"], {
      artifacts,
      artifactName: "tc-inf-11-responses-start",
      progress,
      env: buildAvailabilityProbeEnv(),
      redactionValues: [apiKey],
      timeoutMs: 240_000,
    });
    expect(responsesStarted.exitCode, redactedResultText(responsesStarted)).toBe(0);
    const responsesOffset = publicHttp.requests().length;
    const responsesTurn = await sandbox.exec(
      peerName,
      [
        "nemoclaw-start",
        "openclaw",
        "agent",
        "--agent",
        "main",
        "--json",
        "--session-id",
        responsesCanary,
        "-m",
        `Reply with only: PONG. Marker: ${responsesCanary}`,
      ],
      {
        artifactName: "tc-inf-11-responses-fresh-agent-after-start",
        env: peerGatewayEnv,
        redactionValues: [apiKey],
        timeoutMs: 240_000,
      },
    );
    expect(responsesTurn.exitCode, resultText(responsesTurn)).toBe(0);
    expect(parseOpenClawAgentText(responsesTurn.stdout)).toMatch(/PONG/u);
    expect(
      publicHttp
        .requests()
        .slice(responsesOffset)
        .some(
          (request) =>
            request.auth === "ok" &&
            request.method === "POST" &&
            request.path === "/v1/responses" &&
            request.model === model &&
            request.requestCanaryPresent === true,
        ),
    ).toBe(true);
    await verifyFreshNativeAnthropicEndpoint(fixtures, { sandboxName, apiKey, publicHttpAddress });
    await verifyFreshNativeHermesEndpoint(fixtures, { endpoint: publicHttp, apiKey, model });
    progress.phase("verify final native provider cleanup");
    await cleanupSandbox(host, sandbox, peerName, { strict: true });
    const peerProviderAfterDestroy = await sandbox.openshell(
      ["provider", "get", peerReceipt.providerName],
      {
        artifactName: "tc-inf-11-peer-https-provider-absent-after-destroy",
        env: peerGatewayEnv,
        timeoutMs: 30_000,
      },
    );
    expect(peerProviderAfterDestroy.exitCode, resultText(peerProviderAfterDestroy)).not.toBe(0);
    expect(resultText(peerProviderAfterDestroy)).toMatch(
      /\bNotFound\b|\bnot\s+found\b|does\s+not\s+exist/iu,
    );
    const httpProviderAfterDestroy = await sandbox.openshell(
      ["provider", "get", httpReceipt.providerName],
      {
        artifactName: "tc-inf-11-peer-http-provider-absent-after-destroy",
        env: peerGatewayEnv,
        timeoutMs: 30_000,
      },
    );
    expect(httpProviderAfterDestroy.exitCode, resultText(httpProviderAfterDestroy)).not.toBe(0);
    expect(resultText(httpProviderAfterDestroy)).toMatch(
      /\bNotFound\b|\bnot\s+found\b|does\s+not\s+exist/iu,
    );
    await artifacts.target.complete({
      id: "https-pin-runtime-adapter-dns-backed-endpoint",
      sandboxName,
      peerName,
      profileId: receipt.profileId,
      providerId: receipt.providerId,
      peerProviderId: peerReceipt.providerId,
      publicHttpProviderId: httpReceipt.providerId,
    });
  },
);

test(
  "TC-INF-11-native-terminals preserve custom credentials and policy after restart (#12636)",
  {
    timeout: NATIVE_TERMINAL_LIFECYCLE_TEST_TIMEOUT_MS,
    meta: {
      e2ePhases: ["prepare the native terminal endpoint", "verify native terminal lifecycles"],
    },
  },
  async ({ artifacts, cleanup, host, progress, runtimeProvider, sandbox }) => {
    const fixtures = { artifacts, cleanup, host, progress, sandbox };
    progress.phase("prepare the native terminal endpoint");
    await requireLivePrerequisites(host, runtimeProvider);
    const model = "nemoclaw-e2e-https-pin";
    const apiKey = "sk-https-pin-TEST-NOT-A-REAL-VALUE";
    const publicHost = await prepareOwnedPublicHttpAddress(
      fixtures,
      "tc-inf-11-terminal-http-address",
    );
    const endpoint = await startFakeOpenAiCompatibleServer({
      apiKey,
      chatContent: "PONG",
      host: "0.0.0.0",
      model,
      progress,
      publicHost,
      requireAuth: true,
      requireAuthModels: true,
    });
    cleanup.add("close native terminal public HTTP endpoint", async () => {
      try {
        await artifacts.writeJson("tc-inf-11-terminal-endpoint-requests.json", endpoint.requests());
      } finally {
        await endpoint.close();
      }
    });
    await artifacts.target.declare({
      id: "native-terminal-custom-hosted",
      issue: 12636,
      contract: [
        "native Deep Agents Code consumes an authenticated OpenAI response after restart",
        "protected Pi on Docker preserves native custom credentials and policy after restart",
        "unapproved executables cannot authorize an upstream request",
        "destroy confirms sandbox and owned provider absence",
      ],
      endpointUrl: endpoint.baseUrl,
      model,
    });
    progress.phase("verify native terminal lifecycles");
    await verifyFreshNativeTerminalEndpoint(
      fixtures,
      NATIVE_TERMINAL_CASES.dcode,
      endpoint,
      apiKey,
      model,
    );
    const nativePiByRuntime: Partial<Record<string, () => Promise<void>>> = {
      docker: () =>
        verifyFreshNativeTerminalEndpoint(
          fixtures,
          NATIVE_TERMINAL_CASES.pi,
          endpoint,
          apiKey,
          model,
        ),
    };
    await nativePiByRuntime[runtimeProvider.id]?.();
    await artifacts.target.complete({ id: "native-terminal-custom-hosted" });
  },
);
