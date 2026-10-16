// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenShellProviderAdapter } from "../../../adapters/openshell/provider-adapter";
import { createSession } from "../../../state/onboard-session";
import type { SandboxEntry } from "../../../state/registry/types";
import { createSetupInference, type SetupInferenceDeps } from "../../setup-inference";
import { createResumeProviderShim } from "../resume-provider-shim";
import { handleProviderInferenceState } from "./provider-inference";
import {
  activatedRecoveryReceipt,
  baseOptions,
  createDeps,
} from "./provider-inference.test-support";

const mocks = vi.hoisted(() => ({
  entry: null as SandboxEntry | null,
  credential: null as string | null,
}));

vi.mock("../../../credentials/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../credentials/store")>()),
  resolveProviderCredential: vi.fn(() => mocks.credential),
}));

const gatewayName = "nemoclaw-19333";
const sandboxName = "dcode-upgrade";
const model = "nvidia/nemotron-3-ultra-550b-a55b";
const attachment = {
  schemaVersion: 1 as const,
  profileId: "nemoclaw-nvidia-inference-v1" as const,
  providerName: "nemoclaw-nvidia-prod-v1" as const,
  providerId: "native-provider-id",
};

function createHarness(selectedGatewayName = gatewayName, pendingRouteReservation = false) {
  const gatewayName = selectedGatewayName;
  const session = createSession({
    sandboxName,
    provider: "nvidia-prod",
    model,
    endpointUrl: "https://integrate.api.nvidia.com/v1",
    credentialEnv: "NVIDIA_INFERENCE_API_KEY",
    preferredInferenceApi: "openai-completions",
  });
  session.steps.provider_selection.status = "complete";
  session.steps.inference.status = "complete";
  mocks.entry = {
    name: sandboxName,
    gatewayName,
    provider: "nvidia-prod",
    model,
    nativeNvidiaProviderAttachment: attachment,
    ...(pendingRouteReservation
      ? { pendingRouteReservation: true as const, reservationSessionId: session.sessionId }
      : {}),
  };
  const ownership = { valid: true };
  const metadata = {
    name: attachment.providerName,
    type: attachment.profileId,
    credentialKeys: ["NVIDIA_INFERENCE_API_KEY"],
    configKeys: [],
    revision: { id: attachment.providerId, resourceVersion: 4 },
  };
  const getProvider = vi.fn<OpenShellProviderAdapter["getProvider"]>(async () => ({
    ok: true,
    value: metadata,
  }));
  const createProvider = vi.fn<OpenShellProviderAdapter["createProvider"]>();
  const updateProvider = vi.fn<OpenShellProviderAdapter["updateProvider"]>();
  const updateSandbox = vi.fn(() => true);
  const verifyOnboardInferenceSmoke = vi.fn(async () => undefined);
  const setupInference = createSetupInference({
    checkGatewayRouteCompatibility: vi.fn(() => ({ ok: true as const })),
    withSandboxMutationLock: async <T>(_name: string, operation: () => Promise<T> | T) =>
      await operation(),
    withGatewayRouteMutationLock: async <T>(_name: string, operation: () => Promise<T> | T) =>
      await operation(),
    step: vi.fn(),
    getGatewayName: () => gatewayName,
    runOpenshell: vi.fn(() => ({ status: 0, stdout: "", stderr: "" })),
    updateSandbox,
    getSandbox: () => mocks.entry,
    localInference: { loadPendingOllamaModelCleanup: () => [] },
    withOllamaModelOwnershipLock: <T>(operation: () => T) => operation(),
    upsertProvider: vi.fn(async () => ({ ok: true })),
    verifyInferenceRoute: vi.fn(),
    verifyOnboardInferenceSmoke,
    isNonInteractive: () => true,
    hermesProviderAuth: { HERMES_PROVIDER_NAME: "hermes-provider" },
    providerAdapter: {
      ensureProviderPolicyComposition: vi.fn(async () => ({ ok: true, value: undefined })),
      importProviderProfile: vi.fn(async () => ({ ok: true })),
      getProvider,
      createProvider,
      updateProvider,
    } as unknown as OpenShellProviderAdapter,
    hydrateCredentialEnv: () => mocks.credential,
    redact: (value: string) => value,
    compactText: (value: string) => value,
    log: vi.fn(),
    error: vi.fn(),
    exitProcess: (code: number): never => {
      throw new Error(`exit ${code}`);
    },
  } as unknown as SetupInferenceDeps);
  const providerExistsInGateway = vi.fn((name: string) => name === attachment.providerName);
  const shim = createResumeProviderShim({
    getSandbox: () => mocks.entry,
    isNonInteractive: () => true,
    providerExistsInGateway,
    isRoutedInferenceProvider: () => false,
    replaceNamedCredential: vi.fn(),
  });
  const recoveryAuthority = vi.fn<() => "authorized" | "unauthorized">(() => "authorized");
  const { deps, calls } = createDeps({
    ...shim,
    getSandboxRecoveryAuthority: recoveryAuthority,
    hydrateCredentialEnv: () => mocks.credential,
    isInferenceRouteReady: () => true,
    setupInference: (...args) => {
      recoveryAuthority.mockImplementation(() => (ownership.valid ? "authorized" : "unauthorized"));
      return setupInference(...args);
    },
  });
  calls.complete.mockResolvedValue(session);
  const { receipt, ledger } = activatedRecoveryReceipt({
    sandboxName,
    gatewayName,
    sessionId: session.sessionId,
    provider: "nvidia-prod",
    model,
    endpointUrl: session.endpointUrl,
    preferredInferenceApi: session.preferredInferenceApi,
  });
  const options = {
    ...baseOptions(deps, session),
    gatewayName,
    sandboxName,
    agent: { name: "langchain-deepagents-code" },
    resume: true,
    authoritativeResumeConfig: true,
    providerRecoveryReceipt: receipt,
    providerRecoveryReceiptLedger: ledger,
  };
  return {
    options,
    metadata,
    ownership,
    providerExistsInGateway,
    getProvider,
    createProvider,
    updateProvider,
    updateSandbox,
    verifyOnboardInferenceSmoke,
    calls,
  };
}

