// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { expect, it, vi } from "vitest";
import YAML from "yaml";
import { buildNativeCustomSandboxPolicy } from "../inference/native-custom/network-policy";
import type {
  OpenShellProviderAdapter,
  OpenShellProviderMetadata,
} from "../adapters/openshell/provider-adapter";
import {
  prepareNativeCustomProfile,
  customAttachmentFromPrepared,
  type NativeCustomProfile,
  type NativeCustomProviderAttachment,
} from "../inference/native-custom";
import { runInferenceSet } from "./inference-set";
import { buildNativeCustomProfile } from "../inference/native-custom/profile";
import { hostedNativeProvider } from "../inference/native-provider/hosted";
import { buildHttpsPinRouteBaseUrl, computeHttpsPinRouteId } from "../inference/https-pin-runtime";
import { baseSession, createDeps, HERMES_TARGET } from "../../../test/helpers/inference-set";

const hostLocalSelection = {
  provider: "compatible-endpoint",
  model: "local-model",
  endpointUrl: "http://127.0.0.1:8000/v1",
  credentialEnv: "COMPATIBLE_API_KEY",
  inferenceApi: "openai-completions",
};

async function fixture(agent = "openclaw", preparedProfile?: NativeCustomProfile) {
  const prepared =
    preparedProfile ??
    (await prepareNativeCustomProfile({
      sandboxName: "alpha",
      provider: "compatible-endpoint",
      endpointUrl: "http://8.8.8.8/v1",
      api: "openai-completions",
    }));
  const receipt = customAttachmentFromPrepared(prepared, {
    schemaVersion: 1,
    profileId: prepared.profile.id,
    providerName: prepared.providerName,
    providerId: "old-provider",
  });
  const metadata = new Map<string, OpenShellProviderMetadata>([
    [
      receipt.providerName,
      {
        name: receipt.providerName,
        type: receipt.profileId,
        credentialKeys: [receipt.credentialEnv],
        configKeys: [],
        revision: { id: receipt.providerId, resourceVersion: 1 },
      },
    ],
  ]);
  const attachments = new Set([receipt.providerName]);
  const authority = new Map<string, NativeCustomProviderAttachment>([
    [receipt.providerName, receipt],
  ]);
  const events: string[] = [];
  const adapter = {
    importProviderProfile: vi.fn(async () => ({ ok: true })),
    ensureProviderPolicyComposition: vi.fn(async () => ({ ok: true })),
    getProvider: vi.fn(
      async ({ providerName }: Parameters<OpenShellProviderAdapter["getProvider"]>[0]) =>
        metadata.has(providerName)
          ? { ok: true, value: metadata.get(providerName)! }
          : { ok: false, error: { kind: "command", reason: "not_found", message: "missing" } },
    ),
    createProvider: vi.fn(
      async (request: Parameters<OpenShellProviderAdapter["createProvider"]>[0]) => {
        metadata.set(request.name, {
          name: request.name,
          type: request.type,
          credentialKeys: request.credentials.map((key) => key.name),
          configKeys: request.config.map((item) => item.key),
          revision: { id: `id-${request.name}`, resourceVersion: 1 },
        });
        return { ok: true };
      },
    ),
    updateProvider: vi.fn(async () => ({ ok: true })),
    listProviderAttachments: vi.fn(async () => ({ ok: true, value: { names: [...attachments] } })),
    attachProvider: vi.fn(
      async (request: Parameters<OpenShellProviderAdapter["attachProvider"]>[0]) => {
        events.push(`attach:${request.providerName}`);
        attachments.add(request.providerName);
        return { ok: true };
      },
    ),
    detachProvider: vi.fn(
      async (request: Parameters<OpenShellProviderAdapter["detachProvider"]>[0]) => {
        events.push(`detach:${request.providerName}`);
        attachments.delete(request.providerName);
        return { ok: true, value: { changed: true } };
      },
    ),
  } as unknown as OpenShellProviderAdapter;
  const entry = {
    name: "alpha",
    agent,
    provider: "compatible-endpoint",
    model: "old-model",
    endpointUrl: prepared.endpointUrl,
    credentialEnv: receipt.credentialEnv,
    preferredInferenceApi: prepared.api,
    nativeCustomProviderAttachment: receipt,
    gatewayName: "nemoclaw",
    openshellDriver: "docker",
  };
  const config = {
    agents: { defaults: { model: { primary: "inference/old-model" } } },
    models: {
      providers: {
        inference: {
          baseUrl: prepared.endpointUrl,
          api: "openai-completions",
          apiKey: "openshell:resolve:env:v1_COMPATIBLE_API_KEY",
          models: [],
        },
      },
    },
    unrelated: { preserve: true },
  };
  const deps = createDeps({
    config,
    entry,
    providerAdapter: adapter,
    target: agent === "hermes" ? HERMES_TARGET : undefined,
    resolveCredentialValue: () => "host-secret",
    updateSandbox: (_name, patch) => {
      Object.assign(entry, patch);
      return true;
    },
  });
  deps.getNativeCustomProviderAuthority = (_gateway, name) => authority.get(name);
  deps.setNativeCustomProviderAuthority = (_gateway, value) => {
    events.push("persist");
    authority.set(value.providerName, value);
  };
  deps.resolveNativeCustomCredentialReference = vi.fn(
    async () => "openshell:resolve:env:v12_COMPATIBLE_API_KEY",
  );
  let policy = buildNativeCustomSandboxPolicy("version: 1\nnetwork_policies: {}\n", receipt);
  const reconcileNativeCustomSandboxPolicy = vi.fn(
    async (input: {
      previous?: NativeCustomProviderAttachment;
      next?: NativeCustomProviderAttachment;
    }) => {
      const before = policy;
      const parsed = YAML.parse(policy);
      delete parsed.network_policies.native_custom_inference;
      policy = input.next
        ? buildNativeCustomSandboxPolicy(YAML.stringify(parsed), input.next)
        : YAML.stringify(parsed);
      return async () => {
        policy = before;
      };
    },
  );
  Object.assign(deps, { reconcileNativeCustomSandboxPolicy });
  vi.spyOn(deps.inferenceRouteMutator, "setInferenceRoute");
  return {
    deps,
    receipt,
    metadata,
    entry,
    events,
    attachments,
    adapter,
    config,
    get policy() {
      return YAML.parse(policy);
    },
  };
}

