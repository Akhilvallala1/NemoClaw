// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";
import { resolveNemoclawHomeDir } from "../paths";

/** Shared registry file identity for persistence and its mutation lock. */
export const SANDBOX_REGISTRY_FILE = path.join(
  resolveNemoclawHomeDir(process.env.HOME || "/tmp"),
  "sandboxes.json",
);
