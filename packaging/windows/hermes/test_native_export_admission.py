# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Synthetic admission controls, not Windows runtime qualification."""

import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import unittest


spec = importlib.util.spec_from_file_location(
    "exporter", Path(__file__).with_name("export-official-runtime.py")
)
owner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(owner)
CURRENT = "1" * 40
SHA = "2" * 64
LEGACY_SHA = "59019111819aa577c30fc494616932486effef4af8b5e850040ecac860a93a1a"
SOURCE_NAMES = [
    "compat-launcher.cpp", "process-propagation.cpp", "process-propagation.h",
    "namespace-compat.cpp", "namespace-path.h", "namespace-security.h",
    "namespace-controls.cpp", "namespace-adapter-controls.cpp", "compat.def",
]


def marker_fixture(root_pid):
    return {
        "prepared": {"schemaVersion": 1, "classification": "native-Hermes-ui-owner",
                     "stage": "prepare", "rootPid": root_pid, "appContainerSid": "S-1-15-2-123-456",
                     "sessionId": 2, "exclusiveCreation": True, "mediumNoWriteUp": True,
                     "guestAccess": 0x120001, "descriptorMatched": True,
                     "policyAssignment": "PSEC-0x3ff-Win32k-false", "enforcementReadback": False},
        "closed": {"schemaVersion": 1, "classification": "native-Hermes-ui-owner",
                   "stage": "owner-close", "rootPid": root_pid, "closed": True,
                   "absentAfterOwnerClose": True, "presenceHandleClosed": True,
                   "absenceStatus": 0xC0000034},
    }


def fixture():
    compat = {
        "schemaVersion": 1,
        "classification": "mxc-msys-compatibility-prototype-build",
        "sourceRevision": CURRENT,
        "status": "built",
        "runtimeExecuted": False,
        "qualified": False,
        "cleanupErrors": [],
        "sourceFiles": [{"path": name, "sha256": SHA} for name in SOURCE_NAMES],
    }
    mxc = {
        "schemaVersion": 2,
        "classification": "mxc-native-owned-token-inspection-build",
        "candidateRevision": CURRENT,
        "status": "built",
        "tokenQueryRepairSupported": True,
        "tokenAccessMode": "owned-child-query-only",
        "nativeOwnerIdentity": "held-primary-appcontainer-token",
        "sourceCommit": "7cd00d1ee6af9208322c924ef64e5113f6704639",
        "sourceSha256": "9467669fda03a7ad0000a7bc9e0b0d1cab44b1979ee437dd96e8b93646e18029",
        "sourceBytes": 6545666,
        "target": "aarch64-pc-windows-msvc",
        "runtimeExecuted": False,
        "qualified": False,
        "compilerClosed": True,
        "compilerForced": False,
        "compilerExitCode": 0,
        "compilerCleanupErrors": [],
        "files": [{"file": "wxc-exec.exe", "machine": 0xAA64, "bytes": 123, "sha256": SHA}],
    }
    proof = {
        "schemaVersion": 2,
        "classification": "small-msys-native-basecontainer-compatibility-proof",
        "sourceRevision": CURRENT,
        "imageVariant": "ci-derived-unsigned-msys-dll-bash-and-sh-dynamic-base",
        "passed": True,
        "normalCleanup": True,
        "phase": "two-container-isolation",
        "nonce": "0123456789abcdef01234567",
        "startedExecutors": 5,
        "hostProcessesClosed": True,
        "hostProcessesNormal": True,
        "nativeExecutions": {},
        "cleanup": {},
        "inputs": {"compatibility": compat, "mxcBuild": mxc, "mxcSha256": SHA},
    }
    for index, role in enumerate(("base", "start", "d", "a", "b")):
        container_id = "nm-" + proof["nonce"][:12] + "-" + role
        proof["nativeExecutions"][container_id] = {
            "logSha256": SHA,
            "uiMarker": marker_fixture(100 + index) if role == "d" else None,
            "policy": {
                "event": "mxc.NetworkPolicyApplied", "backend": "processcontainer",
                "identity": "redacted", "tier": "base-container",
                "enforcement_mode": "capabilities", "default_policy": "block",
                "proxy_port": 0, "firewall_rules_created": 0,
                "firewall_applied": False, "status": "success",
            },
           "jobTeardown": {
                "schemaVersion": 1, "classification": "owned-native-MXC-job-teardown",
                "stage": "before-primary-handle-release", "clock": "GetTickCount64",
                "rootPid": 100 + index, "tickMilliseconds": 2345,
                "jobAccountingQueried": True, "jobAccountingKnown": True,
                "jobAccountingBytes": 48, "jobAccountingExpectedBytes": 48,
                "jobAccountingError": 0, "activeProcesses": 0,
                "totalProcesses": 4, "terminatedProcesses": 0,
               "rootWaitStatus": 0, "rootSignaled": True, "rootWaitError": 0,
           },
            "uiPolicy": {
                "schemaVersion": 1, "classification": "native-MXC-ui-policy-assignment",
                "stage": "before-primary-thread-resume",
                "policyOrigin": "serialized-process-security-environment",
                "securityEnvironmentAttached": True, "rootPid": 100 + index,
                "uiRestrictions": 0x3ff, "disallowWin32k": False,
                "policyMutated": False, "enforcementReadback": False,
            },
        }
        proof["cleanup"][container_id] = {
            "executor": {"closed": True, "forced": False, "exitCode": 0, "error": None},
            "nativeTeardownVerified": True, "nativeTeardownError": None,
            "shareRemoved": True,
        }
    return proof, compat, mxc


