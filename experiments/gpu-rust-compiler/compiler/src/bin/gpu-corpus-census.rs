// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use gpu_rust_compiler::{leaf_packet, machine_codegen};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    env, fs,
    io::Write,
    path::{Component, Path, PathBuf},
    process::Command,
    time::Instant,
};

fn hash(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn export_outcome(code: i32, diagnostic: &str, packet: Option<&[u8]>) -> Result<bool, String> {
    match code {
        0 if packet.is_some_and(|p| p.len() > 8 && p.starts_with(b"GEM1")) => Ok(true),
        0 => Err("successful export did not produce a GEM1 packet".into()),
        20 if !diagnostic.trim().is_empty() && packet.is_none() => Ok(false),
        _ => Err(format!("leaf inspection failed ({code}): {diagnostic}")),
    }
}

fn capture_path(directory: &Path, name: &str) -> Result<PathBuf, String> {
    let path = Path::new(name);
    if path.components().count() != 1
        || !matches!(path.components().next(), Some(Component::Normal(_)))
        || path.extension().and_then(|s| s.to_str()) != Some("bc")
    {
        return Err("capture filename must be a bitcode basename".into());
    }
    let candidate = directory.join(path);
    if fs::symlink_metadata(&candidate)
        .map_err(|e| e.to_string())?
        .file_type()
        .is_symlink()
    {
        return Err("captured input cannot be a symlink".into());
    }
    fs::canonicalize(candidate).map_err(|e| e.to_string())
}

fn verify_input(bytes: &[u8], sha: &str, size: u64) -> Result<(), String> {
    if (!bytes.starts_with(b"BC\xc0\xde") && !bytes.starts_with(b"\xde\xc0\x17\x0b"))
        || bytes.len() as u64 != size
        || hash(bytes) != sha
    {
        return Err("capture bytes, length or hash differ from the manifest".into());
    }
    Ok(())
}

fn matched_inputs(actual: &[String], expected: &[String]) -> Result<(), String> {
    fn counts(inputs: &[String]) -> BTreeMap<&str, usize> {
        let mut counts = BTreeMap::new();
        for input in inputs {
            *counts.entry(input.as_str()).or_insert(0usize) += 1;
        }
        counts
    }
    if counts(actual) != counts(expected) {
        return Err("captured input hashes differ from the completed wrapper receipts".into());
    }
    Ok(())
}

fn bind_capture(capture: &Value, receipt: &Value) -> Result<(), String> {
    for key in [
        "status",
        "source",
        "input_arguments_sha256",
        "quality",
        "requested_backend",
        "rustc_version_verbose",
    ] {
        if capture.get(key).is_none() || capture.get(key) != receipt.get(key) {
            return Err(format!(
                "capture header differs from wrapper receipt: {key}"
            ));
        }
    }
    let captured = capture
        .get("units")
        .and_then(Value::as_array)
        .ok_or("capture has no units")?;
    let emitted = receipt
        .get("units")
        .and_then(Value::as_array)
        .ok_or("receipt has no units")?;
    if captured.len() != emitted.len() {
        return Err("capture unit count differs from its wrapper receipt".into());
    }
    for (index, (capture_unit, emitted_unit)) in captured.iter().zip(emitted).enumerate() {
        if integer(capture_unit, "unit_index")? != index as u64
            || capture_unit.get("emission_receipt") != Some(emitted_unit)
            || capture_unit.get("target") != emitted_unit.get("target")
            || capture_unit.get("controller_elapsed_ms")
                != emitted_unit.get("controller_elapsed_ms")
            || capture_unit.get("input_sha256") != emitted_unit.get("input_sha256")
            || capture_unit.get("llvm_codegen_opt_level") != capture.get("llvm_codegen_opt_level")
            || capture_unit.get("llvm_codegen_opt_level")
                != emitted_unit.pointer("/controller_receipt/llvm_codegen_opt_level")
        {
            return Err(
                "captured unit identity, codegen level or cost differs from its emission receipt"
                    .into(),
            );
        }
    }
    Ok(())
}

fn read_json(path: &Path) -> Result<Value, String> {
    serde_json::from_slice(&fs::read(path).map_err(|e| e.to_string())?)
        .map_err(|e| format!("{}: {e}", path.display()))
}
fn text<'a>(value: &'a Value, key: &str) -> Result<&'a str, String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("missing string {key}"))
}
fn integer(value: &Value, key: &str) -> Result<u64, String> {
    value
        .get(key)
        .and_then(Value::as_u64)
        .ok_or_else(|| format!("missing integer {key}"))
}

