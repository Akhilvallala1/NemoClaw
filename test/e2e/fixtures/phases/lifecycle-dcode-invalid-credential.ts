// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import {
  normalizeNativeCustomProviderAttachment,
  type NativeCustomProviderAttachment,
} from "../../../../src/lib/inference/native-custom/index.ts";
import { shellQuote } from "../clients/command.ts";
import { REPO_ROOT } from "../paths.ts";

import { buildAvailabilityProbeEnv } from "../availability-env.ts";
import { assertExitZero, outputContainsReadySandbox, resultText } from "../clients/command.ts";
import type { HostCliClient } from "../clients/host.ts";
import type { SandboxClient } from "../clients/sandbox.ts";
import {
  HOSTED_INFERENCE_CREDENTIAL_ENV,
  HOSTED_INFERENCE_PROVIDER_NAME,
} from "../hosted-inference.ts";
import { isValidSecretEnvKey } from "../redaction.ts";
import type { RuntimeProviderPrerequisite } from "../runtime-provider.ts";
import type { ShellProbeResult } from "../shell-probe.ts";
import type { NemoClawInstance } from "./onboarding.ts";
import { latestRebuildBackupDir } from "./state-validation.ts";

const AGENT = "langchain-deepagents-code";
const MARKER_PATH = "/sandbox/.nemoclaw-dcode-rebuild-marker";
const MARKER_VALUE = "NEMOCLAW_DCODE_REBUILD_MARKER";
const ROUTE_ATTEMPTS = 8;
const ROUTE_DELAY_MS = 2_000;
const INVALID_REBUILD_TIMEOUT_MS = 3 * 60_000;
const SUCCESSFUL_REBUILD_TIMEOUT_MS = 20 * 60_000;
const DCODE_ACTION_TIMEOUT_MS = 2 * 60_000;
const NATIVE_STATE_CASES = [
  ["/sandbox/.nemoclaw-dcode-unknown.txt", "unknown-home"],
  ["/sandbox/workspace/nemoclaw-dcode/project.txt", "workspace"],
  ["/sandbox/.local/share/nemoclaw-dcode/packages/tool.txt", "package"],
  ["/sandbox/.deepagents/plugins/nemoclaw-dcode/plugin.txt", "plugin"],
  ["/sandbox/.deepagents/hooks/nemoclaw-dcode/preflight.sh", "hook"],
  ["/sandbox/.deepagents/cron/nemoclaw-dcode/jobs.json", "cron"],
  ["/sandbox/.deepagents/agents/nemoclaw-child/history.jsonl", "child-agent"],
  ["/sandbox/.deepagents/nemoclaw-dcode-config/config.json", "configuration"],
] as const;

export interface DcodeInvalidCredentialRebuildOptions {
  gatewayName: string;
  providerName: string;
  credentialEnv: string;
  model: string;
  validCredential: string;
  nativeCustomProviderAttachment?: NativeCustomProviderAttachment;
}

export interface DcodeInvalidCredentialLifecycleDeps {
  host: HostCliClient;
  sandbox: SandboxClient;
  cleanup: { add(name: string, run: () => Promise<void> | void): void };
  runtimeProvider: RuntimeProviderPrerequisite;
}

export interface DcodeInvalidCredentialLifecycleResult {
  profile: "dcode-rebuild-invalid-credential";
  steps: Array<{ id: string; results: ShellProbeResult[] }>;
}

function requiredString(entry: Record<string, unknown>, field: string): string {
  const value = entry[field];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`DCode invalid-credential lifecycle requires registry field '${field}'`);
  }
  return value.trim();
}

