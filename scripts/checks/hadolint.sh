#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../../.github/hadolint.env
source "${script_dir}/../../.github/hadolint.env"
required_version="Haskell Dockerfile Linter ${HADOLINT_VERSION}"
if ! command -v hadolint >/dev/null 2>&1; then
  printf 'hadolint v%s is required; install it and put it on PATH.\n' "${HADOLINT_VERSION}" >&2
  exit 1
fi

if ! installed_version="$(hadolint --version)"; then
  printf 'hadolint version check failed; install hadolint v%s and put it on PATH.\n' "${HADOLINT_VERSION}" >&2
  exit 1
fi
if [ "${installed_version}" != "${required_version}" ]; then
  printf 'hadolint v%s is required; found %s. Put v%s before the current binary on PATH.\n' "${HADOLINT_VERSION}" "${installed_version}" "${HADOLINT_VERSION}" >&2
  exit 1
fi

exec hadolint "$@"
