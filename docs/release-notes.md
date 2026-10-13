<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Release Notes

These notes describe the v1 development documentation and its release boundaries.
v1 has no release yet; [#12638](https://github.com/NVIDIA/NemoClaw/issues/12638) tracks the first one.
The workspace package version alone does not establish that a release has been published.

## Product Changes

The development branch provides desired-state YAML, a Rust SDK, the `onboard`/`plan`/`apply`/`export`/`destroy` CLI, and a bundled OpenTofu provider.
See [the overview](overview.md) for implemented boundaries and [the CLI reference](reference/cli.md) for commands.

## Breaking Changes and Migration

Earlier CLI commands, schemas, and state formats have no compatibility guarantees.
See [migration](migration.md) for where each earlier task lives now, and [state](state.md) for data preservation.

The configuration API version is now `nemoclaw.nvidia.com/v1alpha2`, with its schema at `schemas/nemoclaw-v1alpha2.schema.json`.
It makes five changes:

- `spec.gateway.target` selects the backend with one key, `docker`, `podman`, or `kubernetes`, which holds that backend's settings.
  It replaces `runtime.provider` and `spec.gateway.kubernetes` and takes the managed `endpoint`, `engine`, and `imagePullPolicy`; `distribution: openshift` replaces the `openshift` provider.
- `spec.gateway.image` is removed; the SDK pins the gateway image.
- The managed gateway's `networkCIDR` is spelled `networkCidr`.
- `spec.sandboxes`, `spec.inferenceProviders`, and a sandbox's `inferenceProviders` are maps keyed by name instead of lists of entries with `name`.
- Credential references are typed `SecretRef` or `FileRef` in the schema and the Rust SDK; the YAML form `{env: NAME}` is unchanged.

Deployment state uses `intent.json` format version 8.
This NemoClaw rejects v1alpha1 documents and state written by an earlier NemoClaw without converting or adopting them; [re-author each document](migration.md#re-author-a-v1alpha1-document) and apply it as a separate deployment.

Docker-managed vLLM and Ollama services default to [`updatePolicy: Preserve`](inference.md#set-container-limits-and-update-policy), which refuses an image, model, serving, or container-limit change that would replace a running container; set `spec.services.<name>.updatePolicy: Recreate` to permit the replacement and its downtime.

## Qualification and Known Issues

See [current limits](limits.md) for what v1 does not do yet or has not tested, with the issue tracking each.

## Previous Releases

The combined staging site's **Latest (main)** version retains the imported main guides and changelog.
Use [earlier documentation](migration.md#find-earlier-documentation) to select that version; its release entries are not v1 release notes.
