# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Publish what this image provides for Fabric.

The catalog records the adapters the image build installed, their runtime
layout, and the Fabric revision the image packages. Each harness stage declares
its adapters in /opt/nemoclaw/adapters.json; NemoClaw doesn't read Fabric's
descriptors, so harness settings are validated by Fabric when an agent is
configured.
"""

import argparse
import json
from pathlib import Path

from backend import HEALTH_CHECKS
from bridge_contract import capabilities
from runtime_metadata import read_runtime

ADAPTERS = Path("/opt/nemoclaw/adapters.json")
RUNTIME_MANIFEST = Path("/opt/nemoclaw/runtime.json")


def read_adapters(path):
    """Return the adapters a harness stage declared: their files and executables."""
    if not path.exists():
        raise ValueError(f"{path} must declare the image's adapters")
    declared = json.loads(path.read_text())
    if not isinstance(declared, dict) or not declared:
        raise ValueError(f"{path} must declare at least one adapter")
    for adapter_id, entry in declared.items():
        if not adapter_id or not isinstance(entry, dict) or set(entry) != {"files", "binaries"}:
            raise ValueError(f"{path} must give {adapter_id!r} its files and binaries")
        files, binaries = entry["files"], entry["binaries"]
        if not isinstance(files, list) or not all(
            isinstance(file, str) and file.startswith("/") and ".." not in file.split("/")
            for file in files
        ):
            raise ValueError(f"{path} must list absolute paths for {adapter_id}")
        if not isinstance(binaries, list) or not all(
            isinstance(binary, str) and binary and "/" not in binary for binary in binaries
        ):
            raise ValueError(f"{path} must list executable names for {adapter_id}")
    return declared


def snapshot(revision, source_sha256, *, adapters=ADAPTERS, runtime_manifest=RUNTIME_MANIFEST):
    declared = read_adapters(adapters)
    catalog = {
        "schema_version": 3,
        "fabric_revision": revision,
        "source_sha256": source_sha256,
        "bridge": capabilities(HEALTH_CHECKS),
        "adapters": [{"adapter_id": adapter_id} for adapter_id in sorted(declared)],
        "runtime": read_runtime(
            runtime_manifest,
            {adapter_id: entry["binaries"] for adapter_id, entry in declared.items()},
            required=True,
        ),
    }
    files = {adapter_id: entry["files"] for adapter_id, entry in declared.items() if entry["files"]}
    if files:
        catalog["runtime_files"] = files
    return catalog


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--revision")
    parser.add_argument("--source-sha256")
    parser.add_argument("--provenance", type=Path)
    parser.add_argument("--adapters", type=Path, default=ADAPTERS)
    parser.add_argument("--runtime-manifest", type=Path, default=RUNTIME_MANIFEST)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if args.provenance:
        provenance = json.loads(args.provenance.read_text())
        args.revision, args.source_sha256 = (
            provenance["fabric_revision"],
            provenance["source_sha256"],
        )
    if not args.revision or not args.source_sha256:
        parser.error("provide --provenance or both --revision and --source-sha256")
    encoded = (
        json.dumps(
            snapshot(
                args.revision,
                args.source_sha256,
                adapters=args.adapters,
                runtime_manifest=args.runtime_manifest,
            ),
            indent=2,
            sort_keys=True,
        )
        + "\n"
    )
    if args.output:
        args.output.write_text(encoded)
    else:
        print(encoded, end="")


if __name__ == "__main__":
    main()