it("switches a native custom model without rotating credentials or consulting shared inference (#12636)", async () => {
  const f = await fixture();
  const result = await runInferenceSet(
    { provider: "compatible-endpoint", model: "new-model" },
    f.deps,
  );
  expect(result.inSandboxConfigSynced).toBe(true);
  expect(f.adapter.updateProvider).not.toHaveBeenCalled();
  expect(f.adapter.createProvider).not.toHaveBeenCalled();
  expect(f.deps.inferenceRouteObserver.observeInferenceRoute).not.toHaveBeenCalled();
  expect(f.deps.inferenceRouteMutator.setInferenceRoute).not.toHaveBeenCalled();
  expect(f.deps.calls.probeSandboxRoute).toHaveBeenCalledWith(
    expect.objectContaining({ model: "new-model", nativeCustomProviderAttachment: f.receipt }),
  );
  expect(f.config.models.providers.inference).toMatchObject({
    baseUrl: "http://8.8.8.8/v1",
    apiKey: "openshell:resolve:env:v12_COMPATIBLE_API_KEY",
  });
  expect(f.config.unrelated).toEqual({ preserve: true });
});

it.each(["openclaw", "hermes"] as const)(
  "detaches the prior %s native credential binding before attaching a different endpoint (#12636)",
  async (agent) => {
    const f = await fixture(agent);
    vi.mocked(f.deps.resolveNativeCustomCredentialReference!)
      .mockResolvedValueOnce("openshell:resolve:env:v12_COMPATIBLE_API_KEY")
      .mockResolvedValueOnce("openshell:resolve:env:v13_COMPATIBLE_API_KEY");
    await runInferenceSet(
      {
        provider: "compatible-endpoint",
        model: "new-model",
        endpointUrl: "http://12.12.12.12/v1",
        credentialEnv: "COMPATIBLE_API_KEY",
        inferenceApi: "openai-completions",
      },
      f.deps,
    );
    const next = f.entry.nativeCustomProviderAttachment;
    expect(f.events.indexOf(`detach:${f.receipt.providerName}`)).toBeLessThan(
      f.events.indexOf(`attach:${next.providerName}`),
    );
    expect([...f.attachments]).toEqual([next.providerName]);
    expect(f.entry.endpointUrl).toBe("http://12.12.12.12/v1");
    expect(f.policy.network_policies.native_custom_inference.endpoints).toEqual(
      expect.arrayContaining([expect.objectContaining({ host: "12.12.12.12" })]),
    );
    expect(JSON.stringify(f.policy)).not.toContain("8.8.8.8");
    expect(JSON.stringify(f.entry)).not.toContain("host-secret");
    expect(f.deps.resolveNativeCustomCredentialReference).toHaveBeenLastCalledWith({
      sandboxName: "alpha",
      gatewayName: "nemoclaw",
      credentialEnv: "COMPATIBLE_API_KEY",
      replacedReference: "openshell:resolve:env:v12_COMPATIBLE_API_KEY",
    });
  },
);

