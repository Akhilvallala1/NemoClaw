// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { claimNativeUiTunnelFrame } from "./native-ui-tunnel.mts";

test("native UI tunnel claims a frame before delivering it", () => {
  const removed: string[] = [];
  assert.deepEqual(
    claimNativeUiTunnelFrame(
      "C:\\relay\\stream-1\\host-0000000007.bin",
      {
        startedMs: 10,
        attempts: 2,
      },
      {
        platform: "win32",
        unlink: (file) => {
          removed.push(file);
        },
      },
    ),
    { claimed: true },
  );
  assert.deepEqual(removed, ["C:\\relay\\stream-1\\host-0000000007.bin"]);
});

test("native UI tunnel retries only transient Windows sharing denials", () => {
  for (const code of ["EACCES", "EBUSY", "EPERM"]) {
    let attempts = 0;
    assert.deepEqual(
      claimNativeUiTunnelFrame("C:\\relay\\stream-1\\host-0000000007.bin", undefined, {
        platform: "win32",
        now: () => 100,
        unlink: () => {
          attempts++;
          throw Object.assign(new Error("transient sharing denial"), { code });
        },
      }),
      { claimed: false, retry: { startedMs: 100, attempts: 1 } },
    );
    assert.equal(attempts, 1);
  }
  for (const [platform, code] of [
    ["linux", "EBUSY"],
    ["win32", "EIO"],
  ] as const)
    assert.throws(() =>
      claimNativeUiTunnelFrame("C:\\relay\\stream-1\\host-0000000007.bin", undefined, {
        platform,
        unlink: () => {
          throw Object.assign(new Error("non-retryable unlink failure"), { code });
        },
      }),
    );
});

test("native UI tunnel sharing retries are bounded", () => {
  const unlink = () => {
    throw Object.assign(new Error("persistent sharing denial"), { code: "EBUSY" });
  };
  const first = claimNativeUiTunnelFrame("C:\\relay\\stream-1\\host-0000000007.bin", undefined, {
    platform: "win32",
    now: () => 100,
    unlink,
  });
  assert.equal(first.claimed, false);
  assert.throws(
    () =>
      claimNativeUiTunnelFrame(
        "C:\\relay\\stream-1\\host-0000000007.bin",
        first.claimed ? undefined : first.retry,
        { platform: "win32", now: () => 350, unlink },
      ),
    /remained locked after 2 bounded attempts/u,
  );
});
