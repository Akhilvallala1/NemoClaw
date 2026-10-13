# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Fail-closed checks for the dormant Switchyard release tuple."""

import copy
import hashlib
import io
import json
import tarfile
import tempfile
import unittest
from pathlib import Path

from switchyard_candidate import (
    ARCHIVE_DIRECTORIES,
    ARCHIVE_FILES,
    digest,
    validate_candidate,
)


class CandidateFixture:
    def __init__(self, root: Path):
        self.root = root
        self.lock = json.loads(
            (Path(__file__).parent / "switchyard-candidate.json").read_text(encoding="utf-8")
        )
        self.bundles = {}

    @staticmethod
    def add(archive: tarfile.TarFile, name: str, value: bytes | None = None) -> None:
        member = tarfile.TarInfo(name + ("/" if value is None else ""))
        member.mtime = 1
        member.mode = 0o755 if value is None else 0o644
        if value is None:
            member.type = tarfile.DIRTYPE
            archive.addfile(member)
        else:
            member.size = len(value)
            archive.addfile(member, io.BytesIO(value))

    def hermes(self) -> Path:
        candidate = self.lock["hermes"]
        archive_path = self.root / "hermes.tar.gz"
        dependency = (
            f"nemo-relay{candidate['relay_requirement']}; "
            f"python_version >= '{candidate['relay_python_minimum']}'"
        )
        project = f"[project]\ndependencies = [{json.dumps(dependency)}]\n".encode()
        wheel_markers = {"linux/arm64": "aarch64", "linux/amd64": "x86_64"}
        wheels = "\n".join(
            f'  {{ url = "https://example.invalid/nemo-relay-{wheel_markers[platform]}.whl", '
            f'hash = "sha256:{value}" }},'
            for platform, value in candidate["relay_wheels"].items()
        )
        resolved = (
            "[[package]]\n"
            'name = "nemo-relay"\n'
            f'version = "{candidate["relay_version"]}"\n'
            f"wheels = [\n{wheels}\n]\n"
        ).encode()
        prefix = f"hermes-agent-{candidate['commit']}"
        with tarfile.open(archive_path, "w:gz") as archive:
            self.add(archive, f"{prefix}/pyproject.toml", project)
            self.add(archive, f"{prefix}/uv.lock", resolved)
        candidate["archive_sha256"] = digest(archive_path)
        return archive_path

    def manifest(self, library_sha256: str) -> bytes:
        plugin = self.lock["plugin"]
        return f"""manifest_version = 1

[plugin]
id = "{plugin["id"]}"
kind = "rust_dynamic"

[compat]
relay = "{plugin["relay_compatibility"]}"
native_api = "{plugin["native_api"]}"

[defaults]
enabled = false

[capabilities]
items = ["plugin_native", "config_schema"]

[config_schema]
path = "config.schema.json"

[source]
artifact = "libswitchyard_nemo_relay_plugin.so"

[integrity]
sha256 = "sha256:{library_sha256}"

[load]
library = "libswitchyard_nemo_relay_plugin.so"
symbol = "nemo_relay_register_plugin"
""".encode()

    def bundle(self, platform: str, *, unsafe: bool = False) -> None:
        plugin = self.lock["plugin"]
        platform_lock = plugin["platforms"][platform]
        archive_path = self.root / platform_lock["archive"]
        library = f"native library for {platform}".encode()
        platform_lock["library_sha256"] = hashlib.sha256(library).hexdigest()
        schema = json.dumps(
            {
                "type": "object",
                "additionalProperties": False,
                "oneOf": [
                    {"required": ["switchyard_config_path"]},
                    {"required": ["switchyard_config"]},
                ],
            },
            sort_keys=True,
        ).encode()
        plugin["config_schema_sha256"] = hashlib.sha256(schema).hexdigest()
        values = {name: f"fixture {name}".encode() for name in ARCHIVE_FILES}
        values["config.schema.json"] = schema
        values["libswitchyard_nemo_relay_plugin.so"] = library
        values["relay-plugin.toml"] = self.manifest(platform_lock["library_sha256"])
        with tarfile.open(archive_path, "w:gz") as archive:
            if unsafe:
                self.add(archive, "../escape", b"unsafe")
            for directory in sorted(ARCHIVE_DIRECTORIES):
                self.add(archive, directory)
            for name, value in sorted(values.items()):
                self.add(archive, f"switchyard-plugin/{name}", value)
        platform_lock["archive_sha256"] = digest(archive_path)
        metadata = {
            "name": "switchyard-plugin",
            "version": plugin["version"],
            "platform": platform_lock["metadata_platform"],
            "repository_commit": plugin["producer_commit"],
            "repository_dirty": False,
            "source_commit": plugin["source_commit"],
            "relay": {
                "sha": self.lock["relay"]["commit"],
                "tag": self.lock["relay"]["version"],
                "binary_sha256": platform_lock["relay_binary_sha256"],
                "version_output": f"nemo-relay {self.lock['relay']['version']}",
            },
            "local_host_override": False,
            "toolchains": {"python": "3.11", "rust": "1.96.1"},
            "build_image": platform_lock["build_image"],
            "rust_target": platform_lock["rust_target"],
            "dynamic_musl_host": False,
            "tool_versions": platform_lock["tool_versions"],
            "sha256": platform_lock["archive_sha256"],
            "verified": True,
        }
        metadata_path = self.root / platform_lock["metadata"]
        metadata_path.write_text(json.dumps(metadata), encoding="utf-8")
        platform_lock["metadata_sha256"] = digest(metadata_path)
        self.bundles[platform] = archive_path

    def write_lock(self) -> Path:
        path = self.root / "candidate.json"
        path.write_text(json.dumps(self.lock), encoding="utf-8")
        return path