it("restores the previous attachment when a native selected-model probe fails (#12636)", async () => {
  const f = await fixture();
  f.deps.calls.probeSandboxRoute.mockResolvedValue({
    ok: false,
    detail: "private upstream diagnostic",
    httpStatus: 401,
    endpoint: "selected",
  });
  await expect(
    runInferenceSet(
      {
        provider: "compatible-endpoint",
        model: "new-model",
        endpointUrl: "http://12.12.12.12/v1",
        credentialEnv: "COMPATIBLE_API_KEY",
        inferenceApi: "openai-completions",
      },
      f.deps,
    ),
  ).rejects.toThrow("The selected native custom model request did not succeed. HTTP 401.");
  expect([...f.attachments]).toEqual([f.receipt.providerName]);
  expect(f.entry.model).toBe("old-model");
  expect(f.deps.calls.setOpenClawConfigValues).not.toHaveBeenCalled();
});

it.each([
  {
    failure: "creation",
    operation: "createProvider",
    cleanupConfirmed: true,
    recoveryConfirmed: true,
    expectedFailure: (original: Error, _routeId: string) => original,
  },
  {
    failure: "attachment",
    operation: "attachProvider",
    cleanupConfirmed: true,
    recoveryConfirmed: true,
    expectedFailure: (original: Error, _routeId: string) => original,
  },
  {
    failure: "unconfirmed cleanup",
    operation: "createProvider",
    cleanupConfirmed: false,
    recoveryConfirmed: true,
    expectedFailure: (original: Error, routeId: string) =>
      expect.objectContaining({
        constructor: AggregateError,
        cause: original,
        errors: [
          original,
          expect.objectContaining({
            message: expect.stringContaining(`route '${routeId}' cleanup could not be confirmed`),
          }),
        ],
      }),
  },
  {
    failure: "unconfirmed attachment recovery",
    operation: "attachProvider",
    cleanupConfirmed: true,
    recoveryConfirmed: false,
    expectedFailure: (_original: Error, routeId: string) =>
      expect.objectContaining({
        message: expect.stringContaining(`HTTPS adapter route '${routeId}' is retained`),
      }),
  },
] as const)(
  "preserves HTTPS rollback ownership after provider $failure fails (#12636)",
  async ({ operation, cleanupConfirmed, recoveryConfirmed, expectedFailure }) => {
    const f = await fixture();
    const endpointUrl = "https://api.example.com/v1";
    const routeId = computeHttpsPinRouteId("nemoclaw", "compatible-endpoint", endpointUrl, "alpha");
    const routes = new Set<string>();
    f.deps.nativeCustomEndpointLookup = async () => [{ address: "8.8.8.8", family: 4 }];
    f.deps.nativeCustomTransportDeps = {
      discoverAllowedSourceCidrs: () => ["172.18.0.0/16"],
      ensureHttpsAdapter: vi.fn(async () => {
        routes.add(routeId);
        return {
          baseUrl: buildHttpsPinRouteBaseUrl(routeId),
          localBaseUrl: `http://127.0.0.1:11438/route/${routeId}`,
          logPath: "/owned/adapter.log",
          credentialEnv: "NEMOCLAW_HTTPS_PIN_RUNTIME_ADAPTER_TOKEN",
          token: "adapter-token",
          routeId,
          pinnedAddresses: ["8.8.8.8"],
        };
      }),
    };
    f.deps.revokeHttpsPinRuntimeAdapterRoute = vi.fn(
      async (id) => cleanupConfirmed && routes.delete(id),
    );
    const originalFailure = new Error("provider operation failed");
    vi.mocked(f.adapter[operation]).mockRejectedValueOnce(originalFailure);
    const detach = vi.mocked(f.adapter.detachProvider);
    const originalDetach = detach.getMockImplementation()!;
    detach.mockImplementationOnce(originalDetach).mockImplementationOnce(
      recoveryConfirmed
        ? originalDetach
        : async () => {
            throw new Error("private attachment recovery diagnostic");
          },
    );
    const failure = await runInferenceSet(
      {
        provider: "compatible-endpoint",
        model: "new-model",
        endpointUrl,
        credentialEnv: "COMPATIBLE_API_KEY",
        inferenceApi: "openai-completions",
      },
      f.deps,
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).toEqual(expectedFailure(originalFailure, routeId));
    expect(f.deps.nativeCustomTransportDeps.ensureHttpsAdapter).toHaveBeenCalledOnce();
    expect(vi.mocked(f.deps.revokeHttpsPinRuntimeAdapterRoute).mock.calls).toEqual(
      recoveryConfirmed ? [[routeId]] : [],
    );
    expect(routes.size).toBe(cleanupConfirmed && recoveryConfirmed ? 0 : 1);
    expect([...f.attachments]).toEqual(recoveryConfirmed ? [f.receipt.providerName] : []);
    expect(f.entry.nativeCustomProviderAttachment).toEqual(f.receipt);
  },
);

