// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  INVALID_NATIVE_NVIDIA_URLS,
  NATIVE_NVIDIA_URLS,
} from "../../fixtures/native-nvidia-inference-urls";
import type { HermesBuildSettings } from "../../../agents/hermes/config/build-env.ts";
import {
  buildHermesManagedPolicy,
  HERMES_MANAGED_POLICY_SCHEMA_VERSION,
} from "../../../agents/hermes/config/managed-policy.ts";
import { getSandboxInferenceConfig } from "../../../src/lib/inference/config";
import { managedStartupE2eProfile } from "../../../scripts/checks/generate-managed-startup-profile-fixture.mts";
import { mapManagedStartupProfileToAgentEnvironment } from "../../../src/lib/onboard/managed-startup/agent-environment";
import {
  decodeManagedStartupProfile,
  encodeManagedStartupProfile,
} from "../../../src/lib/onboard/managed-startup/profile";
import { readHermesBuildSettings } from "../../../agents/hermes/config/build-env";
import {
  customAttachmentFromPrepared,
  prepareNativeCustomProfile,
} from "../../../src/lib/inference/native-custom";

import { BEDROCK_RUNTIME_ADAPTER_OPENAI_BASE_URL } from "../../../src/lib/inference/bedrock-runtime";

import { HOSTED_NATIVE_PROVIDERS } from "../../../src/lib/inference/native-provider/hosted";

const READER_PATH = path.join(
  import.meta.dirname,
  "../../..",
  "agents",
  "hermes",
  "managed_policy.py",
);
const PROFILE_PATCHER_PATH = path.join(
  import.meta.dirname,
  "../../..",
  "agents",
  "hermes",
  "patch-profile-policy-defaults.py",
);
const SETTINGS: HermesBuildSettings = {
  model: "test-model",
  baseUrl: "https://inference.local/v1",
  providerKey: "nvidia-router",
  upstreamProvider: "NVIDIA Router",
  inferenceApi: "openai-completions",
  contextWindow: 128_000,
  toolDisclosure: "progressive",
  webSearchProvider: "tavily",
  messagingCredentialPlaceholders: [
    {
      envKey: "DISCORD_BOT_TOKEN",
      placeholder: "openshell:resolve:env:DISCORD_BOT_TOKEN",
    },
  ],
  managedToolGateways: { brokerEnabled: false, presets: [] },
  managedImageCapabilityUnion: false,
};

const PYTHON_LOAD = `
import importlib.util
import pathlib
import sys

reader_path = pathlib.Path(sys.argv[1])
spec = importlib.util.spec_from_file_location("managed_policy", reader_path)
assert spec and spec.loader
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
try:
    module.load_managed_policy(pathlib.Path(sys.argv[2]))
except module.ManagedPolicyError as exc:
    print(exc, file=sys.stderr)
    raise SystemExit(1)
`;

