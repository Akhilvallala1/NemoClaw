// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  prepareNativeCustomProfile,
  customAttachmentFromPrepared,
} from "../inference/native-custom";
import { HOSTED_NATIVE_PROVIDERS } from "../inference/native-provider/hosted";
import type {
  OpenShellProviderAdapter,
  OpenShellProviderMetadata,
} from "../adapters/openshell/provider-adapter";
import { setGlobalCliActionRuntimeHooksForTest } from "./global";
import { runCredentialsResetAction } from "./credentials/reset";

vi.mock("../onboard/gateway-teardown-authority", () => ({
  resolveGatewayCredentialMutationAuthority: vi.fn(() => ({})),
}));

function adapter(
  deleteProvider: OpenShellProviderAdapter["deleteProvider"],
): OpenShellProviderAdapter {
  return { deleteProvider: vi.fn(deleteProvider) } as unknown as OpenShellProviderAdapter;
}

describe("native NVIDIA credential reset ownership", () => {
  beforeEach(() => {
    setGlobalCliActionRuntimeHooksForTest({
      recoverNamedGatewayRuntime: async () => ({ recovered: true }),
      forgetExtraProvider: () => true,
    });
  });

  afterEach(() => setGlobalCliActionRuntimeHooksForTest({}));

  it.each([
    ["present", { ok: true as const }],
    [
      "absent",
      {
        ok: false as const,
        error: {
          kind: "command" as const,
          reason: "not_found" as const,
          message: "provider not found",
        },
      },
    ],
  ])(
    "blocks reset when a recorded sandbox remains and the provider is %s (#12562)",
    async (_providerState, deleteResult) => {
      const operations: string[] = [];
      const deleteProvider = vi.fn<OpenShellProviderAdapter["deleteProvider"]>(async () => {
        operations.push("delete");
        return deleteResult;
      });
      const clearNativeNvidiaProviderAuthority = vi.fn(() => operations.push("clear-authority"));
      const listNativeNvidiaProviderAttachmentSandboxNames = vi.fn((gatewayName: string) =>
        gatewayName === "nemoclaw" ? ["alpha"] : [],
      );

      const result = await runCredentialsResetAction(
        { provider: "nvidia-prod", confirmed: true },
        {
          providerAdapter: adapter(deleteProvider),
          clearNativeNvidiaProviderAuthority,
          listNativeNvidiaProviderAttachmentSandboxNames,
          withGatewayRouteMutationLock: async (_gatewayName, operation) => {
            operations.push("lock");
            return operation();
          },
        },
      );

      expect(result.exitCode).toBe(1);
      expect(operations).toEqual(["lock"]);
      expect(listNativeNvidiaProviderAttachmentSandboxNames).toHaveBeenCalledExactlyOnceWith(
        "nemoclaw",
      );
      expect(deleteProvider).not.toHaveBeenCalled();
      expect(clearNativeNvidiaProviderAuthority).not.toHaveBeenCalled();
      expect(result.failureLines).toContain("  'nvidia-prod' is recorded by sandbox(es): alpha.");
      expect(result.failureLines).toContain("  No provider or ownership authority was changed.");
      expect(result.failureLines).toContain("    nemoclaw alpha destroy");
    },
  );

  it("does not let another gateway's attachment block the selected gateway reset", async () => {
    const deleteProvider = vi.fn<OpenShellProviderAdapter["deleteProvider"]>(async () => ({
      ok: true,
    }));
    const clearNativeNvidiaProviderAuthority = vi.fn();
    const listNativeNvidiaProviderAttachmentSandboxNames = vi.fn((gatewayName: string) =>
      gatewayName === "other-gateway" ? ["beta"] : [],
    );

    const result = await runCredentialsResetAction(
      { provider: "nvidia-prod", confirmed: true },
      {
        providerAdapter: adapter(deleteProvider),
        clearNativeNvidiaProviderAuthority,
        listNativeNvidiaProviderAttachmentSandboxNames,
        withGatewayRouteMutationLock: async (_gatewayName, operation) => operation(),
      },
    );

    expect(result.exitCode).toBe(0);
    expect(listNativeNvidiaProviderAttachmentSandboxNames).toHaveBeenCalledExactlyOnceWith(
      "nemoclaw",
    );
    expect(deleteProvider).toHaveBeenCalledOnce();
    expect(clearNativeNvidiaProviderAuthority).toHaveBeenCalledExactlyOnceWith("nemoclaw");
  });

  it("fails closed before reset when registry ownership cannot be read", async () => {
    const deleteProvider = vi.fn<OpenShellProviderAdapter["deleteProvider"]>();
    const clearNativeNvidiaProviderAuthority = vi.fn();

    const result = await runCredentialsResetAction(
      { provider: "nvidia-prod", confirmed: true },
      {
        providerAdapter: adapter(deleteProvider),
        clearNativeNvidiaProviderAuthority,
        listNativeNvidiaProviderAttachmentSandboxNames: () => {
          throw new Error("opaque registry failure");
        },
        withGatewayRouteMutationLock: async (_gatewayName, operation) => operation(),
      },
    );

    expect(result.exitCode).toBe(1);
    expect(deleteProvider).not.toHaveBeenCalled();
    expect(clearNativeNvidiaProviderAuthority).not.toHaveBeenCalled();
    expect(result.failureLines).toEqual([
      "  Could not safely inspect native NVIDIA inference ownership on gateway 'nemoclaw'.",
      "  No provider or ownership authority was changed.",
      "  Repair the existing NemoClaw state and retry.",
    ]);
    expect(JSON.stringify(result)).not.toContain("opaque registry failure");
  });
});