it("retains the previous HTTPS adapter route after a same-endpoint model probe fails (#12636)", async () => {
  const sourceEndpointUrl = "https://api.example.com/v1";
  const routeId = computeHttpsPinRouteId(
    "nemoclaw",
    "compatible-endpoint",
    sourceEndpointUrl,
    "alpha",
  );
  const prepared = {
    ...buildNativeCustomProfile({
      sandboxName: "alpha",
      provider: "compatible-endpoint",
      api: "openai-completions",
      endpointUrl: `${buildHttpsPinRouteBaseUrl(routeId)}/v1`,
      addresses: [],
      transport: {
        kind: "https-pin",
        gatewayName: "nemoclaw",
        sourceEndpointUrl,
        sourceAddresses: ["8.8.8.8"],
        trustedPrivateEndpoint: false,
      },
    }),
    trustedPrivateEndpoint: false,
  };
  const f = await fixture("openclaw", prepared);
  f.deps.nativeCustomEndpointLookup = async () => [{ address: "8.8.8.8", family: 4 }];
  f.deps.nativeCustomTransportDeps = {
    discoverAllowedSourceCidrs: () => ["172.18.0.0/16"],
    ensureHttpsAdapter: vi.fn(async () => ({
      baseUrl: buildHttpsPinRouteBaseUrl(routeId),
      localBaseUrl: `http://127.0.0.1:11438/route/${routeId}`,
      logPath: "/owned/adapter.log",
      credentialEnv: "NEMOCLAW_HTTPS_PIN_RUNTIME_ADAPTER_TOKEN",
      token: "adapter-token",
      routeId,
      pinnedAddresses: ["8.8.8.8"],
    })),
  };
  f.deps.calls.probeSandboxRoute.mockResolvedValue({
    ok: false,
    httpStatus: 401,
    detail: "private diagnostic",
    endpoint: "selected",
  });
  await expect(
    runInferenceSet(
      {
        provider: "compatible-endpoint",
        model: "new-model",
        endpointUrl: sourceEndpointUrl,
        credentialEnv: "COMPATIBLE_API_KEY",
        inferenceApi: "openai-completions",
      },
      f.deps,
    ),
  ).rejects.toThrow(/did not succeed/);
  expect(f.deps.nativeCustomTransportDeps.ensureHttpsAdapter).toHaveBeenCalledOnce();
  expect(f.deps.revokeHttpsPinRuntimeAdapterRoute).not.toHaveBeenCalled();
  expect([...f.attachments]).toEqual([f.receipt.providerName]);
  expect(f.entry.nativeCustomProviderAttachment).toEqual(f.receipt);
});

it("writes matching Hermes credential templates rather than the shared-route sentinel (#12636)", async () => {
  const f = await fixture("hermes");
  await runInferenceSet({ provider: "compatible-endpoint", model: "new-model" }, f.deps);
  expect(f.deps.calls.restartSandboxGateway).not.toHaveBeenCalled();
  const written = f.deps.calls.writeSandboxConfig.mock.calls[0][2];
  expect(written.model).toMatchObject({
    base_url: f.receipt.endpointUrl,
    api_key: "${COMPATIBLE_API_KEY}",
  });
  expect(written.unrelated).toEqual({ preserve: true });
  expect(JSON.stringify(written)).not.toContain("host-secret");
});

it("observes an unchanged registry after a rejected write and restores only the prior attachment (#12636)", async () => {
  const f = await fixture();
  f.deps.calls.updateSandbox.mockReturnValueOnce(false);
  await expect(
    runInferenceSet(
      {
        provider: "compatible-endpoint",
        model: "new-model",
        endpointUrl: "http://12.12.12.12/v1",
        credentialEnv: "COMPATIBLE_API_KEY",
        inferenceApi: "openai-completions",
      },
      f.deps,
    ),
  ).rejects.toThrow(/could not be persisted/);
  expect([...f.attachments]).toEqual([f.receipt.providerName]);
  expect(f.entry.nativeCustomProviderAttachment).toEqual(f.receipt);
  expect(f.entry.model).toBe("old-model");
});

it("retains an observed registry commit after an uncertain write and lets the same command converge (#12636)", async () => {
  const f = await fixture();
  f.deps.calls.updateSandbox.mockImplementationOnce((_name, patch) => {
    Object.assign(f.entry, patch);
    throw new Error("private state diagnostic");
  });
  const options = {
    provider: "compatible-endpoint",
    model: "new-model",
    endpointUrl: "http://12.12.12.12/v1",
    credentialEnv: "COMPATIBLE_API_KEY",
    inferenceApi: "openai-completions",
  };
  await expect(runInferenceSet(options, f.deps)).rejects.toThrow(/synchronization is incomplete/);
  expect([...f.attachments]).toEqual([f.entry.nativeCustomProviderAttachment.providerName]);
  expect(f.entry.model).toBe("new-model");
  expect(
    await runInferenceSet({ provider: "compatible-endpoint", model: "new-model" }, f.deps),
  ).toMatchObject({ inSandboxConfigSynced: true });
});

