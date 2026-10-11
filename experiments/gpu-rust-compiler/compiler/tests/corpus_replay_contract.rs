// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::PathBuf,
    process::Command,
    sync::atomic::{AtomicUsize, Ordering},
};

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let path = std::env::temp_dir().join(format!(
            "gpu-corpus-contract-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        Self(path)
    }
    fn rejected(&self) -> serde_json::Value {
        let input = self.0.join("captured.bc");
        let bytes = b"test capture; never submitted as compiler input";
        fs::write(&input, bytes).unwrap();
        serde_json::json!({"schema":"gpu-rust-corpus-census","version":1,"corpus_id":"test-corpus","source_revision":"test-revision","toolchain_id":"rust1.98.1-llvm22.1.8","total_units":1,"eligible_units":0,"rejected_units":1,"rejection_reasons":{"unsupported module":1},"exhaustive_capture_verified":true,"units":[{"input_path":input,"input_sha256":Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect::<String>(),"status":"rejected","reason":"unsupported module","eligibility_ms":0.2}]})
    }
    fn run(&self, manifest: &serde_json::Value) -> std::process::Output {
        let input = self.0.join("manifest.json");
        fs::write(&input, serde_json::to_vec(manifest).unwrap()).unwrap();
        Command::new(env!("CARGO_BIN_EXE_gpu-corpus-replay"))
            .args([
                "--manifest",
                input.to_str().unwrap(),
                "--report",
                self.0.join("report.json").to_str().unwrap(),
                "--backend",
                "metal",
                "--library",
                "/absent/native/library",
            ])
            .output()
            .unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn zero_eligible_modules_stop_before_gpu_initialization() {
    let fixture = Fixture::new();
    let output = fixture.run(&fixture.rejected());
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let report: serde_json::Value =
        serde_json::from_slice(&fs::read(fixture.0.join("report.json")).unwrap()).unwrap();
    assert_eq!(report["decision"], "stop-zero-eligible-modules");
    assert_eq!(report["gpu_executed"], false);
    assert_eq!(report["eligible_units"], 0);
}

#[test]
fn an_unverified_or_modified_capture_cannot_publish_a_replay_report() {
    let fixture = Fixture::new();
    let mut manifest = fixture.rejected();
    manifest["exhaustive_capture_verified"] = false.into();
    let output = fixture.run(&manifest);
    assert!(!output.status.success());
    assert!(!fixture.0.join("report.json").exists());
    manifest["exhaustive_capture_verified"] = true.into();
    manifest["units"][0]["input_sha256"] = "00".repeat(32).into();
    let output = fixture.run(&manifest);
    assert!(!output.status.success());
    assert!(!fixture.0.join("report.json").exists());
}

#[cfg(target_os = "macos")]
#[test]
#[ignore = "requires built TPDE bridge (GPU_CORPUS_BRIDGE) and a physical Metal device"]
fn captured_rust_modules_replay_with_persistent_services_and_stable_native_objects() {
    let fixture = Fixture::new();
    let bridge = std::env::var_os("GPU_CORPUS_BRIDGE").expect("GPU_CORPUS_BRIDGE");
    let mut units = Vec::new();
    let sha = |bytes: &[u8]| {
        Sha256::digest(bytes)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>()
    };
    for index in 0..2 {
        let source = fixture.0.join(format!("leaf{index}.rs"));
        let input = fixture.0.join(format!("leaf{index}.bc"));
        let packet = fixture.0.join(format!("leaf{index}.gem1"));
        // Powers of two become LLVM shifts, outside the frozen scalar schema.
        fs::write(&source, format!("#![no_std]\n#[no_mangle]\npub extern \"C\" fn replay_leaf_{index}(x:i64)->i64{{x.wrapping_mul({}).wrapping_add(11)}}\n",index*2+7)).unwrap();
        let compiled = Command::new("rustup")
            .args([
                "run",
                "1.98.1",
                "rustc",
                "--edition=2021",
                "--crate-type=lib",
                "--emit=llvm-bc",
                "-Copt-level=1",
                "-Cdebuginfo=0",
                "-Cpanic=abort",
                "-Ccodegen-units=1",
            ])
            .arg(&source)
            .arg("-o")
            .arg(&input)
            .output()
            .unwrap();
        assert!(
            compiled.status.success(),
            "{}",
            String::from_utf8_lossy(&compiled.stderr)
        );
        let exported = Command::new(&bridge)
            .arg("--export-leaf")
            .arg(&input)
            .arg(&packet)
            .output()
            .unwrap();
        assert!(
            exported.status.success(),
            "{}",
            String::from_utf8_lossy(&exported.stderr)
        );
        units.push(serde_json::json!({"input_path":input,"input_sha256":sha(&fs::read(&input).unwrap()),"packet_path":packet,"packet_sha256":sha(&fs::read(&packet).unwrap()),"status":"eligible","eligibility_ms":0.0}));
    }
    let manifest = fixture.0.join("manifest.json");
    fs::write(&manifest,serde_json::to_vec(&serde_json::json!({"schema":"gpu-rust-corpus-census","version":1,"corpus_id":"native-rust-test-corpus","source_revision":"native-test-fixture","toolchain_id":"rust1.98.1-llvm22.1.8","total_units":2,"eligible_units":2,"rejected_units":0,"rejection_reasons":{},"exhaustive_capture_verified":true,"units":units})).unwrap()).unwrap();
    let report_path = fixture.0.join("native-report.json");
    let shader = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("native/codegen.metal");
    let output = Command::new(env!("CARGO_BIN_EXE_gpu-corpus-replay"))
        .arg("--manifest")
        .arg(&manifest)
        .arg("--report")
        .arg(&report_path)
        .args([
            "--backend",
            "metal",
            "--library",
            env!("GPUEMIT_METAL_LIBRARY"),
        ])
        .arg("--shader")
        .arg(shader)
        .args(["--repeats", "3", "--cpu-workers", "2"])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let report: serde_json::Value =
        serde_json::from_slice(&fs::read(report_path).unwrap()).unwrap();
    assert_eq!(report["gpu_executed"], true);
    assert_eq!(report["unique_replayed_units"], 2);
    assert_eq!(report["persistent_sessions"], true);
    assert_eq!(report["all_objects_stable"], true);
    assert_eq!(report["whole_build_speedup_demonstrated"], false);
    assert_eq!(report["rounds"].as_array().unwrap().len(), 3);
    for round in report["rounds"].as_array().unwrap() {
        for side in ["cpu", "gpu"] {
            assert_eq!(round[side]["unique_modules"], 2);
            for unit in round[side]["units"].as_array().unwrap() {
                assert!(unit["object_bytes"].as_u64().unwrap() > 0);
                assert_eq!(unit["physical_gpu"], side == "gpu");
                if side == "gpu" {
                    assert!(unit["kernel_dispatches"].as_u64().unwrap() > 0);
                    assert_eq!(unit["kernel_output_used"], true);
                    assert!(!unit["device_id"].as_str().unwrap().is_empty());
                }
            }
        }
    }
}
