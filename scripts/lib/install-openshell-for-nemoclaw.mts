#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// The shell installer owns the guard so direct and projected calls cannot bypass it.
if (process.argv.length !== 2) {
  console.error("Cannot replace OpenShell: unsupported installer arguments.");
  process.exitCode = 1;
} else {
  const result = spawnSync(
    "bash",
    [fileURLToPath(new URL("../install-openshell.sh", import.meta.url))],
    { stdio: "inherit" },
  );
  process.exitCode = result.status ?? 1;
}