describe("native custom credential reset ownership", () => {
  beforeEach(() =>
    setGlobalCliActionRuntimeHooksForTest({
      recoverNamedGatewayRuntime: async () => ({ recovered: true }),
      forgetExtraProvider: () => true,
    }),
  );
  afterEach(() => setGlobalCliActionRuntimeHooksForTest({}));
  it.each([true, false])(
    "requires absence of the recorded sandbox before retiring custom authority (recorded=%s) (#12636)",
    async (recorded) => {
      const prepared = await prepareNativeCustomProfile({
        sandboxName: "alpha",
        provider: "compatible-endpoint",
        endpointUrl: "http://8.8.8.8/v1",
        api: "openai-completions",
      });
      const receipt = customAttachmentFromPrepared(prepared, {
        schemaVersion: 1,
        profileId: prepared.profile.id,
        providerName: prepared.providerName,
        providerId: "owned-id",
      });
      const remove = vi.fn(async () => undefined);
      const providerAdapter = adapter(async () => ({ ok: true }));
      const result = await runCredentialsResetAction(
        { provider: "compatible-endpoint", confirmed: true },
        {
          providerAdapter,
          listNativeCustomProviderAuthorities: () => [receipt],
          listSandboxes: () => ({
            sandboxes: recorded ? [{ name: "alpha", nativeCustomProviderAttachment: receipt }] : [],
            defaultSandbox: null,
          }),
          retireNativeCustomProviders: remove,
          withGatewayRouteMutationLock: async (_gateway, operation) => operation(),
        },
      );
      expect(result.exitCode).toBe(recorded ? 1 : 0);
      expect(remove.mock.calls).toEqual(
        recorded
          ? []
          : [
              [
                {
                  gatewayName: "nemoclaw",
                  sandboxName: "alpha",
                  receipts: [receipt],
                  adapter: providerAdapter,
                },
              ],
            ],
      );
      expect(vi.mocked(providerAdapter.deleteProvider).mock.calls).toEqual(
        recorded ? [] : [[expect.objectContaining({ providerName: "compatible-endpoint" })]],
      );
    },
  );
});

