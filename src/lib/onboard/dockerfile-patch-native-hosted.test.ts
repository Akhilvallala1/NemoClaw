// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { patchStagedDockerfile } from "./dockerfile-patch";
import {
  customAttachmentFromPrepared,
  prepareNativeCustomProfile,
} from "../inference/native-custom";

function dockerfileWith(content: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-hosted-dockerfile-"));
  onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "Dockerfile");
  fs.writeFileSync(file, content);
  return file;
}

describe("Hermes Dockerfile route selection", () => {
  it.each([false, true])(
    "compiles custom credential authority only for a native attachment (%s)",
    async (native) => {
      const prepared = await prepareNativeCustomProfile({
        sandboxName: "custom-agent",
        provider: "compatible-endpoint",
        endpointUrl: "https://custom.example/v1",
        api: "openai-completions",
        lookup: async () => [{ address: "8.8.8.8", family: 4 }],
      });
      const receipt = customAttachmentFromPrepared(prepared, {
        schemaVersion: 1,
        profileId: prepared.profile.id,
        providerName: prepared.providerName,
        providerId: "owned-provider-id",
      });
      const file = dockerfileWith(
        "FROM example/base\nARG NEMOCLAW_INFERENCE_BASE_URL=old\nARG NEMOCLAW_NATIVE_CUSTOM_CREDENTIAL_ENV=stale\n",
      );
      patchStagedDockerfile(
        file,
        "fixture-model",
        "",
        "build",
        "compatible-endpoint",
        "openai-completions",
        null,
        null,
        false,
        null,
        [],
        native ? { nativeCustomProviderAttachment: receipt } : {},
      );
      const rendered = fs.readFileSync(file, "utf8");
      expect(rendered).toContain(
        `ARG NEMOCLAW_NATIVE_CUSTOM_CREDENTIAL_ENV=${native ? "COMPATIBLE_API_KEY" : ""}\n`,
      );
      expect(rendered).toContain(
        `ARG NEMOCLAW_INFERENCE_BASE_URL=${native ? "https://custom.example/v1" : "https://inference.local/v1"}\n`,
      );
    },
  );

  it.each([
    {
      nativeProvider: false,
      upstreamEndpointUrl: "https://custom.example/v1",
      expected: "https://inference.local/v1",
    },
    {
      nativeProvider: undefined,
      upstreamEndpointUrl: "https://custom.example/v1",
      expected: "https://inference.local/v1",
    },
    {
      nativeProvider: true,
      upstreamEndpointUrl: "https://authenticated.example/v1",
      expected: "https://authenticated.example/v1",
    },
    {
      nativeProvider: true,
      upstreamEndpointUrl: "https://inference-api.nousresearch.com/v1",
      expected: "https://inference-api.nousresearch.com/v1",
    },
  ])(
    "renders $upstreamEndpointUrl with nativeProvider=$nativeProvider",
    ({ expected, ...options }) => {
      const file = dockerfileWith(
        "FROM example/base\nARG NEMOCLAW_INFERENCE_BASE_URL=old\nARG NEMOCLAW_UPSTREAM_ENDPOINT_URL=old\n",
      );
      patchStagedDockerfile(
        file,
        "fixture-model",
        "",
        "build",
        "hermes-provider",
        null,
        null,
        null,
        false,
        null,
        [],
        options,
      );
      const rendered = fs.readFileSync(file, "utf8");
      expect(rendered).toContain(`ARG NEMOCLAW_INFERENCE_BASE_URL=${expected}\n`);
      expect(rendered).toContain(
        `ARG NEMOCLAW_UPSTREAM_ENDPOINT_URL=${options.upstreamEndpointUrl}\n`,
      );
    },
  );
});