it("removes native custom access before publishing a built-in provider (#12636)", async () => {
  const f = await fixture();
  await runInferenceSet({ provider: "openai", model: "gpt-4o" }, f.deps);
  expect([...f.attachments]).toEqual(["nemoclaw-openai-api-v1"]);
  expect(f.entry.provider).toBe("openai-api");
  expect(f.entry.nativeCustomProviderAttachment).toBeUndefined();
  expect(f.policy.network_policies.native_custom_inference).toBeUndefined();
  expect(f.events).toContain(`detach:${f.receipt.providerName}`);
});

it.each(["openclaw", "hermes"])(
  "switches native custom %s inference to the retained host-local route (#12636)",
  async (agent) => {
    const f = await fixture(agent);
    await runInferenceSet(hostLocalSelection, f.deps);
    expect(f.entry.nativeCustomProviderAttachment).toBeUndefined();
    expect(f.entry.model).toBe("local-model");
    expect(f.attachments.has(f.receipt.providerName)).toBe(false);
    expect(f.policy.network_policies.native_custom_inference).toBeUndefined();
    expect(f.deps.inferenceRouteMutator.setInferenceRoute).toHaveBeenCalled();
    expect(f.deps.calls.restartSandboxGateway).toHaveBeenCalledExactlyOnceWith("alpha", "nemoclaw");
    expect(f.adapter.createProvider).toHaveBeenCalledWith(
      expect.objectContaining({ name: "compatible-endpoint", type: "openai" }),
    );
  },
);

it.each(["openclaw", "hermes"])(
  "uses the matching session endpoint when switching %s from another provider (#12636)",
  async (agent) => {
    const f = await fixture(agent);
    await runInferenceSet({ provider: "openai", model: "gpt-4o" }, f.deps);
    f.entry.endpointUrl = "http://8.8.8.8/v1";
    vi.mocked(f.adapter.createProvider).mockClear();
    f.deps.loadSession = () =>
      baseSession({
        sandboxName: "alpha",
        provider: hostLocalSelection.provider,
        model: hostLocalSelection.model,
        endpointUrl: hostLocalSelection.endpointUrl,
        credentialEnv: hostLocalSelection.credentialEnv,
        preferredInferenceApi: hostLocalSelection.inferenceApi,
      });
    await runInferenceSet(
      { provider: hostLocalSelection.provider, model: hostLocalSelection.model },
      f.deps,
    );
    expect(f.entry.endpointUrl).toBe(hostLocalSelection.endpointUrl);
    expect(f.entry.nativeCustomProviderAttachment).toBeUndefined();
    expect(f.deps.inferenceRouteMutator.setInferenceRoute).toHaveBeenCalled();
    expect(f.adapter.createProvider).not.toHaveBeenCalled();
  },
);

it("preserves the committed host-local Hermes departure when gateway activation fails (#12636)", async () => {
  const f = await fixture("hermes");
  f.deps.calls.restartSandboxGateway.mockResolvedValueOnce({
    ok: false,
    failureLayer: "health timeout",
    detail: "private restart diagnostic",
  });
  await expect(runInferenceSet(hostLocalSelection, f.deps)).rejects.toThrow(
    /managed Hermes gateway restart.*committed route was not rolled back.*alpha gateway restart/,
  );
  expect(f.entry.nativeCustomProviderAttachment).toBeUndefined();
  expect(f.entry.model).toBe("local-model");
  expect(f.attachments.has(f.receipt.providerName)).toBe(false);
  expect(f.adapter.attachProvider).not.toHaveBeenCalled();
  expect(JSON.stringify(f.deps.calls.log.mock.calls)).not.toContain("private restart diagnostic");
});

it("restores native custom authority after rejected host-local departure publication (#12636)", async () => {
  const f = await fixture("hermes");
  f.deps.calls.updateSandbox.mockReturnValueOnce(false);
  await expect(runInferenceSet(hostLocalSelection, f.deps)).rejects.toThrow();
  expect(f.entry.nativeCustomProviderAttachment).toEqual(f.receipt);
  expect(f.attachments.has(f.receipt.providerName)).toBe(true);
  expect(f.policy.network_policies.native_custom_inference.endpoints).toEqual(
    expect.arrayContaining([expect.objectContaining({ host: "8.8.8.8" })]),
  );
  expect(f.deps.calls.restartSandboxGateway).not.toHaveBeenCalled();
});