export function dcodeInvalidCredentialRebuildOptionsFromRegistryEntry(
  entry: Record<string, unknown>,
  validCredential: string,
): DcodeInvalidCredentialRebuildOptions {
  if (entry.agent !== AGENT) {
    throw new Error(`DCode invalid-credential lifecycle requires registry agent '${AGENT}'`);
  }
  if (!validCredential) {
    throw new Error("DCode invalid-credential lifecycle requires the original provider credential");
  }
  const providerName = requiredString(entry, "provider");
  if (providerName !== HOSTED_INFERENCE_PROVIDER_NAME) {
    throw new Error(
      `DCode invalid-credential lifecycle requires provider '${HOSTED_INFERENCE_PROVIDER_NAME}', got '${providerName}'`,
    );
  }
  const credentialEnv =
    entry.credentialEnv == null
      ? HOSTED_INFERENCE_CREDENTIAL_ENV
      : requiredString(entry, "credentialEnv");
  if (credentialEnv !== HOSTED_INFERENCE_CREDENTIAL_ENV || !isValidSecretEnvKey(credentialEnv)) {
    throw new Error(
      `DCode invalid-credential lifecycle requires credential env '${HOSTED_INFERENCE_CREDENTIAL_ENV}'`,
    );
  }
  const nativeCustom = normalizeNativeCustomProviderAttachment(
    entry.nativeCustomProviderAttachment,
    String(entry.name),
    { provider: providerName, credentialEnv },
  );
  if (
    entry.nativeCustomProviderAttachment !== undefined &&
    (!nativeCustom ||
      nativeCustom.api !== "openai-completions" ||
      (nativeCustom.transport && nativeCustom.transport.gatewayName !== entry.gatewayName))
  ) {
    throw new Error("DCode lifecycle requires the exact recorded native custom chat attachment.");
  }
  return {
    gatewayName: requiredString(entry, "gatewayName"),
    providerName,
    credentialEnv,
    model: requiredString(entry, "model"),
    validCredential,
    ...(nativeCustom ? { nativeCustomProviderAttachment: nativeCustom } : {}),
  };
}

export function isDcodeInvalidCredentialRebuildOptions(
  options: object,
): options is DcodeInvalidCredentialRebuildOptions {
  return (
    "gatewayName" in options &&
    "providerName" in options &&
    "credentialEnv" in options &&
    "model" in options &&
    "validCredential" in options
  );
}

function gatewayEnv(gatewayName: string): NodeJS.ProcessEnv {
  return { ...buildAvailabilityProbeEnv(), OPENSHELL_GATEWAY: gatewayName };
}

