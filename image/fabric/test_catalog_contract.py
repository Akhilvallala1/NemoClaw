# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""The catalog records what the image build declared, without Fabric's descriptors."""

import json
import sys
import tempfile
import unittest
from pathlib import Path

from catalog import read_adapters, snapshot
from runtime_metadata import read_runtime

ADAPTER_ID = "org.fixture.agent"


class CatalogContract(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        executable = self.root / "bun-9"
        executable.write_text("#!/bin/sh\nexit 0\n")
        executable.chmod(0o755)
        (self.root / "bun").symlink_to(executable)
        self.executable = executable
        bridge = self.root / "bridge.py"
        bridge.write_text("# runtime bridge\n")
        self.layout = {
            "schema_version": 1,
            "command": [sys.executable, str(bridge)],
            "environment": {"PATH": str(self.root), "ADAPTER_PYTHON": sys.executable},
            "required_paths": [str(self.root)],
            "policy": {
                "version": 1,
                "filesystem_policy": {"read_only": [str(self.root)], "read_write": []},
                "process": {"run_as_user": "1234", "run_as_group": "1234"},
                "network_policies": {},
            },
        }
        self.manifest = self.root / "runtime.json"
        self.manifest.write_text(json.dumps(self.layout))

    def tearDown(self):
        self.directory.cleanup()

    def declare(self, declared):
        path = self.root / "adapters.json"
        path.write_text(json.dumps(declared))
        return path

    def snapshot(self, declared):
        return snapshot(
            "a" * 40, "b" * 64, adapters=self.declare(declared), runtime_manifest=self.manifest
        )

    def test_catalog_lists_declared_adapters_with_their_layout_and_executables(self):
        catalog = self.snapshot({ADAPTER_ID: {"files": ["/opt/runtime"], "binaries": ["bun"]}})
        self.assertEqual(catalog["schema_version"], 3)
        self.assertEqual(catalog["adapters"], [{"adapter_id": ADAPTER_ID}])
        self.assertEqual(catalog["runtime_files"], {ADAPTER_ID: ["/opt/runtime"]})
        self.assertEqual(
            catalog["bridge"],
            {
                "interface_version": 1,
                "operations": ["validate", "prepare", "configure", "check", "invoke", "serve"],
                "health_checks": [],
            },
        )
        self.assertEqual(catalog["runtime"]["command"], self.layout["command"])
        self.assertEqual(catalog["runtime"]["policy"], self.layout["policy"])
        self.assertEqual(
            catalog["runtime"]["binaries"][ADAPTER_ID],
            sorted([str(Path(sys.executable).resolve()), str(self.executable)]),
        )
        self.assertNotIn("targets", catalog)
        self.assertNotIn("descriptor", catalog["adapters"][0])

    def test_an_adapter_without_files_adds_no_runtime_files(self):
        catalog = self.snapshot({ADAPTER_ID: {"files": [], "binaries": []}})
        self.assertNotIn("runtime_files", catalog)
        self.assertEqual(
            catalog["runtime"]["binaries"][ADAPTER_ID], [str(Path(sys.executable).resolve())]
        )

    def test_invalid_declarations_fail_the_snapshot(self):
        for declared, message in [
            ({}, "at least one adapter"),
            ({ADAPTER_ID: {"files": []}}, "files and binaries"),
            ({ADAPTER_ID: {"files": ["opt/runtime"], "binaries": []}}, "absolute paths"),
            ({ADAPTER_ID: {"files": ["/opt/../etc"], "binaries": []}}, "absolute paths"),
            ({ADAPTER_ID: {"files": {"/opt": True}, "binaries": []}}, "absolute paths"),
            ({ADAPTER_ID: {"files": [], "binaries": ["/usr/bin/bun"]}}, "executable names"),
        ]:
            with self.subTest(declared=declared), self.assertRaisesRegex(ValueError, message):
                read_adapters(self.declare(declared))
        with self.assertRaisesRegex(ValueError, "declare the image's adapters"):
            read_adapters(self.root / "absent.json")

    def test_a_missing_executable_or_manifest_fails_the_snapshot(self):
        with self.assertRaisesRegex(ValueError, "missing required executable"):
            self.snapshot({ADAPTER_ID: {"files": [], "binaries": ["absent-executable"]}})
        with self.assertRaisesRegex(ValueError, "runtime manifest"):
            snapshot(
                "a" * 40,
                "b" * 64,
                adapters=self.declare({ADAPTER_ID: {"files": [], "binaries": []}}),
                runtime_manifest=self.root / "missing.json",
            )

    def test_runtime_manifest_validation_is_unchanged(self):
        declared = {ADAPTER_ID: ["bun"]}
        for field, invalid in [
            ("schema_version", True),
            ("command", [str(self.root)]),
            ("command", ["relative/bridge"]),
            ("required_paths", [str(self.root / "absent")]),
            ("environment", {"ADAPTER_PYTHON": str(self.root)}),
            ("environment", {"NEMOCLAW_PROVIDER_NAMES": "injected"}),
        ]:
            self.manifest.write_text(json.dumps({**self.layout, field: invalid}))
            with self.subTest(field=field, invalid=invalid), self.assertRaises(ValueError):
                read_runtime(self.manifest, declared, required=True)


if __name__ == "__main__":
    unittest.main()
