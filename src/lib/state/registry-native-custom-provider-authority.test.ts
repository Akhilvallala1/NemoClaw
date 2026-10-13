// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

let home: string;
beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "nemoclaw-custom-authority-"));
  vi.stubEnv("HOME", home);
  vi.resetModules();
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(home, { recursive: true, force: true });
});

async function receipt(sandboxName: string, providerId = `${sandboxName}-provider`) {
  const { prepareNativeCustomProfile, customAttachmentFromPrepared } =
    await import("../inference/native-custom");
  const prepared = await prepareNativeCustomProfile({
    sandboxName,
    provider: "compatible-endpoint",
    endpointUrl: "https://api.example.com/v1",
    api: "openai-completions",
    lookup: async () => [{ address: "8.8.8.8", family: 4 }],
  });
  return customAttachmentFromPrepared(prepared, {
    schemaVersion: 1,
    providerId,
    providerName: prepared.providerName,
    profileId: prepared.profile.id,
  });
}

it("round-trips independent native custom sandbox authority without extra credential fields (#12636)", async () => {
  const registry = await import("./registry");
  const authority = await import("./registry/native-custom-provider-authority");
  const alpha = await receipt("alpha");
  const beta = await receipt("beta");
  registry.registerSandbox({
    name: alpha.sandboxName,
    gatewayName: "nemoclaw",
    provider: "compatible-endpoint",
    model: "model-a",
    nativeCustomProviderAttachment: {
      ...alpha,
      credentialValue: "never-persist",
    } as typeof alpha,
  });
  authority.setNativeCustomProviderAuthority("nemoclaw", alpha);
  registry.registerSandbox({
    name: beta.sandboxName,
    gatewayName: "nemoclaw",
    provider: "compatible-endpoint",
    model: "model-a",
    nativeCustomProviderAttachment: {
      ...beta,
      credentialValue: "never-persist",
    } as typeof beta,
  });
  authority.setNativeCustomProviderAuthority("nemoclaw", beta);
  const disk = await fs.readFile(registry.REGISTRY_FILE, "utf8");
  expect(disk).not.toContain("never-persist");
  expect(disk).not.toContain("credentialValue");
  expect(registry.getSandbox("alpha")?.nativeCustomProviderAttachment).toEqual(alpha);
  expect(registry.getSandbox("beta")?.nativeCustomProviderAttachment).toEqual(beta);
  authority.clearNativeCustomProviderAuthority("nemoclaw", alpha);
  expect(
    authority.getNativeCustomProviderAuthority("nemoclaw", alpha.providerName),
  ).toBeUndefined();
  expect(authority.getNativeCustomProviderAuthority("nemoclaw", beta.providerName)).toEqual(beta);
  expect(registry.getSandbox("beta")?.nativeCustomProviderAttachment).toEqual(beta);
});

it("retains replacement provider authority when cleanup presents an older immutable identity (#12636)", async () => {
  const authority = await import("./registry/native-custom-provider-authority");
  const stale = await receipt("alpha", "old-provider");
  const current = { ...stale, providerId: "replacement-provider" };
  authority.setNativeCustomProviderAuthority("nemoclaw", current);
  authority.clearNativeCustomProviderAuthority("nemoclaw", stale);
  expect(authority.getNativeCustomProviderAuthority("nemoclaw", current.providerName)).toEqual(
    current,
  );
});

async function scopedAuthorityFixture(providerId: string) {
  const authority = await import("./registry/native-custom-provider-authority");
  const old = await receipt("alpha", "old-provider");
  const root = path.join(home, ".nemoclaw", "gateways", "19081");
  await fs.mkdir(root, { recursive: true });
  const file = path.join(root, "sandboxes.json");
  const before = JSON.stringify({
    sandboxes: {},
    nativeCustomProviderAuthorities: {
      "nemoclaw-19081": { [old.providerName]: { ...old, providerId } },
    },
  });
  await fs.writeFile(file, before);
  return { authority, old, file, before };
}

it("preserves scoped authority when cleanup names a replaced provider identity (#12636)", async () => {
  const { authority, old, file, before } = await scopedAuthorityFixture("replacement-provider");
  authority.clearNativeCustomProviderAuthority("nemoclaw-19081", old, file);
  expect(authority.listNativeCustomProviderAuthorities("nemoclaw-19081", "alpha", file)).toEqual([
    { ...old, providerId: "replacement-provider" },
  ]);
  expect(await fs.readFile(file, "utf8")).toBe(before);
});

