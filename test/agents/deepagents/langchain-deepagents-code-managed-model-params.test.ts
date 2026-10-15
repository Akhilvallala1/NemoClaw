// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupPackageFixtures,
  createPackageFixture,
  patchFixture,
} from "../../helpers/langchain-deepagents-code-patch-fixture";

afterEach(cleanupPackageFixtures);

const e2eProfileCheckPath = path.join(
  process.cwd(),
  "test",
  "e2e",
  "e2e-cloud-experimental",
  "checks",
  "03-deepagents-code-nemotron-ultra-profile.sh",
);

describe("LangChain Deep Agents Code managed model request parameters", () => {
  it("supplies the reviewed Ultra template argument from the managed provider resolver (#7441)", () => {
    const tempDir = createPackageFixture();
    patchFixture(tempDir);
    const validation = `
from deepagents_code import config
from deepagents_code.model_config import ModelConfigError

base_openai_kwargs = {
    "api_key": "nemoclaw-managed-inference",
    "base_url": "https://inference.local/v1",
    "use_responses_api": False,
}
base_openrouter_kwargs = {
    "api_key": "nemoclaw-managed-inference",
    "base_url": "https://inference.local/v1",
}
ultra_extra_body = {"chat_template_kwargs": {"force_nonempty_content": True}}
ultra_models = (
    "nvidia/nemotron-3-ultra-550b-a55b",
    "nvidia/nvidia/nemotron-3-ultra",
)

# A mutable allowlist would let a caller widen the shaped set at runtime.
assert isinstance(config._NEMOCLAW_NEMOTRON_ULTRA_MODEL_IDS, frozenset)
assert set(config._NEMOCLAW_NEMOTRON_ULTRA_MODEL_IDS) == set(ultra_models)

for ultra_model in ultra_models:
    resolved = config._get_provider_kwargs("openai", model_name=ultra_model)
    assert resolved == {**base_openai_kwargs, "extra_body": ultra_extra_body}, resolved
    # The reviewed argument belongs to the OpenAI adapter alone.
    routed = config._get_provider_kwargs("openrouter", model_name=ultra_model)
    assert routed == base_openrouter_kwargs, routed

# "nemotron-4" is a deliberate near miss: a neighbouring generation must not be
# shaped just because the ID looks similar.
for unshaped in ("gpt-4o", "nvidia/nemotron-4-ultra-550b-a55b", None):
    assert config._get_provider_kwargs("openai", model_name=unshaped) == base_openai_kwargs
    assert (
        config._get_provider_kwargs("openrouter", model_name=unshaped)
        == base_openrouter_kwargs
    )
assert config._get_provider_kwargs("openai") == base_openai_kwargs

for blocked_provider in ("anthropic", "fireworks", "ollama", "nvidia"):
    try:
        config._get_provider_kwargs(blocked_provider, model_name=ultra_models[0])
    except ModelConfigError:
        pass
    else:
        raise AssertionError(blocked_provider)

# Mutation of one result cannot change a later result.
tampered = config._get_provider_kwargs("openai", model_name=ultra_models[0])
tampered["api_key"] = "tampered"
tampered["extra_body"]["chat_template_kwargs"]["force_nonempty_content"] = False
assert config._get_provider_kwargs("openai", model_name=ultra_models[0]) == {
    **base_openai_kwargs,
    "extra_body": ultra_extra_body,
}
print("managed-ultra-template-argument-ok")
`;
    const output = execFileSync("python3", ["-c", validation], {
      env: { PATH: process.env.PATH, PYTHONPATH: tempDir },
      encoding: "utf8",
    });
    expect(output).toContain("managed-ultra-template-argument-ok");
  });

  it("passes only the matching OpenShell placeholder to the native NVIDIA constructor (#11847)", () => {
    const tempDir = createPackageFixture();
    patchFixture(tempDir);
    const routeFile = path.join(tempDir, "managed-inference-base-url");
    fs.chmodSync(routeFile, 0o644);
    fs.writeFileSync(routeFile, "https://integrate.api.nvidia.com/v1\n");
    fs.chmodSync(routeFile, 0o444);
    const validation = `
import os
from deepagents_code import config

name = "NVIDIA_INFERENCE_API_KEY"
for value in (
    "openshell:resolve:env:NVIDIA_INFERENCE_API_KEY",
    "openshell:resolve:env:v12_NVIDIA_INFERENCE_API_KEY",
    "openshell:resolve:env:s" + "a" * 64 + "_NVIDIA_INFERENCE_API_KEY",
):
    os.environ[name] = value
    os.environ["DEEPAGENTS_CODE_OPENAI_API_KEY"] = "nemoclaw-managed-inference"
    for provider in ("openai", "openrouter"):
        resolved = config._get_provider_kwargs(provider, model_name="nvidia/nemotron-3-ultra-550b-a55b")
        assert "chat_template_kwargs" not in resolved.get("extra_body", {})
        assert resolved["api_key"] == value
        assert resolved["base_url"] == "https://integrate.api.nvidia.com/v1"

for value in (
    "",
    "nvapi-" + "x" * 32,
    "nemoclaw-managed-inference",
    "openshell:resolve:env:v12_OTHER_API_KEY",
    "openshell:resolve:env:v12_NVIDIA_INFERENCE_API_KEY\\n",
):
    os.environ[name] = value
    try:
        config._get_provider_kwargs("openai")
    except RuntimeError as error:
        assert not value or value not in str(error)
    else:
        raise AssertionError("native resolver accepted an invalid placeholder")
del os.environ[name]
try:
    config._get_provider_kwargs("openai")
except RuntimeError:
    pass
else:
    raise AssertionError("native resolver accepted a missing placeholder")
print("native-managed-constructor-placeholder-ok")
`;
    const output = execFileSync("python3", ["-c", validation], {
      env: { PATH: process.env.PATH, PYTHONPATH: tempDir },
      encoding: "utf8",
    });
    expect(output).toContain("native-managed-constructor-placeholder-ok");
  });

  it("uses only the native OpenRouter resolver handle for Deep Code requests (#13045)", () => {
    const tempDir = createPackageFixture();
    patchFixture(tempDir);
    const routeFile = path.join(tempDir, "managed-inference-base-url");
    const providerFile = path.join(tempDir, "managed-upstream-provider");
    fs.chmodSync(routeFile, 0o644);
    fs.writeFileSync(routeFile, "https://openrouter.ai/api/v1\n");
    fs.chmodSync(routeFile, 0o444);
    fs.chmodSync(providerFile, 0o644);
    fs.writeFileSync(providerFile, "openrouter-api\n");
    fs.chmodSync(providerFile, 0o444);

    const validation = `
import os
from deepagents_code import config
from deepagents_code import _nemoclaw_managed as managed

for root_provider in ("openrouter-api", "openrouter", "compatible-endpoint"):
    name = "COMPATIBLE_API_KEY" if root_provider == "compatible-endpoint" else "OPENROUTER_API_KEY"
    managed._UPSTREAM_PROVIDER_FILE.chmod(0o644)
    managed._UPSTREAM_PROVIDER_FILE.write_text(root_provider + "\\n")
    managed._UPSTREAM_PROVIDER_FILE.chmod(0o444)
    valid_handles = [
        "openshell:resolve:env:v12_" + name,
        "openshell:resolve:env:s" + "a" * 64 + "_" + name,
    ]
    canonical_handle = "openshell:resolve:env:" + name
    if root_provider != "compatible-endpoint":
        valid_handles.append(canonical_handle)
    for value in valid_handles:
        os.environ[name] = value
        resolved = config._get_provider_kwargs("openrouter")
        assert resolved["api_key"] == value, root_provider
        assert resolved["base_url"] == "https://openrouter.ai/api/v1"

    invalid_handles = [
        "",
        "sk-or-" + "x" * 32,
        "nemoclaw-managed-inference",
        "openshell:resolve:env:v12_NVIDIA_INFERENCE_API_KEY",
        "openshell:resolve:env:v12_" + name + "\\n",
    ]
    # Custom credentials must remain bound to their issued generation (#12636).
    if root_provider == "compatible-endpoint":
        invalid_handles.append(canonical_handle)
    for value in invalid_handles:
        os.environ[name] = value
        try:
            config._get_provider_kwargs("openrouter")
        except RuntimeError as error:
            assert not value or value not in str(error)
        else:
            raise AssertionError("native OpenRouter accepted an invalid handle")

    del os.environ[name]
    try:
        config._get_provider_kwargs("openrouter")
    except RuntimeError:
        pass
    else:
        raise AssertionError("native OpenRouter accepted a missing handle")

managed._UPSTREAM_PROVIDER_FILE.chmod(0o644)
managed._UPSTREAM_PROVIDER_FILE.write_text("openai\\n")
managed._UPSTREAM_PROVIDER_FILE.chmod(0o444)
assert config._get_provider_kwargs("openrouter")["api_key"] == "nemoclaw-managed-inference"
print("native-openrouter-constructor-handle-ok")
`;
    const output = execFileSync("python3", ["-c", validation], {
      env: { PATH: process.env.PATH, PYTHONPATH: tempDir },
      encoding: "utf8",
    });
    expect(output).toContain("native-openrouter-constructor-handle-ok");
  });

  it("binds the live Ultra E2E test to the installed resolver, not the configuration round trip (#7441)", () => {
    // The managed resolver never consumes the configuration params table, so a
    // ModelConfig.get_kwargs assertion passes with or without the fix. Keep the
    // live E2E test bound to the installed function it must verify.
    const e2eCheck = fs.readFileSync(e2eProfileCheckPath, "utf8");

    expect(e2eCheck).toContain("from deepagents_code.config import");
    expect(e2eCheck).toContain("_NEMOCLAW_NEMOTRON_ULTRA_MODEL_IDS,");
    expect(e2eCheck).toContain('_get_provider_kwargs("openai", model_name=model_id)');
    expect(e2eCheck).toContain('_get_provider_kwargs("openrouter", model_name=model_id)');
    expect(e2eCheck).toContain("managed_reasoning_effort,");
    expect(e2eCheck).toContain("MANAGED_REASONING_EFFORT = managed_reasoning_effort()");
    expect(e2eCheck).toContain("except ModelConfigError:");
    expect(e2eCheck).toContain("NEMOCLAW_MANAGED_RESOLVER_CONTRACT_OK:");
    // The resolver contract stays inference-free, like the profile contract.
    expect(e2eCheck).toContain("socket.socket = blocked_socket");
    expect(e2eCheck).toContain("socket.socket = real_socket");

    const resolverContract = e2eCheck.indexOf("MANAGED_BASE_URL = managed_inference_base_url()");
    const reportedResult = e2eCheck.indexOf("2 passed, 0 failed");
    expect(resolverContract).toBeGreaterThan(-1);
    expect(reportedResult).toBeGreaterThan(resolverContract);
  });
});