it("restores native custom access when departure publication is rejected (#12636)", async () => {
  const f = await fixture();
  f.deps.calls.updateSandbox.mockImplementation(() => false);
  await expect(runInferenceSet({ provider: "openai", model: "gpt-4o" }, f.deps)).rejects.toThrow();
  expect([...f.attachments]).toEqual([f.receipt.providerName]);
  expect(f.entry.nativeCustomProviderAttachment).toEqual(f.receipt);
  expect(f.events).toContain(`detach:${f.receipt.providerName}`);
  expect(f.events).toContain(`attach:${f.receipt.providerName}`);
});

it("selects the native OpenAI frontend for a new Hermes custom Anthropic switch (#12636)", async () => {
  const f = await fixture("hermes");
  Object.assign(f.entry, {
    provider: "hermes-provider",
    nativeCustomProviderAttachment: undefined,
  });
  f.attachments.clear();
  vi.mocked(f.deps.resolveNativeCustomCredentialReference!).mockResolvedValue(
    "openshell:resolve:env:v12_COMPATIBLE_ANTHROPIC_API_KEY",
  );
  await runInferenceSet(
    {
      provider: "compatible-anthropic-endpoint",
      model: "claude-model",
      endpointUrl: "http://12.12.12.12/v1",
      credentialEnv: "COMPATIBLE_ANTHROPIC_API_KEY",
    },
    f.deps,
  );
  expect(f.entry.preferredInferenceApi).toBe("openai-completions");
  expect(f.entry.nativeCustomProviderAttachment.api).toBe("openai-completions");
  expect(f.config).toMatchObject({
    model: {
      base_url: "http://12.12.12.12/v1",
      api_key: "${COMPATIBLE_ANTHROPIC_API_KEY}",
    },
  });
  expect(f.deps.inferenceRouteObserver.observeInferenceRoute).not.toHaveBeenCalled();
  expect(f.deps.inferenceRouteMutator.setInferenceRoute).not.toHaveBeenCalled();
});

it.each([
  [
    "policy",
    (f: Awaited<ReturnType<typeof fixture>>) => {
      vi.mocked(f.deps.reconcileNativeCustomSandboxPolicy!).mockRejectedValueOnce(
        new Error("handoff unconfirmed"),
      );
    },
  ],
  [
    "previous reference",
    (f: Awaited<ReturnType<typeof fixture>>) => {
      vi.mocked(f.deps.resolveNativeCustomCredentialReference!).mockRejectedValueOnce(
        new Error("handoff unconfirmed"),
      );
    },
  ],
  [
    "replacement reference",
    (f: Awaited<ReturnType<typeof fixture>>) => {
      vi.mocked(f.deps.resolveNativeCustomCredentialReference!)
        .mockResolvedValueOnce("openshell:resolve:env:v12_COMPATIBLE_API_KEY")
        .mockRejectedValueOnce(new Error("handoff unconfirmed"));
    },
  ],
] as const)(
  "restores native custom access after an unverified %s handoff (#12636)",
  async (_phase, fail) => {
    const f = await fixture();
    const previousPolicy = f.policy;
    fail(f);
    await expect(
      runInferenceSet(
        {
          provider: "compatible-endpoint",
          model: "new-model",
          endpointUrl: "http://12.12.12.12/v1",
          credentialEnv: "COMPATIBLE_API_KEY",
          inferenceApi: "openai-completions",
        },
        f.deps,
      ),
    ).rejects.toThrow(/handoff unconfirmed/);
    expect([...f.attachments]).toEqual([f.receipt.providerName]);
    expect(f.policy).toEqual(previousPolicy);
    expect(f.deps.calls.updateSandbox).not.toHaveBeenCalled();
    expect(f.deps.calls.probeSandboxRoute).not.toHaveBeenCalled();
  },
);

it("keeps the previous custom policy when departure publication is rejected (#12636)", async () => {
  const f = await fixture();
  f.deps.calls.updateSandbox.mockReturnValueOnce(false);
  await expect(runInferenceSet({ provider: "openai", model: "gpt-4o" }, f.deps)).rejects.toThrow();
  expect(f.policy.network_policies.native_custom_inference.endpoints).toEqual(
    expect.arrayContaining([expect.objectContaining({ host: "8.8.8.8" })]),
  );
  expect([...f.attachments]).toEqual([f.receipt.providerName]);
});

