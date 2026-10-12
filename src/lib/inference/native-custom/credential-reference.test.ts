// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { expect, it, vi } from "vitest";
import { captureOpenshellCommandAsync } from "../../adapters/openshell/command-execution";
import { resolveNativeCustomCredentialReference } from "./credential-reference";

const scope = {
  sandboxName: "alpha",
  gatewayName: "nemoclaw",
  credentialEnv: "COMPATIBLE_API_KEY",
};

it("reads only the selected sandbox issued credential reference through its named gateway (#12636)", async () => {
  const capture = vi.fn<NonNullable<Parameters<typeof resolveNativeCustomCredentialReference>[1]>>(
    (_args, options) =>
      captureOpenshellCommandAsync(
        process.execPath,
        [
          "-e",
          "process.stdout.write('openshell:resolve:env:v12_COMPATIBLE_API_KEY'); process.stderr.write('diagnostic-only');",
        ],
        options,
      ),
  );
  expect(await resolveNativeCustomCredentialReference(scope, capture)).toBe(
    "openshell:resolve:env:v12_COMPATIBLE_API_KEY",
  );
  expect(capture).toHaveBeenCalledWith(
    [
      "sandbox",
      "exec",
      "-g",
      "nemoclaw",
      "--name",
      "alpha",
      "--",
      "sh",
      "-lc",
      "printf '%s' \"${COMPATIBLE_API_KEY}\"",
    ],
    { ignoreError: true, includeStreams: true, timeout: 15000 },
  );
});

it.each([
  "raw-secret",
  "openshell:resolve:env:v1_NVIDIA_API_KEY",
  "openshell:resolve:env:COMPATIBLE_API_KEY",
])(
  "rejects credential output outside the issued selected-key boundary (%s) (#12636)",
  async (value) => {
    const capture = vi.fn(async () => ({ status: 0, stdout: value, output: value, stderr: value }));
    await expect(resolveNativeCustomCredentialReference(scope, capture)).rejects.toThrow(
      "no matching supervisor-issued credential reference",
    );
    try {
      await resolveNativeCustomCredentialReference(scope, capture);
    } catch (error) {
      expect(String(error)).not.toContain(value);
    }
  },
);

it.each([
  { ...scope, credentialEnv: "KEY; echo secret" },
  { ...scope, replacedReference: "raw-secret" },
  { ...scope, replacedReference: "openshell:resolve:env:v11_NVIDIA_INFERENCE_API_KEY" },
])("rejects an invalid credential scope before sandbox execution (%j) (#12636)", async (input) => {
  const capture = vi.fn();
  await expect(resolveNativeCustomCredentialReference(input, capture)).rejects.toThrow(
    /Invalid native custom/u,
  );
  expect(capture).not.toHaveBeenCalled();
});

it.each(["", "openshell:resolve:env:v11_COMPATIBLE_API_KEY"])(
  "waits for the selected custom credential projection to replace %s (#12636)",
  async (previous) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    try {
      const reference = "openshell:resolve:env:v12_COMPATIBLE_API_KEY";
      const capture = vi
        .fn(async () => ({ status: 0, stdout: reference, stderr: "", output: reference }))
        .mockImplementationOnce(async () => ({
          status: 0,
          stdout: previous,
          stderr: "",
          output: previous,
        }));
      const result = expect(
        resolveNativeCustomCredentialReference(
          { ...scope, ...(previous ? { replacedReference: previous } : {}) },
          capture,
        ),
      ).resolves.toBe(reference);
      void result.catch(() => {});
      await vi.advanceTimersByTimeAsync(1_000);
      await result;
      expect(capture).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  },
);

it.each(["COMPATIBLE_API_KEY", "COMPATIBLE_ANTHROPIC_API_KEY"])(
  "redacts transport capture failures for custom credential scope %s (#12636)",
  async (credentialEnv) => {
    const capture = vi.fn(async () => {
      throw new Error("credential-capture-secret-canary");
    });
    await expect(
      resolveNativeCustomCredentialReference({ ...scope, credentialEnv }, capture),
    ).rejects.toThrow("Native custom credential reference could not be read.");
  },
);

it("rejects a replaced reference that never converges within the projection deadline (#12636)", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  try {
    const replacedReference = "openshell:resolve:env:v11_COMPATIBLE_API_KEY";
    const capture = vi.fn(async () => ({
      status: 0,
      stdout: replacedReference,
      stderr: "",
      output: replacedReference,
    }));
    const result = expect(
      resolveNativeCustomCredentialReference({ ...scope, replacedReference }, capture),
    ).rejects.toThrow("no matching supervisor-issued credential reference");
    void result.catch(() => {});
    await vi.advanceTimersByTimeAsync(30_000);
    await result;
    expect(capture).toHaveBeenCalledTimes(30);
  } finally {
    vi.useRealTimers();
  }
});
