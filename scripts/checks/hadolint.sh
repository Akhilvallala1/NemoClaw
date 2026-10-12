#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

required_version="Haskell Dockerfile Linter 2.14.0"
if ! command -v hadolint >/dev/null 2>&1; then
  printf '%s\n' "hadolint v2.14.0 is required; install it and put it on PATH." >&2
  exit 1
fi

installed_version="$(hadolint --version)"
if [ "${installed_version}" != "${required_version}" ]; then
  printf 'hadolint v2.14.0 is required; found %s. Put v2.14.0 before the current binary on PATH.\n' "${installed_version}" >&2
  exit 1
fi

exec hadolint "$@"