describe("native NVIDIA provider resume", () => {
  beforeEach(() => {
    mocks.credential = null;
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(process, "exit").mockImplementation((code): never => {
      throw new Error(`exit ${code}`);
    });
  });

  it.each([
    {
      state: "a pending route reservation",
      pendingRouteReservation: true,
      reservationCalls: [
        [sandboxName, expect.objectContaining({ nativeNvidiaProviderAttachment: attachment })],
      ],
    },
    {
      state: "a published route before backup",
      pendingRouteReservation: false,
      reservationCalls: [],
    },
  ])(
    "resumes a native provider from $state without a host key (#13168)",
    async ({ pendingRouteReservation, reservationCalls }) => {
      const h = createHarness(gatewayName, pendingRouteReservation);
      await expect(handleProviderInferenceState(h.options)).resolves.toMatchObject({
        provider: "nvidia-prod",
        model,
      });
      expect(h.providerExistsInGateway).not.toHaveBeenCalled();
      expect(h.getProvider).toHaveBeenCalledWith(
        expect.objectContaining({
          providerName: attachment.providerName,
          target: { kind: "named", gatewayName },
        }),
      );
      expect(h.createProvider).not.toHaveBeenCalled();
      expect(h.updateProvider).not.toHaveBeenCalled();
      expect(h.verifyOnboardInferenceSmoke).not.toHaveBeenCalled();
      expect(h.calls.setupNim).not.toHaveBeenCalled();
      expect(h.updateSandbox.mock.calls).toEqual(reservationCalls);
    },
  );

  it.each([
    {
      label: "port-only gateway",
      gateway: gatewayName,
      update: { gatewayName: undefined, gatewayPort: 19333 },
    },
    {
      label: "canonical port over stale name",
      gateway: gatewayName,
      update: { gatewayName: "nemoclaw-19334", gatewayPort: 19333 },
    },
    { label: "default gateway", gateway: "nemoclaw", update: { gatewayName: undefined } },
    { label: "normalized provider", gateway: gatewayName, update: { provider: " nvidia-prod " } },
  ])("preserves preflight recovery for a $label record", async ({ gateway, update }) => {
    const h = createHarness(gateway);
    Object.assign(mocks.entry!, update);
    await expect(handleProviderInferenceState(h.options)).resolves.toMatchObject({
      provider: "nvidia-prod",
      model,
    });
    expect(h.getProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { kind: "named", gatewayName: gateway },
      }),
    );
    expect(h.createProvider).not.toHaveBeenCalled();
    expect(h.updateProvider).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "replaced provider",
      update: { revision: { id: "replacement-id", resourceVersion: 5 } },
      error: /identity|ownership|replaced/iu,
    },
    {
      label: "wrong profile",
      update: { type: "openai" },
      error: /does not match.*inference boundary/u,
    },
    {
      label: "missing credential",
      update: { credentialKeys: [] },
      error: /does not match.*inference boundary/u,
    },
  ])("rejects $label during native setup", async ({ update, error }) => {
    const h = createHarness();
    Object.assign(h.metadata, update);
    await expect(handleProviderInferenceState(h.options)).rejects.toThrow(error);
    expect(h.getProvider).toHaveBeenCalled();
    expect(h.createProvider).not.toHaveBeenCalled();
    expect(h.updateProvider).not.toHaveBeenCalled();
    expect(h.updateSandbox).not.toHaveBeenCalled();
  });

  it("refuses a missing native registration without creating another provider", async () => {
    const h = createHarness();
    h.getProvider.mockResolvedValue({
      ok: false,
      error: { kind: "command", reason: "not_found", message: "provider not found" },
    });
    await expect(handleProviderInferenceState(h.options)).rejects.toThrow(
      /missing|no longer|not found/iu,
    );
    expect(h.createProvider).not.toHaveBeenCalled();
    expect(h.updateProvider).not.toHaveBeenCalled();
    expect(h.updateSandbox).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "another gateway",
      update: { gatewayName: "nemoclaw-19334" },
      error: /does not match the resume target/u,
    },
    {
      label: "another provider",
      update: { provider: "compatible-endpoint" },
      error: /Invalid native provider attachment/u,
    },
    {
      label: "malformed attachment",
      update: { nativeNvidiaProviderAttachment: { ...attachment, providerId: "" } },
      error: /Invalid native provider attachment/u,
    },
  ])("refuses a recorded selection with $label", async ({ update, error }) => {
    const h = createHarness();
    Object.assign(mocks.entry!, update);
    await expect(handleProviderInferenceState(h.options)).rejects.toThrow(error);
    expect(h.getProvider).not.toHaveBeenCalled();
    expect(h.providerExistsInGateway).not.toHaveBeenCalled();
    expect(h.createProvider).not.toHaveBeenCalled();
  });

  it("does not select native recovery without sandbox recovery authority", async () => {
    const h = createHarness();
    h.options.deps.getSandboxRecoveryAuthority = () => "unauthorized";
    await expect(handleProviderInferenceState(h.options)).rejects.toThrow("exit 1");
    expect(h.getProvider).not.toHaveBeenCalled();
    expect(h.updateSandbox).not.toHaveBeenCalled();
  });

  it("uses the NVIDIA credential slot for a retained native provider", async () => {
    const h = createHarness();
    h.options.initial.credentialEnv = "COMPATIBLE_API_KEY";
    await expect(handleProviderInferenceState(h.options)).resolves.toMatchObject({
      credentialEnv: "NVIDIA_INFERENCE_API_KEY",
    });
    expect(h.createProvider).not.toHaveBeenCalled();
    expect(h.updateProvider).not.toHaveBeenCalled();
  });

  it("rechecks recovery ownership before native provider access", async () => {
    const h = createHarness();
    h.ownership.valid = false;
    await expect(handleProviderInferenceState(h.options)).rejects.toThrow("exit 1");
    expect(h.getProvider).not.toHaveBeenCalled();
    expect(h.createProvider).not.toHaveBeenCalled();
    expect(h.updateSandbox).not.toHaveBeenCalled();
  });

  it("keeps invalid host credentials out of native setup", async () => {
    const h = createHarness();
    mocks.credential = "invalid-local-key";
    await expect(handleProviderInferenceState(h.options)).rejects.toThrow("exit 1");
    expect(h.getProvider).not.toHaveBeenCalled();
    expect(h.createProvider).not.toHaveBeenCalled();
    expect(h.updateProvider).not.toHaveBeenCalled();
  });

  it("keeps a valid host credential on the existing native update path", async () => {
    const h = createHarness();
    mocks.credential = "nvapi-test-key";
    h.updateProvider.mockResolvedValue({ ok: true });
    await expect(handleProviderInferenceState(h.options)).resolves.toMatchObject({
      provider: "nvidia-prod",
    });
    expect(h.createProvider).not.toHaveBeenCalled();
    expect(h.updateProvider).toHaveBeenCalledOnce();
    expect(h.verifyOnboardInferenceSmoke).toHaveBeenCalledOnce();
  });

  it("keeps a registered legacy provider on its existing resume path", async () => {
    const h = createHarness();
    delete mocks.entry!.nativeNvidiaProviderAttachment;
    h.providerExistsInGateway.mockImplementation((name) => name === "nvidia-prod");
    await expect(handleProviderInferenceState(h.options)).resolves.toMatchObject({
      provider: "nvidia-prod",
    });
    expect(h.providerExistsInGateway).toHaveBeenCalledWith("nvidia-prod", gatewayName);
    expect(h.getProvider).not.toHaveBeenCalled();
    expect(h.updateSandbox).not.toHaveBeenCalled();
  });
});