fn run() -> Result<(), String> {
    let mut options = BTreeMap::new();
    let mut args = env::args().skip(1);
    while let Some(key) = args.next() {
        if key == "--help" {
            println!("gpu-corpus-census --corpus-root DIR --build-report JSON --bridge FILE --packet-dir NEW_DIR --report NEW_JSON\nInspect every captured Rust LLVM module with the strict whole-module GPU exporter. This audit does not measure GPU acceleration.");
            return Ok(());
        }
        if ![
            "--corpus-root",
            "--build-report",
            "--bridge",
            "--packet-dir",
            "--report",
        ]
        .contains(&key.as_str())
        {
            return Err(format!("unknown option {key}"));
        }
        let value = args
            .next()
            .ok_or_else(|| format!("missing value for {key}"))?;
        if options.insert(key.clone(), value).is_some() {
            return Err(format!("duplicate {key}"));
        }
    }
    let required = |key: &str| -> Result<PathBuf, String> {
        options
            .get(key)
            .map(PathBuf::from)
            .ok_or_else(|| format!("missing {key}"))
    };
    let root = fs::canonicalize(required("--corpus-root")?).map_err(|e| e.to_string())?;
    let build_path = fs::canonicalize(required("--build-report")?).map_err(|e| e.to_string())?;
    let build = read_json(&build_path)?;
    if text(&build, "schema")? != "gpu-cargo-report"
        || text(&build, "status")? != "ok"
        || text(&build, "object_backend")? != "llvm-bitcode"
        || build
            .pointer("/artifact/cargo_fresh")
            .and_then(Value::as_bool)
            != Some(false)
    {
        return Err("a successful fresh LLVM-bitcode Cargo audit is required".into());
    }
    let receipts = build
        .get("object_backend_receipts")
        .ok_or("missing wrapper receipts")?;
    let expected = integer(receipts, "translated_units")?;
    if expected == 0 || integer(receipts, "failed_semantic_invocations")? != 0 {
        return Err(
            "capture build contains no translated units or a failed semantic invocation".into(),
        );
    }
    let mut expected_inputs = vec![];
    let mut raw_captures = BTreeMap::new();
    for entry in fs::read_dir(text(receipts, "directory")?).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if !entry.file_type().map_err(|e| e.to_string())?.is_file() {
            return Err("wrapper receipt directory contains a non-file".into());
        }
        let receipt = read_json(&entry.path())?;
        if let Some(capture_path) = receipt.get("capture_manifest").and_then(Value::as_str) {
            let capture_path = fs::canonicalize(capture_path).map_err(|e| e.to_string())?;
            if !capture_path.starts_with(&root)
                || raw_captures.insert(capture_path, receipt.clone()).is_some()
            {
                return Err(
                    "wrapper capture path is outside the selected corpus or duplicated".into(),
                );
            }
        }
        for unit in receipt
            .get("units")
            .and_then(Value::as_array)
            .ok_or("wrapper receipt has no units")?
        {
            expected_inputs.push(text(unit, "input_sha256")?.to_string());
        }
    }
    if expected_inputs.len() as u64 != expected {
        return Err("raw wrapper receipts differ from the aggregate module count".into());
    }
    let bridge = fs::canonicalize(required("--bridge")?).map_err(|e| e.to_string())?;
    if build
        .pointer("/backend_toolchain/bridge/sha256")
        .and_then(Value::as_str)
        != Some(hash(&fs::read(&bridge).map_err(|e| e.to_string())?).as_str())
    {
        return Err("census bridge differs from capture build provenance".into());
    }
    let packet_dir = required("--packet-dir")?;
    fs::create_dir(&packet_dir).map_err(|e| format!("claim new packet directory: {e}"))?;
    let packet_dir = fs::canonicalize(packet_dir).map_err(|e| e.to_string())?;
    let report_path = required("--report")?;
    if report_path.exists() {
        return Err("report already exists".into());
    }
    let mut manifests = vec![];
    for entry in fs::read_dir(&root).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if !entry.file_type().map_err(|e| e.to_string())?.is_dir() {
            return Err("capture root must contain only owned invocation directories".into());
        }
        manifests.push(entry.path().join("manifest.json"));
    }
    manifests.sort();
    if manifests.len() != raw_captures.len() {
        return Err("capture manifests differ from the completed invocation receipts".into());
    }
    let time = Instant::now();
    let mut units = vec![];
    let mut seen_paths = BTreeSet::new();
    let mut input_hashes = BTreeSet::new();
    let mut captured_hashes = vec![];
    let mut reasons = BTreeMap::<String, usize>::new();
    let mut eligible_functions = 0;
    let mut eligible_emission_sum_ms = 0.;
    let mut eligibility_sum_ms = 0.;
    let mut corpus_hash = Sha256::new();
    for path in &manifests {
        let capture = read_json(path)?;
        let canonical = fs::canonicalize(path).map_err(|e| e.to_string())?;
        bind_capture(
            &capture,
            raw_captures
                .get(&canonical)
                .ok_or("capture is absent from completed invocation receipts")?,
        )?;
        if text(&capture, "schema")? != "gpu-rust-bitcode-capture"
            || integer(&capture, "version")? != 1
            || text(&capture, "status")? != "success"
            || text(&capture, "quality")? != text(&build, "quality")?
        {
            return Err(format!(
                "capture manifest is incomplete or incompatible: {}",
                path.display()
            ));
        }
        let captured = capture
            .get("units")
            .and_then(Value::as_array)
            .ok_or("missing captured units")?;
        for unit in captured {
            let input = capture_path(path.parent().unwrap(), text(unit, "captured_filename")?)?;
            if !seen_paths.insert(input.clone()) {
                return Err("captured input appears more than once".into());
            }
            let bytes = fs::read(&input).map_err(|e| e.to_string())?;
            let input_sha = text(unit, "input_sha256")?;
            verify_input(&bytes, input_sha, integer(unit, "input_bytes")?)?;
            input_hashes.insert(input_sha.to_string());
            captured_hashes.push(input_sha.to_string());
            corpus_hash.update(input_sha.as_bytes());
            let packet_path = packet_dir.join(format!("module-{}.gem1", units.len()));
            let inspection = Instant::now();
            let export = Command::new(&bridge)
                .arg("--export-leaf")
                .arg(&input)
                .arg(&packet_path)
                .output()
                .map_err(|e| format!("start leaf exporter: {e}"))?;
            let packet = if packet_path.exists() {
                Some(fs::read(&packet_path).map_err(|e| e.to_string())?)
            } else {
                None
            };
            let mut diagnostic = String::from_utf8_lossy(&export.stderr).trim().to_string();
            let mut eligible = export_outcome(
                export.status.code().unwrap_or(-1),
                &diagnostic,
                packet.as_deref(),
            )?;
            let mut functions = 0;
            if eligible {
                let decoded = leaf_packet::decode(packet.as_deref().unwrap())?;
                let emission = machine_codegen::cpu_emit(&decoded.batch, decoded.target)?;
                match machine_codegen::write_object(&decoded.batch, decoded.target, &emission) {
                    Ok(_) => functions = decoded.batch.functions().len(),
                    Err(error) => {
                        eligible = false;
                        diagnostic = format!("GPU object preflight rejected: {error}");
                    }
                }
            }
            let eligibility_ms = inspection.elapsed().as_secs_f64() * 1000.;
            eligibility_sum_ms += eligibility_ms;
            let mut row = json!({
                "input_path":input, "input_sha256":input_sha, "input_bytes":bytes.len(),
                "capture_manifest":path, "source":capture.get("source"),
                "llvm_codegen_opt_level":unit.get("llvm_codegen_opt_level"),
                "target":unit.get("target"), "eligibility_ms":eligibility_ms,
                "cpu_controller_elapsed_ms":unit.get("controller_elapsed_ms"),
                "status":if eligible {"eligible"} else {"rejected"}
            });
            if eligible {
                let packet = packet.unwrap();
                eligible_functions += functions;
                eligible_emission_sum_ms += unit
                    .get("controller_elapsed_ms")
                    .and_then(Value::as_f64)
                    .ok_or("missing captured emission timing")?;
                row["packet_path"] = json!(packet_path);
                row["packet_sha256"] = json!(hash(&packet));
                row["functions"] = json!(functions);
            } else {
                // The full diagnostic stays on the row; aggregate stable exporter
                // reasons independently of mangled function names.
                let reason = diagnostic
                    .strip_prefix("GPU leaf export rejected: ")
                    .unwrap_or(&diagnostic);
                let reason = reason
                    .rsplit_once(": ")
                    .map_or(reason, |(_, tail)| tail)
                    .to_string();
                *reasons.entry(reason).or_default() += 1;
                row["reason"] = json!(diagnostic);
            }
            units.push(row);
        }
    }
    if units.len() as u64 != expected {
        return Err(format!(
            "incomplete corpus: captured {} of {expected} translated units",
            units.len()
        ));
    }
    matched_inputs(&captured_hashes, &expected_inputs)?;
    let eligible = units.iter().filter(|u| u["status"] == "eligible").count();
    let report = json!({
        "schema":"gpu-rust-corpus-census", "version":1,
        "corpus_id":corpus_hash.finalize().iter().map(|b| format!("{b:02x}")).collect::<String>(),
        "source_revision":build.pointer("/source/git_head").and_then(Value::as_str).unwrap_or("unrecorded"),
        "source_worktree_dirty":build.pointer("/source/git_worktree_dirty"),
        "toolchain_id":"rust1.98.1-llvm22.1.8",
        "build_report":build_path, "build_report_sha256":hash(&fs::read(&build_path).map_err(|e| e.to_string())?),
        "bridge":bridge, "bridge_sha256":build.pointer("/backend_toolchain/bridge/sha256"),
        "scope":"Strict whole-module export and object-contract eligibility census of every captured fast-build LLVM unit; no GPU timing or whole-build speedup claim",
        "exhaustive_capture_verified":true, "total_units":units.len(),
        "unique_input_hashes":input_hashes.len(), "eligible_units":eligible,
        "eligible_functions":eligible_functions, "rejected_units":units.len()-eligible,
        "capture_invocations":manifests.len(), "rejection_reasons":reasons,
        "inspection_wall_ms":time.elapsed().as_secs_f64()*1000.,
        "eligibility_sum_ms":eligibility_sum_ms,
        "eligible_cpu_controller_elapsed_sum_ms":eligible_emission_sum_ms,
        "timing_scope":"Controller sums overlap and are not whole-build wall-time shares",
        "build_cargo_elapsed_ms":build.get("cargo_elapsed_ms"),
        "continuation_gate":{"required_whole_fast_build_improvement":0.10,
            "compiler_size_limit":1.5,"program_size_limit":1.5,
            "whole_build_speedup_demonstrated":false,
            "decision":if eligible==0 {"park-current-gpu-route-zero-eligible-work"} else {"replay-required-no-performance-qualification"},
            "zero_cost_gpu_available_work_ms":if eligible==0 {Some(0.)} else {None}},
        "units":units,
    });
    let mut file = fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&report_path)
        .map_err(|e| e.to_string())?;
    file.write_all(&serde_json::to_vec_pretty(&report).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    file.sync_all().map_err(|e| e.to_string())?;
    println!(
        "Inspected {} Rust modules: {eligible} eligible, {} rejected. {}",
        units.len(),
        units.len() - eligible,
        report["continuation_gate"]["decision"]
    );
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("corpus census: {error}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unsupported_leaf_is_rejected_but_broken_compiler_is_an_error() {
        assert!(!export_outcome(
            20,
            "GPU leaf export rejected: globals are unsupported",
            None
        )
        .unwrap());
        assert!(export_outcome(21, "LLVM parse failed", None).is_err());
    }

    #[test]
    fn success_without_a_packet_cannot_establish_eligibility() {
        assert!(export_outcome(0, "", None).is_err());
        assert!(export_outcome(0, "", Some(b"bad packet")).is_err());
        assert!(export_outcome(20, "", None).is_err());
    }

    #[test]
    fn changed_capture_bytes_cannot_qualify() {
        let bytes = b"BC\xc0\xdeactual";
        assert!(verify_input(bytes, &hash(bytes), bytes.len() as u64).is_ok());
        assert!(verify_input(bytes, &hash(b"different"), bytes.len() as u64).is_err());
        assert!(verify_input(bytes, &hash(bytes), 2).is_err());
    }

    #[test]
    fn matching_counts_with_missing_modules_cannot_establish_exhaustiveness() {
        assert!(matched_inputs(&["a".into(), "a".into()], &["a".into(), "b".into()]).is_err());
        assert!(matched_inputs(&["b".into(), "a".into()], &["a".into(), "b".into()]).is_ok());
    }

    #[test]
    fn capture_costs_are_bound_to_the_exact_emitted_unit() {
        let mut receipt = json!({
            "status":"success", "source":"/source.rs", "input_arguments_sha256":"arg",
            "quality":"fast", "requested_backend":"llvm", "rustc_version_verbose":"pinned",
            "units":[{"input_sha256":"input", "target":"x86_64-unknown-linux-gnu",
                "controller_elapsed_ms":2.5, "controller_receipt":{"llvm_codegen_opt_level":1}}]
        });
        let mut capture = receipt.clone();
        capture["llvm_codegen_opt_level"] = json!(1);
        capture["units"] = json!([{
            "unit_index":0,"input_sha256":"input", "target":"x86_64-unknown-linux-gnu",
            "controller_elapsed_ms":2.5,"llvm_codegen_opt_level":1,"emission_receipt":receipt["units"][0]
        }]);
        assert!(bind_capture(&capture, &receipt).is_ok());
        capture["units"][0]["controller_elapsed_ms"] = json!(9.);
        assert!(bind_capture(&capture, &receipt).is_err());
        capture["units"][0]["controller_elapsed_ms"] = json!(2.5);
        receipt["source"] = json!("/another.rs");
        assert!(bind_capture(&capture, &receipt).is_err());
    }

    #[test]
    fn capture_names_cannot_escape_the_invocation_directory() {
        for name in ["../unit.bc", "/unit.bc", "nested/unit.bc", "unit.o"] {
            assert!(capture_path(Path::new("/unused"), name).is_err());
        }
    }
}
