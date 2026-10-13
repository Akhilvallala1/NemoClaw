<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Configuration contract fixtures

`container.yaml` declares an application without protected inputs or agent connections.
Generic launch, placement, image, and readiness tests use it.
Its reserved endpoints and invented image digests are unsuitable for live apply.

The YAML files are inputs that tests load and modify; examples under `examples/` cover the maintained configurations.

These files are parser fixtures, not authorization to apply the embedded live deployment UIDs.
Live tests must select independent identities.

The `spark.yaml` fixture exercises the inline recipe schema.
