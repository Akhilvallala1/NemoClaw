# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Publish the reference dummy image's catalog without Fabric.

Production images record the adapters their build declared. The dummy
records its one reference adapter in the same catalog form, letting
deployments select it like any installed adapter.
"""

import json
from pathlib import Path

from backend import HEALTH_CHECKS
from bridge_contract import capabilities
from runtime_metadata import read_runtime

ROOT = Path("/opt/nemoclaw")


def snapshot(root=ROOT):
    # Not provenance.json: the host reports that file's revision as the Fabric
    # that validated a configuration, and Fabric validates nothing here.
    contract = json.loads((root / "contract.json").read_text())
    adapter_id = json.loads((root / "dummy.fabric-adapter.json").read_text())["adapter_id"]
    return {
        "schema_version": 3,
        # The Fabric revision whose adapter contract the descriptor follows.
        "fabric_revision": contract["fabric_revision"],
        "source_sha256": contract["source_sha256"],
        "bridge": capabilities(HEALTH_CHECKS),
        "adapters": [{"adapter_id": adapter_id}],
        "runtime": read_runtime(root / "runtime.json", {adapter_id: []}, required=True),
    }


if __name__ == "__main__":
    print(json.dumps(snapshot(), indent=2, sort_keys=True))