class SwitchyardCandidate(unittest.TestCase):
    def fixture(self, root: Path, *, unsafe_platform: str | None = None):
        fixture = CandidateFixture(root)
        hermes = fixture.hermes()
        for platform in fixture.lock["plugin"]["platforms"]:
            fixture.bundle(platform, unsafe=platform == unsafe_platform)
        return fixture, hermes

    def test_released_tuple_is_structurally_compatible_but_remains_inactive(self):
        with tempfile.TemporaryDirectory() as directory:
            fixture, hermes = self.fixture(Path(directory))
            receipt = validate_candidate(fixture.write_lock(), hermes, fixture.bundles)
        self.assertEqual(receipt["selection"], "candidate-only")
        self.assertFalse(receipt["activation_enabled"])
        self.assertEqual(receipt["plugin"]["platforms"], ["linux/amd64", "linux/arm64"])

    def test_activation_cannot_be_enabled_in_the_candidate_record(self):
        with tempfile.TemporaryDirectory() as directory:
            fixture, hermes = self.fixture(Path(directory))
            fixture.lock["activation_enabled"] = True
            with self.assertRaisesRegex(ValueError, "unselected and inactive"):
                validate_candidate(fixture.write_lock(), hermes, fixture.bundles)

    def test_archive_path_escape_is_rejected_before_files_are_used(self):
        with tempfile.TemporaryDirectory() as directory:
            fixture, hermes = self.fixture(Path(directory), unsafe_platform="linux/arm64")
            with self.assertRaisesRegex(ValueError, "unsafe path"):
                validate_candidate(fixture.write_lock(), hermes, fixture.bundles)

    def test_published_schema_digest_drift_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            fixture, hermes = self.fixture(Path(directory))
            changed = copy.deepcopy(fixture.lock)
            changed["plugin"]["config_schema_sha256"] = "0" * 64
            fixture.lock = changed
            with self.assertRaisesRegex(ValueError, "schema digest"):
                validate_candidate(fixture.write_lock(), hermes, fixture.bundles)

    def test_plugin_range_must_include_the_hermes_locked_relay(self):
        with tempfile.TemporaryDirectory() as directory:
            fixture, hermes = self.fixture(Path(directory))
            fixture.lock["plugin"]["relay_compatibility"] = ">=0.11.0, <1.0.0"
            with self.assertRaisesRegex(ValueError, "incompatible"):
                validate_candidate(fixture.write_lock(), hermes, fixture.bundles)


if __name__ == "__main__":
    unittest.main()
