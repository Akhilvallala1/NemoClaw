<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Final bounded GPU test

Continue this GPU route only after a repeatable reduction of at least 10% in
complete fast-build time against the strongest compatible CPU baseline, with
semantic checks and separate 1.5-times compiler/program size limits passing.
Kernel timing, synthetic throughput and cached builds cannot pass this gate.
This draft must remain non-shipping.

## Available compiler work

First capture every LLVM module from a fresh complete NemoClaw fast build.
Set `GPU_LINK_CAPTURE_DIR` on a `gpu-cargo build` using the `llvm-bitcode`
backend and a new target root. The wrapper saves exact bitcode before replacing
it with a CPU object. Each invocation owns a separate directory and manifest.
Capture copies, hashes and reports are included in the audit's costs; its build
time is not a qualified performance comparison.

`gpu-corpus-census` inspects every captured module through the pinned bridge's
strict exporter. It verifies input bytes and matches manifests, arguments,
targets, code-generation levels, costs and input-hash multiplicities to completed
wrapper receipts. Capture counts must equal the build's translated-unit count.
Accepted packets also pass the CPU encoding and native object contract.
Invalid input or broken tooling fails the census instead of counting as
unsupported work.

The October 10 Mac audit captured **3,536 modules across 494 translated Rust
invocations**. **Zero whole modules qualified**. Rejection reasons included:

| First rejection | Modules |
| --- | ---: |
| Globals, aliases, indirect functions or module assembly | 2,615 |
| Unsupported C ABI/signature | 726 |
| Unsupported linkage/visibility | 102 |
| No defined functions | 61 |
| Unsupported argument type | 22 |
| Export input exceeds the current 2 MiB bound | 6 |
| Other unsupported attributes, control flow or arithmetic | 4 |

These are first rejection reasons, not a complete census of every construct
inside each module. The recorded checkout was dirty; this is local Mac evidence,
not exact-head Linux/CUDA qualification. The generated NemoClaw executable ran
`--version` and measured 41,319,680 bytes after consistent stripping, versus
31,278,848 for its declared reference (+32.10%, within the program limit).

A separate Rust control fixture produced one eligible module and seven rejected
modules. It exercised capture, census and five alternating persistent CPU/Metal
replay rounds with stable object bytes. A further two-module hardware test
checks parallel CPU workers and retained Metal sessions. These are validation
fixtures, not larger NemoClaw workloads or evidence of a compilation speedup.

## Replay and decision

For nonzero eligibility, `gpu-corpus-replay` consumes the census directly.
It verifies snapshots and packet hashes, deduplicates identical inputs, retains
parallel CPU and physical GPU services, and alternates complete corpus rounds.
Each unique module runs once per side per round; repeats do not create additional
distinct work. It records decode/pack, queues, device execution, independent CPU
byte checks and object serialization. Worker durations overlap and must not be
added as whole-build wall time. GPU-only eligibility work is charged separately
to the GPU route.

The leaf CPU encoder is a matched algorithm comparison. It does not qualify the
strongest complete Rust CPU backend. Replay excludes Rust frontend, unsupported
modules, fallback, linking and generated-program runtime. Stable objects do not
establish native program execution. A favorable replay would only justify a
subsequent matched complete-build comparison.

If no whole modules qualify, available work for this GPU implementation is
exactly zero, even with a zero-cost GPU. Park this route without manufacturing
a larger batch or implementing a daemon. Supporting arbitrary signatures,
globals and control flow would require another compiler project and falls
outside this final bounded test. Preserve CPU compile-time controls and the
experiment's evidence. No multi-GPU scaling claim is established.

The draft workflow repeats the complete capture and census in its offline CUDA
validation environment on the RTX PRO 6000 runner. Locked dependencies are
fetched beforehand, and protoc matches the repository's pinned version.
Only eligible captured work enters CUDA replay. It retains exact-head source
identity, raw bitcode, manifests, receipts and reports, including failures.
The independent CUDA integration checks still verify GPU object emission and
full Rust fixture linking/cache behavior.