it.each(["openai", "compatible-endpoint"])(
  "retains the native attachment when switching to %s without gateway authority (#12636)",
  async (provider) => {
    const f = await fixture();
    f.deps.getNativeCustomProviderAuthority = () => undefined;
    await expect(runInferenceSet({ provider, model: "new-model" }, f.deps)).rejects.toThrow(
      "authority disagree",
    );
    expect(f.adapter.detachProvider).not.toHaveBeenCalled();
    expect(f.deps.calls.updateSandbox).not.toHaveBeenCalled();
    expect(f.entry.nativeCustomProviderAttachment).toEqual(f.receipt);
  },
);

it("retries owned custom retirement after the departure receipt has been cleared (#12636)", async () => {
  const f = await fixture();
  const retire = vi.fn(async () => undefined);
  retire.mockRejectedValueOnce(new Error("retirement unavailable"));
  f.deps.retireNativeCustomProviders = retire;
  await expect(runInferenceSet({ provider: "openai", model: "gpt-4o" }, f.deps)).rejects.toThrow(
    "retirement unavailable",
  );
  expect(f.entry.nativeCustomProviderAttachment).toBeUndefined();
  expect(f.entry.provider).toBe("openai-api");
  await runInferenceSet({ provider: "openai", model: "gpt-4o" }, f.deps);
  expect(retire).toHaveBeenCalledTimes(2);
  expect(retire).toHaveBeenLastCalledWith({
    gatewayName: "nemoclaw",
    sandboxName: "alpha",
    adapter: f.adapter,
  });
});

async function fixedHostedFixture(agent: string) {
  const f = await fixture(agent);
  const definition = hostedNativeProvider("openai-api")!;
  const fixed = {
    schemaVersion: 1 as const,
    profileId: definition.profileId,
    providerName: definition.providerName,
    providerId: "11111111-2222-4333-8444-555555555555",
  };
  Reflect.deleteProperty(f.entry, "nativeCustomProviderAttachment");
  Object.assign(f.entry, {
    provider: "openai-api",
    endpointUrl: definition.endpoint,
    credentialEnv: definition.credentialEnv,
    nativeHostedProviderAttachment: fixed,
  });
  f.attachments.clear();
  f.attachments.add(fixed.providerName);
  f.metadata.set(fixed.providerName, {
    name: fixed.providerName,
    type: fixed.profileId,
    credentialKeys: [definition.credentialEnv],
    configKeys: [],
    revision: { id: fixed.providerId, resourceVersion: 1 },
  });
  return { ...f, fixed };
}
const customEndpointSelection = {
  provider: "compatible-endpoint",
  model: "new-model",
  endpointUrl: "http://12.12.12.12/v1",
  credentialEnv: "COMPATIBLE_API_KEY",
  inferenceApi: "openai-completions",
};

it.each(["openclaw", "hermes"])(
  "replaces the fixed hosted attachment before publishing a native custom %s selection (#12636)",
  async (agent) => {
    const f = await fixedHostedFixture(agent);
    await runInferenceSet(customEndpointSelection, f.deps);
    expect(f.deps.calls.restartSandboxGateway).toHaveBeenCalledExactlyOnceWith("alpha", "nemoclaw");
    const selected = f.entry.nativeCustomProviderAttachment;
    expect([...f.attachments]).toEqual([selected.providerName]);
    expect(f.events.indexOf(`detach:${f.fixed.providerName}`)).toBeLessThan(
      f.events.indexOf(`attach:${selected.providerName}`),
    );
    expect(f.entry).toMatchObject({
      provider: "compatible-endpoint",
      nativeHostedProviderAttachment: undefined,
    });
    expect(f.deps.inferenceRouteMutator.setInferenceRoute).not.toHaveBeenCalled();
  },
);

it.each(["openclaw", "hermes"])(
  "restores fixed hosted authority after a failed custom %s model probe (#12636)",
  async (agent) => {
    const f = await fixedHostedFixture(agent);
    f.deps.calls.probeSandboxRoute.mockResolvedValueOnce({
      ok: false,
      detail: "rejected",
      httpStatus: 401,
    });
    await expect(runInferenceSet(customEndpointSelection, f.deps)).rejects.toThrow("HTTP 401");
    expect([...f.attachments]).toEqual([f.fixed.providerName]);
    expect(f.entry).toMatchObject({
      provider: "openai-api",
      nativeHostedProviderAttachment: f.fixed,
    });
    expect(f.events).toContain(`detach:${f.fixed.providerName}`);
    expect(f.events).toContain(`attach:${f.fixed.providerName}`);
    expect(f.deps.calls.updateSandbox).not.toHaveBeenCalled();
  },
);

