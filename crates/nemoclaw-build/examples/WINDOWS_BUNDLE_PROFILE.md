<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Windows bundle profile investigation

This experiment does not change the repository's release profile or normal CI.
It compares the existing release configuration with optimization level 2 for
named repository-owned workspace packages. Third-party settings remain unchanged.
Generated overrides live under the ignored .build/windows-bundle-profile directory;
the dependency-cache key still uses the unchanged .cargo/config.toml.

Preview the plan without building bundles or cleaning artifacts:

```sh
cargo run --locked --target-dir target/ci-runner -p nemoclaw-build \
  --no-default-features --example bundle_profile_experiment -- --plan
```

The optional Windows workflow runs only for the perf/windows-bundle-profile PR.
It restores, but does not save, the native bundle dependency cache. The driver
rejects --run and --restore outside Windows GitHub Actions.

The job:
1. Builds the SDK-enabled assembler once, outside sample timing.
2. Warms baseline and candidate, rebuilding release workspace artifacts each time.
3. Measures baseline/candidate/candidate/baseline, again rebuilding workspace
   artifacts before each sample while retaining dependencies.
4. Rejects measured samples that recompile third-party units or reuse the key
   workspace libraries. Verbose compiler logs attest the SDK optimization level.
5. Checks source identity, bundle inventory, and unchanged non-executable payloads.
6. Runs the complete native lifecycle suite against both saved bundles after
   measurement. Validation does not publish packages/images or use live clusters.

Samples time the complete bundle command: release compilation, schema/manifest
generation, and assembly. They exclude Cargo clean, dependency warmups, the
one-time dev assembler build, and snapshot copying. They are not whole-CI timings.

Artifacts contain raw logs, Cargo HTML reports, per-file byte sizes, generated
overrides, and native validation XML—not the large bundle snapshots. A failed
comparison remains a failed job; partial evidence is still uploaded.

Two samples per configuration provide directional evidence, not a stable
percentage estimate. Native tests establish functional behavior and end-to-end
test durations, not a CPU-throughput guarantee. Any production profile proposal
needs runtime/size assessment and the repository's normal bundle validation.

The investigation uses existing build collaborators; no production bundler,
cache policy, release profile, or ordinary CI checks are replaced.