describe("fixed hosted credential reset ownership", () => {
  beforeEach(() =>
    setGlobalCliActionRuntimeHooksForTest({
      recoverNamedGatewayRuntime: async () => ({ recovered: true }),
      forgetExtraProvider: () => true,
    }),
  );
  afterEach(() => setGlobalCliActionRuntimeHooksForTest({}));

  it.each(
    HOSTED_NATIVE_PROVIDERS.flatMap((definition) => [
      { definition, nativeName: false, legacy: true, removed: false },
      { definition, nativeName: false, legacy: false, removed: true },
      { definition, nativeName: true, legacy: true, removed: true },
    ]),
  )(
    "preserves owned reset for $definition.logicalProvider (native=$nativeName legacy=$legacy)",
    async ({ definition, nativeName, legacy, removed }) => {
      const receipt = {
        schemaVersion: 1 as const,
        profileId: definition.profileId,
        providerName: definition.providerName,
        providerId: "owned-provider-id",
      };
      const nativeMetadata: OpenShellProviderMetadata = {
        name: definition.providerName,
        type: definition.profileId,
        credentialKeys: [definition.credentialEnv],
        configKeys: [],
        revision: { id: receipt.providerId, resourceVersion: 1 },
      };
      const legacyMetadata: OpenShellProviderMetadata = {
        ...nativeMetadata,
        name: definition.logicalProvider,
        revision: { id: "user-owned-legacy-id", resourceVersion: 1 },
      };
      const providers = new Map<string, OpenShellProviderMetadata>([
        [definition.providerName, nativeMetadata],
        ...(legacy ? [[definition.logicalProvider, legacyMetadata] as const] : []),
      ]);
      const missing = {
        ok: false as const,
        error: { kind: "command" as const, reason: "not_found" as const, message: "missing" },
      };
      const events: string[] = [];
      const deleteProvider = vi.fn<OpenShellProviderAdapter["deleteProvider"]>(
        async ({ providerName }) => {
          events.push(`delete:${providerName}`);
          providers.delete(providerName);
          return { ok: true };
        },
      );
      const providerAdapter = {
        deleteProvider,
        getProvider: vi.fn<OpenShellProviderAdapter["getProvider"]>(async ({ providerName }) => {
          const value = providers.get(providerName);
          return value ? { ok: true, value } : missing;
        }),
        listProviderAttachments: vi.fn(async () => ({ ok: true, value: { names: [] } })),
      } as unknown as OpenShellProviderAdapter;
      const clearNativeHostedProviderAuthority = vi.fn(() => events.push("clear-authority"));
      const deps = {
        providerAdapter,
        clearNativeHostedProviderAuthority,
        getNativeHostedProviderAuthority: vi.fn(() => receipt),
        getNativeHostedProviderAuthorityByName: vi.fn(() => receipt),
        listNativeHostedProviderAttachmentSandboxNames: vi.fn(() => []),
        withGatewayRouteMutationLock: async <T>(
          _gateway: string,
          operation: () => T | Promise<T>,
        ) => {
          events.push("lock");
          return operation();
        },
      };
      const result = await runCredentialsResetAction(
        {
          provider: nativeName ? definition.providerName : definition.logicalProvider,
          confirmed: true,
        },
        deps,
      );
      expect(result.exitCode).toBe(removed ? 0 : 1);
      expect(events).toEqual(
        removed ? ["lock", `delete:${definition.providerName}`, "clear-authority"] : ["lock"],
      );
      expect(providers.has(definition.logicalProvider)).toBe(legacy);
      expect(providers.has(definition.providerName)).toBe(!removed);
      expect(clearNativeHostedProviderAuthority.mock.calls).toEqual(
        removed ? [["nemoclaw", receipt]] : [],
      );
      expect(vi.mocked(providerAdapter.listProviderAttachments)).not.toHaveBeenCalled();
    },
  );
});
