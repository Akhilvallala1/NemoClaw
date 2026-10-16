<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Configuration contract fixtures

`container.yaml` declares an application without protected inputs or agent connections.
`container-credentials.yaml` adds a credential reference and manual VoiceClaw environment settings; the SDK treats those settings as ordinary strings.
Generic launch, placement, image, and readiness tests use it.
Its reserved endpoints and invented image digests are unsuitable for live apply.
`explicit-ollama.yaml` and `explicit-vllm.yaml` are the generic-container counterparts of `managed-ollama.yaml` and `examples/spark/vllm.yaml`.
The service-reference test compares their launch, runtime policy, and endpoint; regenerate intentional changes with `NEMOCLAW_REGENERATE_FIXTURES=1 cargo test -p nemoclaw-sdk --test integration explicit_containers_can_run`.
They do not establish Linux GPU readiness or permit reuse of an existing deployment's UID.

The YAML files are inputs that tests load and modify; examples under `examples/` cover the maintained configurations.

These files are parser fixtures, not authorization to apply the embedded live deployment UIDs.
Live tests must select independent identities.

The `spark.yaml` fixture exercises the inline recipe schema.
