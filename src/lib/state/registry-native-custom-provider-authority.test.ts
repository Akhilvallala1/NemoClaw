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