def personal_fixture(source_revision=CURRENT):
    """Inert synthetic documents; never a qualification receipt."""
    proof, _, _ = fixture()
    observation = copy.deepcopy(next(iter(proof["nativeExecutions"].values())))
    root_pid = observation["jobTeardown"]["rootPid"]
    marker = marker_fixture(root_pid)
    request = json.dumps({
        "containerId": "nm-0123456789ab-start", "version": "1.0.0",
        "containment": "processcontainer", "fallback": {"allowDaclMutation": False},
        "process": {"inheritDefaultEnv": False},
        "processContainer": {"leastPrivilege": False, "capabilities": []},
        "ui": {"disable": False, "clipboard": "none", "injection": False},
        "network": {"egress": {"default": "deny"},
                    "ingress": {"default": "deny", "hostLoopback": "deny"}},
        "telemetry": {"enabled": False},
    }).encode()
    event = lambda value: "[1791848997] " + json.dumps(value, separators=(",", ":")) + "\n"
    log = (
        event(observation["policy"])
        + "[1791848995] NEMOCLAW_NATIVE_UI_OWNER=" + json.dumps(marker["prepared"]) + "\n"
        + "[1791848996] NEMOCLAW_NATIVE_MXC_UI_POLICY=" + json.dumps(observation["uiPolicy"]) + "\n"
        + event({"event": "mxc.ProcessExited", "backend": "processcontainer",
                 "tier": "base-container", "pid": root_pid, "exit_code": 0})
        + event({"event": "mxc.SandboxTornDown", "backend": "processcontainer",
                 "identity": "redacted", "tier": "base-container", "pid": root_pid,
                 "status": "success", "firewall_rules_removed": 0, "firewall_removal_ok": True,
                 "bfs_removed": False, "proxy_stopped": False, "preserve_policy": False,
                 "container_released": False})
        + "[1791848998] NEMOCLAW_NATIVE_MXC_TEARDOWN=" + json.dumps(observation["jobTeardown"]) + "\n"
        + "[1791848999] NEMOCLAW_NATIVE_UI_OWNER=" + json.dumps(marker["closed"]) + "\n"
    ).encode()
    request_sha = hashlib.sha256(request).hexdigest()
    binding = {"executable": r"C:\native\wxc-exec.exe", "executorPid": 42,
               "policyFile": r"C:\owned\personal-request.json", "requestSha256": request_sha}
    record = {
        "schemaVersion": 2, "classification": "canonical-personal-mxc-feasibility",
        "sourceRevision": source_revision, "selectedTier": "base-container",
        "feasibilityPassed": True, "installedAcceptance": False, "fullAgentQualified": False,
        "privateStateLeaseTested": False, "executorAttempted": True,
        "rootsRetainedForUnclosedExecutor": False, "error": None, "cleanupErrors": [],
        "requestSha256": request_sha,
        "cleanup": dict.fromkeys(("executorClosed", "hostDesktopsReleased", "hostDiagnosticChildrenClosed",
                                  "nativeTeardownVerified", "ownedRootsRemoved", "browserDiagnosticComplete"), True),
        "execution": {"childClosed": True, "exitCode": 0, "signal": None, "error": None,
                      "timedOut": False, "outputExceeded": False, "nativeOutputExceeded": False,
                      "pid": 42, "executable": binding["executable"], "stderr": "", "nativeStderr": "",
                      "args": [binding["policyFile"], "--log-file", r"C:\owned\mxc-native.log"]},
        "nativeExecution": {"schemaVersion": 1, "classification": "native-Personal-execution-cleanup",
                            "binding": binding, "logSha256": hashlib.sha256(log).hexdigest(),
                            "jobTeardown": observation["jobTeardown"], "uiPolicy": observation["uiPolicy"],
                            "policy": observation["policy"], "uiMarker": marker},
        "hostDesktopCleanup": {"schemaVersion": 1, "classification": "closed-Personal-executor-desktop-cleanup",
                               "passed": True, "identityAndCloseVerified": True, "observerClosed": True,
                               "stage": "complete", "rootPid": root_pid, "error": None,
                               "binding": {**binding, "containerId": "nm-0123456789ab-start"}},
    }
    return record, request, log