it("preserves malformed scoped authority when cleanup cannot validate it (#12636)", async () => {
  const { authority, old, file, before } = await scopedAuthorityFixture("");
  expect(() => authority.clearNativeCustomProviderAuthority("nemoclaw-19081", old, file)).toThrow(
    /native custom.*authority/i,
  );
  expect(await fs.readFile(file, "utf8")).toBe(before);
});

it("rejects copied native authority before changing the selected sandbox registry (#12636)", async () => {
  const registry = await import("./registry");
  const alpha = await receipt("alpha");
  expect(() =>
    registry.registerSandbox({
      name: "beta",
      provider: "compatible-endpoint",
      model: "model-a",
      nativeCustomProviderAttachment: alpha,
    }),
  ).toThrow(/native custom/i);
  expect(registry.getSandbox("beta")).toBeNull();
});

it("rejects tampered persisted native authority instead of recovering through a shared route (#12636)", async () => {
  const registry = await import("./registry");
  const alpha = await receipt("alpha");
  registry.registerSandbox({
    name: "alpha",
    provider: "compatible-endpoint",
    model: "model-a",
    nativeCustomProviderAttachment: alpha,
  });
  const disk = JSON.parse(await fs.readFile(registry.REGISTRY_FILE, "utf8"));
  disk.sandboxes.alpha.nativeCustomProviderAttachment.endpointUrl = "https://other.example.com/v1";
  await fs.writeFile(registry.REGISTRY_FILE, JSON.stringify(disk));
  expect(() => registry.getSandbox("alpha")).toThrow(/invalid native custom/i);
});

it("preserves malformed gateway ownership instead of dropping it during registry reads or writes (#12636)", async () => {
  const registry = await import("./registry");
  const authority = await import("./registry/native-custom-provider-authority");
  const alpha = await receipt("alpha");
  registry.registerSandbox({ name: "alpha", provider: "compatible-endpoint", model: "model-a" });
  const disk = JSON.parse(await fs.readFile(registry.REGISTRY_FILE, "utf8"));
  disk.nativeCustomProviderAuthorities = {
    nemoclaw: { [alpha.providerName]: { ...alpha, providerId: "" } },
  };
  const before = JSON.stringify(disk);
  await fs.writeFile(registry.REGISTRY_FILE, before);
  expect(() => registry.getSandbox("alpha")).toThrow(/native custom.*authority/i);
  expect(() => authority.listNativeCustomProviderAuthorities("nemoclaw", "alpha")).toThrow(
    /native custom.*authority/i,
  );
  expect(() => registry.registerSandbox({ name: "beta", model: "model-b" })).toThrow(
    /native custom.*authority/i,
  );
  expect(await fs.readFile(registry.REGISTRY_FILE, "utf8")).toBe(before);
});

it.each([8080, 19080])(
  "rejects malformed native ownership in the owning gateway root on port %s (#12636)",
  async (gatewayPort) => {
    const { findSandboxAcrossGatewayRoots } = await import("./registry/cross-port");
    const { nemoclawStateRoot } = await import("./state-root");
    const { DEFAULT_GATEWAY_PORT } = await import("../core/ports");
    const alpha = await receipt("alpha");
    const gatewayName =
      gatewayPort === DEFAULT_GATEWAY_PORT ? "nemoclaw" : `nemoclaw-${gatewayPort}`;
    const root = nemoclawStateRoot(home, gatewayPort);
    await fs.mkdir(root, { recursive: true });
    const file = path.join(root, "sandboxes.json");
    const before = JSON.stringify({
      sandboxes: { alpha: { name: "alpha", gatewayName, gatewayPort } },
      nativeCustomProviderAuthorities: {
        [gatewayName]: { [alpha.providerName]: { ...alpha, providerId: "" } },
      },
    });
    await fs.writeFile(file, before);
    expect(() => findSandboxAcrossGatewayRoots("alpha", home)).toThrow(/native custom.*authority/i);
    expect(await fs.readFile(file, "utf8")).toBe(before);
  },
);