function loadWithPython(document: unknown) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-managed-policy-"));
  const policyPath = path.join(tmp, "managed-policy.json");
  fs.writeFileSync(policyPath, `${JSON.stringify(document)}\n`);
  try {
    return spawnSync("python3", ["-I", "-c", PYTHON_LOAD, READER_PATH, policyPath], {
      encoding: "utf8",
      timeout: 5000,
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

describe("Hermes managed policy", () => {
  it.each([[], "do-not-echo", { provider: ["do-not-echo"] }])(
    "rejects malformed upstream authority without an unhandled exception (%j)",
    (upstream) => {
      const policy = buildHermesManagedPolicy(SETTINGS, {});
      Object.assign(policy.config, { _nemoclaw_upstream: upstream });
      const result = loadWithPython(policy);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("managed policy");
      expect(result.stderr).not.toContain("Traceback");
      expect(result.stderr).not.toContain("do-not-echo");
    },
  );

  it.each(HOSTED_NATIVE_PROVIDERS)(
    "accepts the runtime credential reference for $label",
    (provider) => {
      const policy = buildHermesManagedPolicy(
        {
          ...SETTINGS,
          baseUrl: provider.endpoint,
          upstreamProvider: provider.logicalProvider,
          inferenceApi: provider.api,
        },
        {},
      );
      expect(policy.config.model?.api_key).toBe(`\${${provider.credentialEnv}}`);
      const result = loadWithPython(policy);
      expect(result.status, result.stderr).toBe(0);
    },
  );

  it.each([
    ["compatible-endpoint", "https://hosted.example:8443/inference/v1", "COMPATIBLE_API_KEY"],
    ["compatible-endpoint", "https://integrate.api.nvidia.com/v1", "COMPATIBLE_API_KEY"],
    ["compatible-endpoint", "http://10.20.30.40:8080/v1", "COMPATIBLE_API_KEY"],
    [
      "compatible-anthropic-endpoint",
      "https://anthropic.example/v1",
      "COMPATIBLE_ANTHROPIC_API_KEY",
    ],
    [
      "compatible-anthropic-endpoint",
      BEDROCK_RUNTIME_ADAPTER_OPENAI_BASE_URL,
      "COMPATIBLE_ANTHROPIC_API_KEY",
    ],
  ])(
    "loads a generated custom policy for %s at %s (#13195)",
    (provider, baseUrl, credentialEnv) => {
      const policy = buildHermesManagedPolicy(
        { ...SETTINGS, baseUrl, upstreamProvider: provider },
        {},
      );
      expect(policy.config.model?.api_key).toBe(`\${${credentialEnv}}`);
      const result = loadWithPython(policy);
      expect(result.status, result.stderr).toBe(0);

      policy.config.model!.api_key = "synthetic-raw-credential";
      const rejected = loadWithPython(policy);
      expect(rejected.status).toBe(1);
      expect(rejected.stderr).not.toContain("synthetic-raw-credential");
    },
  );

  it("accepts the Hermes credential reference at an authenticated endpoint", () => {
    const policy = buildHermesManagedPolicy(
      {
        ...SETTINGS,
        baseUrl: "https://authenticated-hermes.example:8443/inference/v1/",
        upstreamProvider: "hermes-provider",
      },
      {},
    );
    const result = loadWithPython(policy);
    expect(result.status, result.stderr).toBe(0);
  });

  it.each([
    ["openai-api", "https://api.openai.com/v1", "${ANTHROPIC_API_KEY}"],
    ["anthropic-prod", "https://api.openai.com/v1", "${ANTHROPIC_API_KEY}"],
    ["openai-api", "https://api.openai.com/v2", "${OPENAI_API_KEY}"],
    ["openai-api", "https://api.openai.com:8443/v1", "${OPENAI_API_KEY}"],
    ["openai-api", "https://api.openai.com.example/v1", "${OPENAI_API_KEY}"],
    ["custom", "https://api.openai.com/v1", "${OPENAI_API_KEY}"],
    ["compatible-endpoint", "https://hosted.example/v1", "${COMPATIBLE_ANTHROPIC_API_KEY}"],
    ["compatible-anthropic-endpoint", "https://hosted.example/v1", "${COMPATIBLE_API_KEY}"],
    ["compatible-endpoint", "https://inference.local/v1", "${COMPATIBLE_API_KEY}"],
    ["compatible-endpoint", "http://localhost/v1", "${COMPATIBLE_API_KEY}"],
    ["compatible-endpoint", "http://127.0.0.1/v1", "${COMPATIBLE_API_KEY}"],
    ["compatible-endpoint", "http://[::1]/v1", "${COMPATIBLE_API_KEY}"],
    ["compatible-endpoint", "https://do-not-echo@hosted.example/v1", "${COMPATIBLE_API_KEY}"],
    ["compatible-endpoint", "https://hosted.example/v1?do-not-echo", "${COMPATIBLE_API_KEY}"],
    ["compatible-endpoint", "https://hosted.example/v1#do-not-echo", "${COMPATIBLE_API_KEY}"],
    ["hermes-provider", "https://authenticated-hermes.example/v1", "${GEMINI_API_KEY}"],
    ["hermes-provider", "https://inference.local/v1", "${OPENAI_API_KEY}"],
    ["hermes-provider", "https://localhost/v1", "${OPENAI_API_KEY}"],
    ["hermes-provider", "https://gateway.internal/v1", "${OPENAI_API_KEY}"],
    ["hermes-provider", "http://authenticated-hermes.example/v1", "${OPENAI_API_KEY}"],
    ["hermes-provider", "https://do-not-echo@authenticated-hermes.example/v1", "${OPENAI_API_KEY}"],
    [
      "hermes-provider",
      "https://authenticated-hermes.example/v1?token=do-not-echo",
      "${OPENAI_API_KEY}",
    ],
    ["hermes-provider", "https://authenticated-hermes.example/v1#do-not-echo", "${OPENAI_API_KEY}"],
    ["hermes-provider", "https://authenticated-hermes.example/v1%2fother", "${OPENAI_API_KEY}"],
  ])("rejects a mismatched hosted route for %s at %s", (provider, baseUrl, apiKey) => {
    const policy = buildHermesManagedPolicy(SETTINGS, {});
    policy.config._nemoclaw_upstream!.provider = provider;
    policy.config.model!.base_url = baseUrl;
    policy.config.model!.api_key = apiKey;
    const result = loadWithPython(policy);
    expect(result.status).toBe(1);
    expect(result.stderr).not.toContain(apiKey);
    expect(result.stderr).not.toContain("do-not-echo");
  });

  it.each([
    "openshell:resolve:env:OPENAI_API_KEY",
    "openshell:resolve:env:v7_OPENAI_API_KEY",
    "${UNRELATED_API_KEY}",
    "synthetic-raw-credential",
  ])("rejects a baked or unrelated hosted credential %s", (apiKey) => {
    const policy = buildHermesManagedPolicy(
      { ...SETTINGS, baseUrl: "https://api.openai.com/v1", upstreamProvider: "openai-api" },
      {},
    );
    policy.config.model!.api_key = apiKey;
    const result = loadWithPython(policy);
    expect(result.status).toBe(1);
    expect(result.stderr).not.toContain(apiKey);
  });

  it.each(NATIVE_NVIDIA_URLS)(
    "accepts the native NVIDIA inference placeholder at %s",
    (baseUrl) => {
      const policy = buildHermesManagedPolicy(
        { ...SETTINGS, baseUrl, upstreamProvider: "nvidia-prod" },
        {},
      );
      expect(policy.config.model?.api_key).toBe("${NVIDIA_INFERENCE_API_KEY}");
      const result = loadWithPython(policy);
      expect(result.status, result.stderr).toBe(0);
    },
  );

  it.each([
    "openshell:resolve:env:v7_NVIDIA_INFERENCE_API_KEY",
    `openshell:resolve:env:s${"a".repeat(64)}_NVIDIA_INFERENCE_API_KEY`,
  ])("accepts a provider-bound native NVIDIA credential handle %s", (apiKey) => {
    const policy = buildHermesManagedPolicy(
      { ...SETTINGS, baseUrl: NATIVE_NVIDIA_URLS[0], upstreamProvider: "nvidia-prod" },
      {},
    );
    policy.config.model!.api_key = apiKey;
    const result = loadWithPython(policy);
    expect(result.status, result.stderr).toBe(0);
  });

  it.each([
    "openshell:resolve:env:NVIDIA_INFERENCE_API_KEY",
    "openshell:resolve:env:v7_OPENAI_API_KEY",
    "openshell:resolve:env:v123456789012345678901_NVIDIA_INFERENCE_API_KEY",
    `openshell:resolve:env:s${"A".repeat(64)}_NVIDIA_INFERENCE_API_KEY`,
    "sk-raw-policy-credential",
  ])("rejects an invalid native NVIDIA credential handle %s", (apiKey) => {
    const policy = buildHermesManagedPolicy(
      { ...SETTINGS, baseUrl: NATIVE_NVIDIA_URLS[0], upstreamProvider: "nvidia-prod" },
      {},
    );
    policy.config.model!.api_key = apiKey;
    const result = loadWithPython(policy);
    expect(result.status).toBe(1);
    expect(result.stderr).not.toContain(apiKey);
  });

  it.each(INVALID_NATIVE_NVIDIA_URLS)(
    "rejects ambiguous native NVIDIA routing at %j",
    (baseUrl) => {
      expect(() => buildHermesManagedPolicy({ ...SETTINGS, baseUrl }, {})).toThrow(
        "Native NVIDIA inference requires https://integrate.api.nvidia.com/v1.",
      );

      const policy = buildHermesManagedPolicy({ ...SETTINGS, baseUrl: NATIVE_NVIDIA_URLS[0] }, {});
      const result = loadWithPython({
        ...policy,
        config: { ...policy.config, model: { ...policy.config.model, base_url: baseUrl } },
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Native NVIDIA inference requires");
      expect(result.stderr).not.toContain("do-not-echo");
    },
  );

  it.each([
    ["https://integrate.api.nvidia.com/v1", "sk-OPENSHELL-PROXY-REWRITE"],
    ["https://inference.local/v1", "${NVIDIA_INFERENCE_API_KEY}"],
    ["https://integrate.api.nvidia.com.example/v1", "${NVIDIA_INFERENCE_API_KEY}"],
    ["https://integrate.api.nvidia.com/v1", "sk-raw-policy-credential"],
  ])("rejects credentials outside the managed route contract at %s", (baseUrl, apiKey) => {
    const policy = buildHermesManagedPolicy({ ...SETTINGS, baseUrl }, {});
    const malformedPolicy = {
      ...policy,
      config: { ...policy.config, model: { ...policy.config.model, api_key: apiKey } },
    };
    const result = loadWithPython(malformedPolicy);
    expect(result.status).toBe(1);
    expect(result.stderr).not.toContain(apiKey);
  });

  it("accepts absent inference while retaining managed restrictions", () => {
    const policy = buildHermesManagedPolicy({ ...SETTINGS, model: null }, {});
    const result = loadWithPython(policy);
    expect(result.status, result.stderr).toBe(0);
    expect(policy.config.model).toBeUndefined();
    expect(policy.config.approvals.mode).toBe("manual");
  });
  it("rejects partial routing in a providerless policy", () => {
    const policy = buildHermesManagedPolicy({ ...SETTINGS, model: null }, {});
    policy.config.providers = {};
    const result = loadWithPython(policy);
    expect(result.status).not.toBe(0);
  });
  it("serializes one versioned policy with resolver-only credentials (#8008)", () => {
    const rawSecret = "raw-secret-must-not-appear";
    const policy = buildHermesManagedPolicy(SETTINGS, { DISCORD_BOT_TOKEN: rawSecret });
    const serialized = JSON.stringify(policy);

    expect(policy.schema_version).toBe(HERMES_MANAGED_POLICY_SCHEMA_VERSION);
    expect(Object.keys(policy).sort()).toEqual([
      "config",
      "env_lines",
      "managed_paths",
      "schema_version",
      "shadow_migration",
    ]);
    expect(policy.shadow_migration).toMatchObject({
      routing_keys: expect.arrayContaining(["model", "_nemoclaw_upstream"]),
      env_keys: expect.arrayContaining(["API_SERVER_HOST", "API_SERVER_PORT"]),
    });
    expect(policy.config._nemoclaw_upstream).toEqual({
      provider: "NVIDIA Router",
      provider_key: "nvidia-router",
      model: "test-model",
    });
    expect(policy.env_lines).toContain("DISCORD_BOT_TOKEN=openshell:resolve:env:DISCORD_BOT_TOKEN");
    expect(serialized).not.toContain(rawSecret);
    expect(loadWithPython(policy).status).toBe(0);
  });

  it("rejects a schema change without an explicit migration (#8008)", () => {
    const policy = {
      ...buildHermesManagedPolicy(SETTINGS, {}),
      schema_version: HERMES_MANAGED_POLICY_SCHEMA_VERSION + 1,
    };

    const result = loadWithPython(policy);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`has no migration to ${HERMES_MANAGED_POLICY_SCHEMA_VERSION}`);
  });

  it("rejects a raw model credential without echoing it (#8008)", () => {
    const rawCredential = "sk-raw-policy-credential";
    const policy = structuredClone(buildHermesManagedPolicy(SETTINGS, {}));
    const malformedPolicy = {
      ...policy,
      config: {
        ...policy.config,
        model: { ...policy.config.model, api_key: rawCredential },
      },
    };

    const result = loadWithPython(malformedPolicy);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "must use an OpenShell credential placeholder or proxy rewrite sentinel",
    );
    expect(result.stderr).not.toContain(rawCredential);
  });

  it("loads the shared reader under the image's isolated Python mode (#8008)", () => {
    const patcher = spawnSync("python3", ["-I", PROFILE_PATCHER_PATH, "--help"], {
      encoding: "utf8",
      timeout: 5000,
    });
    expect(patcher.status, patcher.stderr).toBe(0);
  });
});

describe("native custom Hermes policy (#12636)", () => {
  it.each([
    ["compatible-endpoint", "COMPATIBLE_API_KEY"],
    ["compatible-anthropic-endpoint", "COMPATIBLE_ANTHROPIC_API_KEY"],
  ] as const)("carries sealed %s authority into the Python policy reader", (provider, key) => {
    const base = managedStartupE2eProfile("hermes");
    const sealed = decodeManagedStartupProfile(
      encodeManagedStartupProfile({
        ...base,
        inference: {
          ...base.inference!,
          upstreamProvider: provider,
          routedBaseUrl: "https://api.example.com/v1",
          nativeCustomCredentialEnv: key,
        },
      }),
    );
    const environment = mapManagedStartupProfileToAgentEnvironment(sealed);
    expect(environment.configurationEnvironment.NEMOCLAW_NATIVE_CUSTOM_CREDENTIAL_ENV).toBe(key);
    const policy = buildHermesManagedPolicy(
      readHermesBuildSettings(environment.configurationEnvironment),
      {},
    );
    expect(policy.config.model?.api_key).toBe(`\${${key}}`);
    expect(loadWithPython(policy).status).toBe(0);
    const runtimeBoundary = spawnSync(
      "python3",
      [
        "-I",
        path.join(path.dirname(READER_PATH), "validate-env-secret-boundary.py"),
        "runtime-env-json",
      ],
      { input: JSON.stringify(environment.runtimeEnvironment), encoding: "utf8", timeout: 5000 },
    );
    expect(runtimeBoundary.status, runtimeBoundary.stderr).toBe(0);
  });

  it("keeps an unowned compatible host-local route on the proxy sentinel", () => {
    const policy = buildHermesManagedPolicy(
      {
        ...SETTINGS,
        upstreamProvider: "compatible-endpoint",
        baseUrl: "http://host.openshell.internal:11435/v1",
      },
      {},
    );
    expect(policy.config.model?.api_key).toBe("sk-OPENSHELL-PROXY-REWRITE");
    expect(policy.config._nemoclaw_upstream?.native_custom_credential_env).toBeUndefined();
    expect(loadWithPython(policy).status).toBe(0);
    const forged = structuredClone(policy);
    forged.config._nemoclaw_upstream!.native_custom_credential_env = "COMPATIBLE_API_KEY";
    expect(loadWithPython(forged).status).toBe(1);
  });

  it.each([
    [
      "compatible-endpoint",
      "COMPATIBLE_API_KEY",
      "openai-completions",
      "https://api.example.com/v1",
    ],
    [
      "compatible-anthropic-endpoint",
      "COMPATIBLE_ANTHROPIC_API_KEY",
      "anthropic-messages",
      "https://api.example.com",
    ],
  ] as const)(
    "accepts %s only with its owned credential reference",
    async (provider, key, api, baseUrl) => {
      const prepared = await prepareNativeCustomProfile({
        sandboxName: "hermes-custom",
        provider,
        endpointUrl: "https://api.example.com/v1",
        api,
        lookup: async () => [{ address: "8.8.8.8", family: 4 }],
      });
      const attachment = customAttachmentFromPrepared(prepared, {
        schemaVersion: 1,
        profileId: prepared.profile.id,
        providerName: prepared.providerName,
        providerId: "native-provider-id",
      });
      const inference = getSandboxInferenceConfig("test-model", provider, api, attachment);
      const policy = buildHermesManagedPolicy(
        {
          ...SETTINGS,
          upstreamProvider: provider,
          baseUrl: inference.inferenceBaseUrl,
          inferenceApi: inference.inferenceApi,
          nativeCustomCredentialEnv: attachment.credentialEnv,
        },
        {},
      );
      expect(loadWithPython(policy).status).toBe(0);
      expect(policy.config.model).toMatchObject({
        base_url: baseUrl,
        api_key: `\${${key}}`,
      });
      expect(policy.config._nemoclaw_upstream?.native_custom_credential_env).toBe(key);
      const serialized = JSON.stringify(policy);
      expect(serialized).toContain(`\${${key}}`);
      const malformed = {
        ...policy,
        config: {
          ...policy.config,
          model: { ...policy.config.model, api_key: "raw-custom-secret" },
        },
      };
      const result = loadWithPython(malformed);
      expect(result.status).toBe(1);
      expect(result.stderr).not.toContain("raw-custom-secret");
    },
  );
});