class NativeAdmission(unittest.TestCase):
    def test_current_native_build_can_supply_a_new_proof_hash(self):
        proof, compat, mxc = fixture()
        self.assertIsNone(owner.validate_compatibility_proof(proof, SHA, compat, mxc, CURRENT))

    def test_native_proof_must_match_controller_and_dynamic_images(self):
        for key, value in [
            ("schemaVersion", 1), ("schemaVersion", True),
            ("classification", "local-basecontainer-diagnostic-not-installer-acceptance"),
            ("classification", "small-msys-appcontainer-compatibility-proof"),
            ("sourceRevision", "3" * 40), ("imageVariant", "original"),
            ("passed", False), ("passed", 1), ("normalCleanup", False),
            ("normalCleanup", 1),
            ("phase", "startup"), ("nonce", "3" * 24), ("startedExecutors", 4),
            ("hostProcessesClosed", False), ("hostProcessesNormal", False),
            ("nativeExecutions", {}), ("cleanup", {}),
        ]:
            with self.subTest(key=key, value=value):
                proof, compat, mxc = fixture()
                proof[key] = value
                with self.assertRaises(ValueError):
                    owner.validate_compatibility_proof(proof, SHA, compat, mxc, CURRENT)
        for revision in [None, "", "bad", "3" * 40]:
            with self.subTest(controller=revision):
                proof, compat, mxc = fixture()
                with self.assertRaises(ValueError):
                    owner.validate_compatibility_proof(proof, SHA, compat, mxc, revision)

    def test_native_owner_build_contract_is_not_replaced_by_legacy_or_compile_only_evidence(self):
        changes = [
            ("schemaVersion", 1), ("schemaVersion", True),
            ("classification", "mxc-owned-token-inspection-build"),
            ("candidateRevision", "3" * 40), ("status", "failed"),
            ("tokenQueryRepairSupported", False), ("tokenQueryRepairSupported", 1),
            ("tokenAccessMode", "full-access"), ("nativeOwnerIdentity", "supplied-profile-sid"),
            ("sourceCommit", "3" * 40), ("sourceSha256", "3" * 64),
            ("sourceBytes", 1), ("sourceBytes", 6545666.0),
            ("target", "x86_64-pc-windows-msvc"),
            ("runtimeExecuted", True), ("qualified", True),
            ("compilerClosed", False), ("compilerClosed", 1),
            ("compilerForced", True), ("compilerExitCode", 1),
            ("compilerExitCode", False), ("compilerCleanupErrors", ["open child"]),
        ]
        for key, value in changes:
            with self.subTest(key=key, value=value):
                proof, compat, mxc = fixture()
                mxc[key] = value
                with self.assertRaises(ValueError):
                    owner.validate_compatibility_proof(proof, SHA, compat, mxc, CURRENT)

    def test_compatibility_build_is_current_unqualified_and_complete(self):
        for key, value in [
            ("schemaVersion", True), ("schemaVersion", 2),
            ("sourceRevision", "3" * 40), ("status", "failed"),
            ("classification", "local-diagnostic"), ("runtimeExecuted", True),
            ("qualified", True), ("cleanupErrors", ["open compiler"]),
            ("sourceFiles", []),
            ("sourceFiles", [{"path": name, "sha256": SHA} for name in SOURCE_NAMES[:-1]]),
            ("sourceFiles", [{"path": name, "sha256": SHA} for name in SOURCE_NAMES + [SOURCE_NAMES[0]]]),
        ]:
            with self.subTest(key=key, value=value):
                proof, compat, mxc = fixture()
                compat[key] = value
                with self.assertRaises(ValueError):
                    owner.validate_compatibility_proof(proof, SHA, compat, mxc, CURRENT)

    def test_proof_and_separately_loaded_builds_must_be_identical(self):
        for key in ["compatibility", "mxcBuild"]:
            with self.subTest(key=key):
                proof, compat, mxc = fixture()
                proof["inputs"][key] = copy.deepcopy(proof["inputs"][key])
                proof["inputs"][key]["status"] = "other-build"
                with self.assertRaises(ValueError):
                    owner.validate_compatibility_proof(proof, SHA, compat, mxc, CURRENT)

    def test_exact_native_executor_bytes_are_bound_to_the_proof(self):
        for key, value in [
            ("file", "other.exe"), ("machine", 0x8664), ("machine", float(0xAA64)), ("bytes", 0),
            ("bytes", True), ("sha256", "bad"), ("sha256", "3" * 64),
        ]:
            with self.subTest(key=key, value=value):
                proof, compat, mxc = fixture()
                mxc["files"][0][key] = value
                with self.assertRaises(ValueError):
                    owner.validate_compatibility_proof(proof, SHA, compat, mxc, CURRENT)
        for files in [[], fixture()[2]["files"] * 2]:
            proof, compat, mxc = fixture()
            mxc["files"] = files
            with self.assertRaises(ValueError):
                owner.validate_compatibility_proof(proof, SHA, compat, mxc, CURRENT)

    def test_each_native_execution_requires_policy_job_and_cleanup_evidence(self):
        mutations = [
            lambda p, i: p["nativeExecutions"].pop(i),
            lambda p, i: p["cleanup"].pop(i),
            lambda p, i: p["nativeExecutions"][i].update(logSha256="bad"),
            lambda p, i: p["nativeExecutions"][i].pop("uiPolicy"),
            lambda p, i: p["nativeExecutions"][i].pop("uiMarker"),
            lambda p, i: p["nativeExecutions"][i]["uiPolicy"].update(uiRestrictions=0x3bf),
            lambda p, i: p["nativeExecutions"][i]["uiPolicy"].update(rootPid=99),
            lambda p, i: p["nativeExecutions"][i]["uiPolicy"].update(rootPid=True),
            lambda p, i: p["nativeExecutions"][i]["uiPolicy"].update(securityEnvironmentAttached=1),
            lambda p, i: p["nativeExecutions"][i]["uiPolicy"].update(enforcementReadback=True),
            lambda p, i: p["nativeExecutions"][i]["policy"].update(tier="appcontainer-dacl"),
            lambda p, i: p["nativeExecutions"][i]["policy"].update(default_policy="allow"),
            lambda p, i: p["nativeExecutions"][i]["policy"].update(firewall_applied=0),
            lambda p, i: p["nativeExecutions"][i]["jobTeardown"].update(activeProcesses=1),
            lambda p, i: p["nativeExecutions"][i]["jobTeardown"].update(rootSignaled=False),
            lambda p, i: p["nativeExecutions"][i]["jobTeardown"].update(rootPid=True),
            lambda p, i: p["nativeExecutions"][i]["jobTeardown"].update(jobAccountingKnown=False),
            lambda p, i: p["nativeExecutions"][i]["jobTeardown"].update(terminatedProcesses=5),
            lambda p, i: p["cleanup"][i].update(nativeTeardownVerified=1),
            lambda p, i: p["cleanup"][i].pop("nativeTeardownError"),
            lambda p, i: p["cleanup"][i].update(shareRemoved=False),
            lambda p, i: p["cleanup"][i]["executor"].update(forced=True),
            lambda p, i: p["cleanup"][i]["executor"].update(exitCode=False),
            lambda p, i: p["cleanup"][i]["executor"].pop("error"),
        ]
        for container_id in fixture()[0]["nativeExecutions"]:
            for index, mutate in enumerate(mutations):
                with self.subTest(container=container_id, case=index):
                    proof, compat, mxc = fixture()
                    mutate(proof, container_id)
                    with self.assertRaises(ValueError):
                        owner.validate_compatibility_proof(proof, SHA, compat, mxc, CURRENT)

        for role in ("base", "start", "d", "a", "b"):
            proof, compat, mxc = fixture()
            row = proof["nativeExecutions"]["nm-" + proof["nonce"][:12] + "-" + role]
            row["uiMarker"] = None if role == "d" else marker_fixture(row["jobTeardown"]["rootPid"])
            with self.subTest(marker_role=role), self.assertRaises(ValueError):
                owner.validate_compatibility_proof(proof, SHA, compat, mxc, CURRENT)
        for section, changes in (
            ("prepared", {"rootPid": True, "appContainerSid": "S-1-5-21-1", "sessionId": True,
                          "exclusiveCreation": False, "mediumNoWriteUp": False, "guestAccess": 0x1F0003,
                          "descriptorMatched": False, "policyAssignment": "job-zero", "enforcementReadback": True}),
            ("closed", {"rootPid": 99, "closed": False, "absentAfterOwnerClose": False,
                        "presenceHandleClosed": False, "absenceStatus": 0xC0000022}),
        ):
            for key, value in changes.items():
                proof, compat, mxc = fixture()
                proof["nativeExecutions"]["nm-" + proof["nonce"][:12] + "-d"]["uiMarker"][section][key] = value
                with self.subTest(section=section, key=key), self.assertRaises(ValueError):
                    owner.validate_compatibility_proof(proof, SHA, compat, mxc, CURRENT)

    def test_historical_proof_retains_its_exact_hash_and_revision(self):
        proof, compat, mxc = fixture()
        proof.update(classification="small-msys-appcontainer-compatibility-proof",
                     sourceRevision="43c9e32485f802ac277d9d0f7959c802facda04d")
        self.assertIsNone(owner.validate_compatibility_proof(proof, LEGACY_SHA, compat, mxc, CURRENT))
        with self.assertRaises(ValueError):
            owner.validate_compatibility_proof(proof, SHA, compat, mxc, CURRENT)
        proof["sourceRevision"] = CURRENT
        with self.assertRaises(ValueError):
            owner.validate_compatibility_proof(proof, LEGACY_SHA, compat, mxc, CURRENT)


if __name__ == "__main__":
    unittest.main()