it.each(["openclaw", "hermes"])(
  "rejects replaced fixed hosted identity before changing a native custom %s selection (#12636)",
  async (agent) => {
    const f = await fixedHostedFixture(agent);
    f.metadata.set(f.fixed.providerName, {
      ...f.metadata.get(f.fixed.providerName)!,
      revision: { id: "22222222-2222-4333-8444-555555555555", resourceVersion: 1 },
    });
    await expect(runInferenceSet(customEndpointSelection, f.deps)).rejects.toThrow(
      "changed identity",
    );
    expect(f.adapter.attachProvider).not.toHaveBeenCalled();
    expect(f.adapter.detachProvider).not.toHaveBeenCalled();
    expect(f.deps.calls.updateSandbox).not.toHaveBeenCalled();
  },
);

it.each([
  ["compatible-endpoint", "openai-completions"],
  ["compatible-anthropic-endpoint", "anthropic-messages"],
  ["compatible-anthropic-endpoint", "openai-responses"],
] as const)(
  "creates native authority for an explicit hosted switch from retained %s (#12636)",
  async (provider, inferenceApi) => {
    const f = await fixture();
    Reflect.deleteProperty(f.entry, "nativeCustomProviderAttachment");
    f.entry.provider = provider;
    f.entry.preferredInferenceApi = inferenceApi;
    f.attachments.clear();
    f.metadata.clear();
    f.deps.resolveNativeCustomCredentialReference = vi.fn(
      async () =>
        `openshell:resolve:env:v12_${provider === "compatible-anthropic-endpoint" ? "COMPATIBLE_ANTHROPIC_API_KEY" : "COMPATIBLE_API_KEY"}`,
    );
    await runInferenceSet(
      {
        provider,
        model: "new-model",
        endpointUrl: "http://12.12.12.12/v1",
        credentialEnv:
          provider === "compatible-anthropic-endpoint"
            ? "COMPATIBLE_ANTHROPIC_API_KEY"
            : "COMPATIBLE_API_KEY",
        inferenceApi,
      },
      f.deps,
    );
    expect(f.adapter.createProvider).toHaveBeenCalledOnce();
    expect(f.config).toMatchObject({
      models: {
        providers: {
          [inferenceApi === "anthropic-messages" ? "anthropic" : "inference"]: {
            api: inferenceApi,
          },
        },
      },
    });
    expect(f.entry.nativeCustomProviderAttachment).toMatchObject({
      endpointUrl:
        inferenceApi === "anthropic-messages" ? "http://12.12.12.12" : "http://12.12.12.12/v1",
      api: inferenceApi,
    });
    expect([...f.attachments]).toEqual([f.entry.nativeCustomProviderAttachment.providerName]);
    expect(f.deps.inferenceRouteMutator.setInferenceRoute).not.toHaveBeenCalled();
    expect(f.deps.calls.probeSandboxRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        nativeCustomProviderAttachment: f.entry.nativeCustomProviderAttachment,
      }),
    );
    expect(JSON.stringify(f.entry)).not.toContain("host-secret");
  },
);

it.each(["openclaw", "hermes"])(
  "restores shared gateway selection after a rejected fixed native %s departure (#12636)",
  async (agent) => {
    const f = await fixedHostedFixture(agent);
    const before = structuredClone(f.entry);
    f.deps.calls.probeSandboxRoute.mockResolvedValue({
      ok: false,
      detail: "rejected",
      httpStatus: 400,
    });
    await expect(
      runInferenceSet(
        { ...hostLocalSelection, endpointUrl: "http://host.openshell.internal:18767/v1" },
        f.deps,
      ),
    ).rejects.toThrow(/Sandbox-side verification rejected/);
    expect(f.deps.inferenceRouteMutator.setInferenceRoute).toHaveBeenLastCalledWith(
      expect.objectContaining({
        route: { provider: "openai-api", model: "old-model" },
        verification: "skip",
      }),
    );
    expect(f.entry).toEqual(before);
    expect([...f.attachments]).toEqual([f.fixed.providerName]);
    expect(f.deps.calls.updateSandbox).not.toHaveBeenCalled();
  },
);

it("rejects fixed native departure without a gateway rollback selection before mutation (#12636)", async () => {
  const f = await fixedHostedFixture("openclaw");
  vi.mocked(f.deps.inferenceRouteObserver.observeInferenceRoute).mockResolvedValue({
    ok: true,
    value: { state: "unconfigured" },
  });
  await expect(
    runInferenceSet(
      { ...hostLocalSelection, endpointUrl: "http://host.openshell.internal:18767/v1" },
      f.deps,
    ),
  ).rejects.toThrow(
    /no configured inference selection to restore.*existing sandbox is unchanged.*Onboard a separate sandbox/,
  );
  expect(f.deps.inferenceRouteMutator.setInferenceRoute).not.toHaveBeenCalled();
  expect([...f.attachments]).toEqual([f.fixed.providerName]);
  expect(f.deps.calls.updateSandbox).not.toHaveBeenCalled();
});