function sortedLines(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean),
    ),
  ].sort();
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function routeHttpCode(result: ShellProbeResult): string | undefined {
  const code = result.stdout.trim();
  return /^\d{3}$/.test(code) ? code : undefined;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function assertReady(
  deps: DcodeInvalidCredentialLifecycleDeps,
  sandboxName: string,
  options: DcodeInvalidCredentialRebuildOptions,
  phase: string,
  redactionValues: string[],
): Promise<ShellProbeResult> {
  const result = await deps.sandbox.list({
    artifactName: `lifecycle-dcode-ready-${phase}`,
    env: gatewayEnv(options.gatewayName),
    redactionValues,
    timeoutMs: 30_000,
  });
  assertExitZero(result, `list DCode sandbox during ${phase}`);
  if (!outputContainsReadySandbox(result, sandboxName)) {
    throw new Error(`DCode sandbox '${sandboxName}' was not Ready during ${phase}`);
  }
  return result;
}

async function managedContainerIds(
  deps: DcodeInvalidCredentialLifecycleDeps,
  sandboxName: string,
  phase: string,
  redactionValues: string[],
): Promise<ShellProbeResult> {
  const result = await deps.runtimeProvider.command(
    [
      "ps",
      "-a",
      "--no-trunc",
      "--filter",
      deps.runtimeProvider.id === "podman"
        ? "label=openshell.managed=true"
        : "label=openshell.ai/managed-by=openshell",
      "--filter",
      `label=openshell.ai/sandbox-name=${sandboxName}`,
      "--format",
      "{{.ID}}",
    ],
    {
      artifactName: `lifecycle-dcode-container-ids-${phase}`,
      redactionValues,
      timeoutMs: 15_000,
    },
  );
  assertExitZero(result, `discover DCode container IDs during ${phase}`);
  return result;
}

async function probeRoute(
  deps: DcodeInvalidCredentialLifecycleDeps,
  sandboxName: string,
  options: DcodeInvalidCredentialRebuildOptions,
  phase: string,
  attempt: number,
  redactionValues: string[],
): Promise<ShellProbeResult> {
  const payload = JSON.stringify({
    model: options.model,
    max_tokens: 8,
    messages: [{ role: "user", content: "Reply with OK" }],
    stream: false,
  });
  return await deps.sandbox.exec(
    sandboxName,
    options.nativeCustomProviderAttachment
      ? [
          "sh",
          "-c",
          `printf '%s' "\${COMPATIBLE_API_KEY:-}" | LC_ALL=C grep -Eq '^openshell:resolve:env:(v[0-9]{1,20}|s[a-f0-9]{64})_COMPATIBLE_API_KEY$' || exit 2; exec curl -sS -o /dev/null -w '%{http_code}' --connect-timeout 5 --max-time 15 -H 'Content-Type: application/json' -H "Authorization: Bearer $COMPATIBLE_API_KEY" --data-binary ${shellQuote(payload)} ${shellQuote(`${options.nativeCustomProviderAttachment.endpointUrl}/chat/completions`)}`,
        ]
      : [
          "curl",
          "-sS",
          "-o",
          "/dev/null",
          "-w",
          "%{http_code}",
          "--connect-timeout",
          "5",
          "--max-time",
          "15",
          "-H",
          "Content-Type: application/json",
          "--data-binary",
          payload,
          "https://inference.local/v1/chat/completions",
        ],
    {
      artifactName: `lifecycle-dcode-route-${phase}-${attempt}`,
      env: gatewayEnv(options.gatewayName),
      redactionValues,
      timeoutMs: 25_000,
    },
  );
}

async function waitForRoute(
  deps: DcodeInvalidCredentialLifecycleDeps,
  sandboxName: string,
  options: DcodeInvalidCredentialRebuildOptions,
  phase: string,
  accepted: (code: string | undefined) => boolean,
  redactionValues: string[],
): Promise<ShellProbeResult> {
  let last: ShellProbeResult | undefined;
  for (let attempt = 1; attempt <= ROUTE_ATTEMPTS; attempt += 1) {
    last = await probeRoute(deps, sandboxName, options, phase, attempt, redactionValues);
    if (last.exitCode === 0 && accepted(routeHttpCode(last))) return last;
    if (attempt < ROUTE_ATTEMPTS) await sleep(ROUTE_DELAY_MS);
  }
  throw new Error(
    `DCode inference route did not reach the required HTTP state during ${phase}: ${last ? resultText(last) : "no result"}`,
  );
}

async function updateProviderCredential(
  deps: DcodeInvalidCredentialLifecycleDeps,
  options: DcodeInvalidCredentialRebuildOptions,
  credential: string,
  phase: string,
  redactionValues: string[],
): Promise<ShellProbeResult> {
  const native = options.nativeCustomProviderAttachment;
  if (native?.transport?.kind === "https-pin") {
    // The adapter owns the upstream key; changing the OpenShell token would test
    // a different failure and would not restore the recorded upstream credential.
    const script = `
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { isDeepStrictEqual } = require('node:util');
const { getSandbox } = require('./src/lib/state/registry.ts');
const { normalizeNativeCustomProviderAttachment, verifyNativeCustomProviderAttachment } = require('./src/lib/inference/native-custom/index.ts');
const { createCliOpenShellProviderAdapter } = require('./src/lib/adapters/openshell/provider-adapter-cli.ts');
const { ensureHttpsPinRuntimeAdapter } = require('./src/lib/inference/https-pin-runtime-adapter.ts');
const { resolveCurrentRuntimeProviderBundle } = require('./src/lib/onboard/runtime-provider/access.ts');
const receipt = normalizeNativeCustomProviderAttachment(JSON.parse(process.env.NEMOCLAW_E2E_NATIVE_ATTACHMENT));
if (!receipt || !receipt.sandboxName.startsWith('e2e-') || receipt.transport?.kind !== 'https-pin' || receipt.transport.gatewayName !== process.env.OPENSHELL_GATEWAY || !isDeepStrictEqual(getSandbox(receipt.sandboxName)?.nativeCustomProviderAttachment, receipt)) throw new Error('DCode native rotation authority changed');
await verifyNativeCustomProviderAttachment({ adapter: createCliOpenShellProviderAdapter(), target: { kind: 'named', gatewayName: receipt.transport.gatewayName }, sandboxName: receipt.sandboxName, expected: receipt });
const runtime = resolveCurrentRuntimeProviderBundle();
const route = await ensureHttpsPinRuntimeAdapter({
  gatewayName: receipt.transport.gatewayName, sandboxName: receipt.sandboxName,
  provider: 'compatible-endpoint', providerType: 'openai',
  endpointUrl: receipt.transport.sourceEndpointUrl, credentialValue: process.env.COMPATIBLE_API_KEY,
  lookup: async () => receipt.transport.sourceAddresses.map(address => ({ address, family: address.includes(':') ? 6 : 4 })),
  trustedPrivateHosts: receipt.transport.trustedPrivateEndpoint ? [new URL(receipt.transport.sourceEndpointUrl).hostname] : [],
  discoverAllowedSourceCidrs: () => runtime.gateway.observeHostRuntime({ environment: process.env, platform: process.platform }).network.sandboxSourceCidrs(),
});
if (route.baseUrl + '/v1' !== receipt.endpointUrl) throw new Error('DCode native rotation changed route');
`;
    const result = await deps.host.command(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", script],
      {
        cwd: REPO_ROOT,
        artifactName: `lifecycle-dcode-provider-${phase}`,
        env: {
          ...gatewayEnv(options.gatewayName),
          NEMOCLAW_E2E_NATIVE_ATTACHMENT: JSON.stringify(native),
          COMPATIBLE_API_KEY: credential,
        },
        redactionValues,
        timeoutMs: 30_000,
      },
    );
    assertExitZero(result, `${phase} DCode native adapter credential`);
    return result;
  }
  const result = await deps.host.command(
    "openshell",
    [
      "provider",
      "update",
      "-g",
      options.gatewayName,
      native?.providerName ?? options.providerName,
      "--credential",
      options.credentialEnv,
    ],
    {
      artifactName: `lifecycle-dcode-provider-${phase}`,
      env: { ...gatewayEnv(options.gatewayName), [options.credentialEnv]: credential },
      redactionValues,
      timeoutMs: 30_000,
    },
  );
  assertExitZero(result, `${phase} DCode provider credential`);
  return result;
}

function assertFailedBeforeDestructiveWork(result: ShellProbeResult): void {
  if (result.timedOut || result.signal !== null || !result.exitCode || result.exitCode < 0) {
    throw new Error("DCode invalid-credential rebuild did not return a numeric non-zero exit");
  }
  const output = resultText(result);
  if (
    !/recorded inference credentials or route/i.test(output) ||
    !/HTTP (?:401|403)\b/.test(output)
  ) {
    throw new Error(`DCode rebuild did not report the rejected recorded route: ${output}`);
  }
  if (!/Sandbox is untouched\s+—\s+no data was lost\./i.test(output)) {
    throw new Error(`DCode rebuild did not report the untouched guarantee: ${output}`);
  }
  const destructive = [
    /Backing up sandbox state/i,
    /Deleting old sandbox/i,
    /Old sandbox deleted/i,
    /Creating new sandbox/i,
    /Recreate failed after sandbox was destroyed/i,
  ].find((pattern) => pattern.test(output));
  if (destructive) {
    throw new Error(`DCode rebuild crossed a destructive boundary: ${destructive.source}`);
  }
}

function assertDcodeActionSucceeded(result: ShellProbeResult): void {
  assertExitZero(result, "run DCode action after successful rebuild");
  let envelope: unknown;
  try {
    envelope = JSON.parse(result.stdout);
  } catch {
    throw new Error(
      `DCode action did not return JSON after successful rebuild: ${resultText(result)}`,
    );
  }
  if (envelope === null || typeof envelope !== "object" || Array.isArray(envelope)) {
    throw new Error("DCode action returned a non-object JSON envelope after successful rebuild");
  }
  const record = envelope as Record<string, unknown>;
  const data = record.data;
  if (
    record.schema_version !== 1 ||
    record.command !== "non-interactive" ||
    data === null ||
    typeof data !== "object" ||
    Array.isArray(data)
  ) {
    throw new Error("DCode action returned an invalid JSON envelope after successful rebuild");
  }
  const action = data as Record<string, unknown>;
  if (
    action.status !== "success" ||
    action.exit_code !== 0 ||
    typeof action.response !== "string" ||
    action.response.trim() !== "PONG"
  ) {
    throw new Error(`DCode action was not usable after successful rebuild: ${resultText(result)}`);
  }
}

export async function simulateDcodeInvalidCredentialRebuild(
  instance: NemoClawInstance,
  options: DcodeInvalidCredentialRebuildOptions,
  deps: DcodeInvalidCredentialLifecycleDeps,
): Promise<DcodeInvalidCredentialLifecycleResult> {
  if (instance.agent !== AGENT || !instance.sandboxName.startsWith("e2e-")) {
    throw new Error("DCode invalid-credential lifecycle only accepts its test-owned DCode target");
  }
  const steps: DcodeInvalidCredentialLifecycleResult["steps"] = [];
  const record = (id: string, result: ShellProbeResult): void => {
    steps.push({ id, results: [result] });
  };
  const baseRedactions = [options.validCredential];
  const names = await deps.host.command(
    "openshell",
    ["sandbox", "list", "--names", "--limit", "2", "-g", options.gatewayName],
    {
      artifactName: "lifecycle-dcode-gateway-sandboxes",
      env: gatewayEnv(options.gatewayName),
      redactionValues: baseRedactions,
      timeoutMs: 30_000,
    },
  );
  assertExitZero(names, "list gateway-scoped sandboxes before credential rotation");
  record("gateway-sandboxes:before", names);
  if (!sameStrings(sortedLines(names.stdout), [instance.sandboxName])) {
    throw new Error(
      "DCode credential rotation requires the target to be the gateway's only sandbox",
    );
  }

  record(
    "sandbox-ready:before",
    await assertReady(deps, instance.sandboxName, options, "before", baseRedactions),
  );
  const markerWrite = await deps.sandbox.exec(
    instance.sandboxName,
    [
      "sh",
      "-c",
      'mkdir -p "$(dirname "$1")" && printf \'%s\' "$2" > "$1"',
      "sh",
      MARKER_PATH,
      MARKER_VALUE,
    ],
    {
      artifactName: "lifecycle-dcode-marker-write",
      env: gatewayEnv(options.gatewayName),
      redactionValues: baseRedactions,
      timeoutMs: 30_000,
    },
  );
  assertExitZero(markerWrite, "write DCode rebuild marker");
  record("marker-write", markerWrite);

  const nativeStateWrite = await deps.sandbox.exec(
    instance.sandboxName,
    [
      "sh",
      "-c",
      'set -eu; while [ "$#" -gt 0 ]; do path="$1"; value="$2"; shift 2; mkdir -p "$(dirname "$path")"; printf \'%s\' "$value" > "$path"; done',
      "sh",
      ...NATIVE_STATE_CASES.flatMap(([statePath, value]) => [statePath, value]),
    ],
    {
      artifactName: "lifecycle-dcode-native-state-write",
      env: gatewayEnv(options.gatewayName),
      redactionValues: baseRedactions,
      timeoutMs: 30_000,
    },
  );
  assertExitZero(nativeStateWrite, "write representative DCode native state");
  record("native-state-write", nativeStateWrite);

  const idsBeforeResult = await managedContainerIds(
    deps,
    instance.sandboxName,
    "before",
    baseRedactions,
  );
  const idsBefore = sortedLines(idsBeforeResult.stdout);
  if (idsBefore.length === 0) throw new Error("DCode target has no OpenShell-managed container");
  record("container-ids:before", idsBeforeResult);
  record(
    "inference-route:baseline",
    await waitForRoute(
      deps,
      instance.sandboxName,
      options,
      "baseline",
      (code) => Boolean(code && /^2\d\d$/.test(code)),
      baseRedactions,
    ),
  );

  const backupBefore = latestRebuildBackupDir(instance.sandboxName);
  const badCredential = `nvapi-e2e-invalid-${randomUUID().replaceAll("-", "")}`;
  const redactionValues = [options.validCredential, badCredential];
  let restorationVerified = false;
  const restoreOnce = async (
    stepRecorder?: (id: string, result: ShellProbeResult) => void,
  ): Promise<void> => {
    if (restorationVerified) return;
    const restoredCredential = await updateProviderCredential(
      deps,
      options,
      options.validCredential,
      "restore",
      redactionValues,
    );
    stepRecorder?.("provider-credential:restored", restoredCredential);
    const restoredRoute = await waitForRoute(
      deps,
      instance.sandboxName,
      options,
      "restored",
      (code) => Boolean(code && /^2\d\d$/.test(code)),
      redactionValues,
    );
    stepRecorder?.("inference-route:restored", restoredRoute);
    restorationVerified = true;
  };
  deps.cleanup.add(
    `lifecycle.restore-dcode-provider:${options.gatewayName}:${options.providerName}`,
    restoreOnce,
  );

  let primaryError: unknown;
  try {
    record(
      "provider-credential:invalid",
      await updateProviderCredential(deps, options, badCredential, "invalid", redactionValues),
    );
    record(
      "inference-route:invalid",
      await waitForRoute(
        deps,
        instance.sandboxName,
        options,
        "invalid",
        (code) => code === "401" || code === "403",
        redactionValues,
      ),
    );
    record(
      "sandbox-ready:invalid",
      await assertReady(deps, instance.sandboxName, options, "invalid", redactionValues),
    );
    const rebuild = await deps.host.nemoclaw(
      [instance.sandboxName, "rebuild", "--yes", "--verbose"],
      {
        artifactName: "lifecycle-dcode-rebuild-invalid-credential",
        env: gatewayEnv(options.gatewayName),
        redactionValues,
        timeoutMs: INVALID_REBUILD_TIMEOUT_MS,
      },
    );
    record("nemoclaw-rebuild:invalid-credential", rebuild);
    assertFailedBeforeDestructiveWork(rebuild);
    if (latestRebuildBackupDir(instance.sandboxName) !== backupBefore) {
      throw new Error("DCode rejected rebuild created or changed a backup");
    }

    const idsAfterResult = await managedContainerIds(
      deps,
      instance.sandboxName,
      "after",
      redactionValues,
    );
    record("container-ids:after", idsAfterResult);
    if (!sameStrings(sortedLines(idsAfterResult.stdout), idsBefore)) {
      throw new Error("DCode rejected rebuild changed the managed container ID set");
    }
    const markerRead = await deps.sandbox.exec(instance.sandboxName, ["cat", MARKER_PATH], {
      artifactName: "lifecycle-dcode-marker-read",
      env: gatewayEnv(options.gatewayName),
      redactionValues,
      timeoutMs: 30_000,
    });
    assertExitZero(markerRead, "read DCode marker after rejected rebuild");
    if (markerRead.stdout !== MARKER_VALUE) {
      throw new Error("DCode marker changed or disappeared after rejected rebuild");
    }
    record("marker-read:after", markerRead);
    record(
      "sandbox-ready:after",
      await assertReady(deps, instance.sandboxName, options, "after", redactionValues),
    );
  } catch (error) {
    primaryError = error;
  }

  let restorationError: unknown;
  try {
    await restoreOnce(record);
  } catch (error) {
    restorationError = error;
  }
  if (primaryError && restorationError) {
    throw new AggregateError(
      [primaryError, restorationError],
      "DCode rebuild proof failed and credential restoration also failed",
    );
  }
  if (primaryError) throw primaryError;
  if (restorationError) throw restorationError;

  const successfulRebuild = await deps.host.nemoclaw(
    [instance.sandboxName, "rebuild", "--yes", "--verbose"],
    {
      artifactName: "lifecycle-dcode-rebuild-valid-credential",
      env: gatewayEnv(options.gatewayName),
      redactionValues,
      timeoutMs: SUCCESSFUL_REBUILD_TIMEOUT_MS,
    },
  );
  assertExitZero(successfulRebuild, "rebuild DCode with the restored valid credential");
  record("nemoclaw-rebuild:valid-credential", successfulRebuild);

  const idsRebuiltResult = await managedContainerIds(
    deps,
    instance.sandboxName,
    "rebuilt",
    redactionValues,
  );
  const idsRebuilt = sortedLines(idsRebuiltResult.stdout);
  if (idsRebuilt.length === 0 || sameStrings(idsRebuilt, idsBefore)) {
    throw new Error("DCode successful rebuild did not create a replacement managed container");
  }
  record("container-ids:rebuilt", idsRebuiltResult);

  const rebuiltMarker = await deps.sandbox.exec(instance.sandboxName, ["cat", MARKER_PATH], {
    artifactName: "lifecycle-dcode-marker-read-rebuilt",
    env: gatewayEnv(options.gatewayName),
    redactionValues,
    timeoutMs: 30_000,
  });
  assertExitZero(rebuiltMarker, "read DCode marker after successful rebuild");
  if (rebuiltMarker.stdout !== MARKER_VALUE) {
    throw new Error("DCode marker changed or disappeared after successful rebuild");
  }
  record("marker-read:rebuilt", rebuiltMarker);

  const rebuiltNativeState = await deps.sandbox.exec(
    instance.sandboxName,
    [
      "sh",
      "-c",
      'set -eu; while [ "$#" -gt 0 ]; do path="$1"; expected="$2"; shift 2; actual="$(cat "$path")"; [ "$actual" = "$expected" ] || { echo "native state mismatch: $path" >&2; exit 41; }; printf \'%s\\n\' "$actual"; done',
      "sh",
      ...NATIVE_STATE_CASES.flatMap(([statePath, value]) => [statePath, value]),
    ],
    {
      artifactName: "lifecycle-dcode-native-state-read-rebuilt",
      env: gatewayEnv(options.gatewayName),
      redactionValues,
      timeoutMs: 30_000,
    },
  );
  assertExitZero(rebuiltNativeState, "read representative DCode native state after rebuild");
  const expectedNativeState = `${NATIVE_STATE_CASES.map(([, value]) => value).join("\n")}\n`;
  if (rebuiltNativeState.stdout !== expectedNativeState) {
    throw new Error(
      `DCode representative native state changed after successful rebuild: ${resultText(rebuiltNativeState)}`,
    );
  }
  record("native-state-read:rebuilt", rebuiltNativeState);
  record(
    "sandbox-ready:rebuilt",
    await assertReady(deps, instance.sandboxName, options, "rebuilt", redactionValues),
  );

  const dcodeAction = await deps.sandbox.exec(
    instance.sandboxName,
    ["dcode", "-n", "Reply with exactly one word: PONG", "--json"],
    {
      artifactName: "lifecycle-dcode-action-rebuilt",
      env: gatewayEnv(options.gatewayName),
      redactionValues,
      timeoutMs: DCODE_ACTION_TIMEOUT_MS,
    },
  );
  assertDcodeActionSucceeded(dcodeAction);
  record("dcode-action:rebuilt", dcodeAction);

  return { profile: "dcode-rebuild-invalid-credential", steps };
}