it.each([
  {
    endpointUrl: "http://host.openshell.internal:11434/v1",
    credentialEnv: "COMPATIBLE_API_KEY",
    retained: false,
  },
  {
    endpointUrl: "https://api.example.com/v1",
    credentialEnv: "NEMOCLAW_OLLAMA_PROXY_TOKEN",
    retained: false,
  },
  {
    endpointUrl: "https://api.example.com/v1",
    credentialEnv: "COMPATIBLE_API_KEY",
    retained: true,
  },
])(
  "retains custom attachment only for matching endpoint and credential: $endpointUrl / $credentialEnv (#12636)",
  async ({ endpointUrl, credentialEnv, retained }) => {
    const registry = await import("./registry");
    const attachment = await receipt("alpha");
    registry.registerSandbox({
      name: "alpha",
      gatewayName: "nemoclaw",
      provider: "compatible-endpoint",
      model: "old-model",
      endpointUrl: "https://api.example.com/v1",
      credentialEnv: "COMPATIBLE_API_KEY",
      preferredInferenceApi: "openai-completions",
      nativeCustomProviderAttachment: attachment,
    });
    expect(
      registry.reserveSandboxInferenceRoute("alpha", {
        gatewayName: "nemoclaw",
        provider: "compatible-endpoint",
        model: "new-model",
        endpointUrl,
        credentialEnv,
        preferredInferenceApi: "openai-completions",
        reservationSessionId: "resume-selection",
      }),
    ).toBe(true);
    expect(registry.getSandbox("alpha")?.nativeCustomProviderAttachment).toEqual(
      retained ? attachment : undefined,
    );
  },
);

it("keeps native resume authority in the process-selected gateway root (#12636)", async () => {
  vi.stubEnv("NEMOCLAW_GATEWAY_PORT", "8080");
  vi.resetModules();
  const baseRegistry = await import("./registry");
  const baseAuthority = await import("./registry/native-custom-provider-authority");
  const baseReceipt = await receipt("alpha", "base-provider");
  baseAuthority.setNativeCustomProviderAuthority("nemoclaw-19081", baseReceipt);
  const baseBefore = await fs.readFile(baseRegistry.REGISTRY_FILE, "utf8");

  vi.stubEnv("NEMOCLAW_GATEWAY_PORT", "19081");
  vi.resetModules();
  const ownerRegistry = await import("./registry");
  const ownerAuthority = await import("./registry/native-custom-provider-authority");
  const ownerReceipt = { ...baseReceipt, providerId: "owner-provider" };
  ownerRegistry.registerSandbox({
    name: "alpha",
    gatewayName: "nemoclaw-19081",
    gatewayPort: 19081,
    provider: "compatible-endpoint",
    model: "model-a",
    endpointUrl: ownerReceipt.endpointUrl,
    credentialEnv: ownerReceipt.credentialEnv,
    preferredInferenceApi: ownerReceipt.api,
    nativeCustomProviderAttachment: ownerReceipt,
  });
  ownerAuthority.setNativeCustomProviderAuthority("nemoclaw-19081", ownerReceipt);
  const { hasRetainedNativeCustomSelection } = await import("../onboard/resume/native-custom");
  expect(
    hasRetainedNativeCustomSelection({
      gatewayName: "nemoclaw-19081",
      sandboxName: "alpha",
      provider: "compatible-endpoint",
      endpointUrl: ownerReceipt.endpointUrl,
      api: ownerReceipt.api,
      credentialEnv: ownerReceipt.credentialEnv,
    }),
  ).toBe(true);
  expect(
    ownerAuthority.getNativeCustomProviderAuthority("nemoclaw-19081", ownerReceipt.providerName),
  ).toEqual(ownerReceipt);
  ownerAuthority.clearNativeCustomProviderAuthority("nemoclaw-19081", ownerReceipt);
  expect(
    ownerAuthority.getNativeCustomProviderAuthority("nemoclaw-19081", ownerReceipt.providerName),
  ).toBeUndefined();
  expect(await fs.readFile(baseRegistry.REGISTRY_FILE, "utf8")).toBe(baseBefore);

  vi.stubEnv("NEMOCLAW_GATEWAY_PORT", "8080");
  vi.resetModules();
  const callerRegistry = await import("./registry");
  const callerAuthority = await import("./registry/native-custom-provider-authority");
  expect(callerRegistry.getSandbox("alpha")).toBeNull();
  expect(
    callerAuthority.getNativeCustomProviderAuthority("nemoclaw-19081", baseReceipt.providerName),
  ).toEqual(baseReceipt);
});