describe("native custom DCode constructor (#12636)", () => {
  it.each([
    [false, "", true],
    [true, "openshell:resolve:env:v12_COMPATIBLE_API_KEY", true],
    [true, "raw-secret", false],
    [true, "", false],
    [true, "openshell:resolve:env:v12_NVIDIA_INFERENCE_API_KEY", false],
  ])(
    "checks the live profile against generated routing (native=%s, credential=%s)",
    (native, credential, accepted) => {
      const root = createPackageFixture();
      patchFixture(root);
      const check = fs.readFileSync(e2eProfileCheckPath, "utf8");
      const configurationAssertions = check.slice(
        check.indexOf("config = tomllib.loads(CONFIG_PATH.read_text"),
        check.indexOf("model_kwargs = ModelConfig.load"),
      );
      const resolverAssertions = check.slice(
        check.indexOf("# A mutable allowlist"),
        check.indexOf("class ProfileOnlyChatOpenAI"),
      );
      const model = "nvidia/nvidia/nemotron-3-ultra";
      const endpoint = native
        ? "https://inference-api.nvidia.com/v1"
        : "https://inference.local/v1";
      const routeFile = path.join(root, "managed-inference-base-url");
      fs.chmodSync(routeFile, 0o644);
      fs.writeFileSync(routeFile, `${endpoint}\n`);
      fs.chmodSync(routeFile, 0o444);
      const providerFile = path.join(root, "managed-upstream-provider");
      fs.chmodSync(providerFile, 0o644);
      fs.writeFileSync(providerFile, "compatible-endpoint\n");
      fs.chmodSync(providerFile, 0o444);
      execFileSync(process.execPath, ["agents/langchain-deepagents-code/generate-config.ts"], {
        env: {
          PATH: process.env.PATH,
          HOME: root,
          NEMOCLAW_MODEL: model,
          NEMOCLAW_UPSTREAM_PROVIDER: "compatible-endpoint",
          NEMOCLAW_INFERENCE_BASE_URL: endpoint,
        },
      });
      const validation = `
import os, re, socket, tomllib
from pathlib import Path
from deepagents_code.config import _NEMOCLAW_NEMOTRON_ULTRA_MODEL_IDS, _get_provider_kwargs
from deepagents_code.model_config import ModelConfigError
from deepagents_code._nemoclaw_managed import managed_inference_base_url, managed_reasoning_effort, _managed_upstream_provider
CONFIG_PATH = Path(${JSON.stringify(path.join(root, ".deepagents", "config.toml"))})
MANAGED_MODEL_IDS = ("nvidia/nemotron-3-ultra-550b-a55b", ${JSON.stringify(model)})
EXPECTED_EXTRA_BODY = {"chat_template_kwargs": {"force_nonempty_content": True}}
${configurationAssertions}
${resolverAssertions}
`;
      const result = spawnSync("python3", ["-c", validation], {
        env: { PATH: process.env.PATH, PYTHONPATH: root, COMPATIBLE_API_KEY: credential },
        encoding: "utf8",
      });
      expect(
        {
          native,
          credential,
          accepted: result.status === 0,
          leaked: result.stderr.includes("raw-secret"),
        },
        result.stderr,
      ).toEqual({ native, credential, accepted, leaked: false });
    },
  );

  it("uses the issued custom credential and preserves the legacy shared route", () => {
    const tempDir = createPackageFixture();
    patchFixture(tempDir);
    const baseUrlFile = path.join(tempDir, "managed-inference-base-url");
    fs.chmodSync(baseUrlFile, 0o644);
    fs.writeFileSync(baseUrlFile, "https://api.example.com/v1\n");
    fs.chmodSync(baseUrlFile, 0o444);
    const providerFile = path.join(tempDir, "managed-upstream-provider");
    fs.chmodSync(providerFile, 0o644);
    fs.writeFileSync(providerFile, "compatible-endpoint\n");
    fs.chmodSync(providerFile, 0o444);
    const validation = `
import os
from deepagents_code import config
name = "COMPATIBLE_API_KEY"
for value in ("openshell:resolve:env:v12_COMPATIBLE_API_KEY", "openshell:resolve:env:s" + "a" * 64 + "_COMPATIBLE_API_KEY"):
    os.environ[name] = value
    result = config._get_provider_kwargs("openai", model_name="custom-model")
    assert result["api_key"] == value
    assert result["base_url"] == "https://api.example.com/v1"
for value in ("raw-secret", "openshell:resolve:env:COMPATIBLE_API_KEY", "openshell:resolve:env:v12_NVIDIA_INFERENCE_API_KEY"):
    os.environ[name] = value
    try:
        config._get_provider_kwargs("openai", model_name="custom-model")
    except RuntimeError as error:
        assert value not in str(error)
    else:
        raise AssertionError("accepted unbound credential")
print("custom-native-placeholder-ok")
`;
    expect(
      execFileSync("python3", ["-c", validation], {
        env: { PATH: process.env.PATH, PYTHONPATH: tempDir },
        encoding: "utf8",
      }),
    ).toContain("custom-native-placeholder-ok");
    const route = path.join(tempDir, "managed-inference-base-url");
    fs.chmodSync(route, 0o644);
    fs.writeFileSync(route, "https://inference.local/v1\n");
    fs.chmodSync(route, 0o444);
    expect(
      execFileSync(
        "python3",
        [
          "-c",
          'from deepagents_code import config; assert config._get_provider_kwargs("openai")["api_key"] == "nemoclaw-managed-inference"; print("legacy-ok")',
        ],
        { env: { PATH: process.env.PATH, PYTHONPATH: tempDir }, encoding: "utf8" },
      ),
    ).toContain("legacy-ok");
  });
});
