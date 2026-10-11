// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use gpu_rust_compiler::{
    codegen_service::*, leaf_packet, machine_codegen, native_codegen::NativeExecutor,
};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, env, fs, io::Write, path::PathBuf, time::Instant};
fn hash(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

// Own only files successfully created by this invocation. Any later error must
// discard both outputs so an object cannot outlive its qualification receipt.
struct Publication {
    files: Vec<PathBuf>,
    committed: bool,
}
impl Publication {
    fn new() -> Self {
        Self {
            files: Vec::new(),
            committed: false,
        }
    }
    fn write(&mut self, path: &PathBuf, bytes: &[u8]) -> Result<(), String> {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)
            .map_err(|e| e.to_string())?;
        self.files.push(path.clone());
        file.write_all(bytes).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())
    }
}
impl Drop for Publication {
    fn drop(&mut self) {
        if !self.committed {
            for path in &self.files {
                let _ = fs::remove_file(path);
            }
        }
    }
}
fn run() -> Result<(), String> {
    let mut options = BTreeMap::new();
    let mut args = env::args().skip(1);
    while let Some(key) = args.next() {
        if key == "--help" {
            println!("gpu-emit-module --input GEM1 --output OBJECT --backend metal|cuda --library FILE [--shader FILE] [--device N] --report JSON\nStrict LLVM leaf-module lowering only; other Rust modules require explicit fallback.");
            return Ok(());
        }
        if ![
            "--input",
            "--output",
            "--backend",
            "--library",
            "--shader",
            "--device",
            "--report",
        ]
        .contains(&key.as_str())
        {
            return Err(format!("unknown option{key}"));
        }
        let value = args
            .next()
            .ok_or_else(|| format!("missing value for{key}"))?;
        if options.insert(key.clone(), value).is_some() {
            return Err(format!("duplicate option{key}"));
        }
    }
    let required = |key: &str| {
        options
            .get(key)
            .cloned()
            .ok_or_else(|| format!("missing{key}"))
    };
    let input = PathBuf::from(required("--input")?);
    let output = PathBuf::from(required("--output")?);
    let report = PathBuf::from(required("--report")?);
    if output.exists() || report.exists() || output == report {
        return Err("output/report must be distinct new files".into());
    }
    let backend = match required("--backend")?.as_str() {
        "metal" => GpuBackend::Metal,
        "cuda" => GpuBackend::Cuda,
        _ => return Err("backend must be metal or cuda".into()),
    };
    let library = PathBuf::from(required("--library")?);
    let shader = options.get("--shader").map(PathBuf::from);
    let device = options
        .get("--device")
        .map_or(Ok(0), |s| s.parse::<u32>().map_err(|_| "invalid device"))?;
    let all = Instant::now();
    let data = fs::read(&input).map_err(|e| e.to_string())?;
    let decoded = leaf_packet::decode(&data)?;
    let batch = decoded.batch;
    let target = decoded.target;
    let init = Instant::now();
    let executor = NativeExecutor::new(backend, target, &library, shader.as_deref(), device)?;
    let stats = executor.stats();
    let session = BuildSession::new(
        SessionConfig {
            cpu_credit_limit: 1,
            ..Default::default()
        },
        vec![Box::new(executor)],
    )
    .map_err(|e| e.to_string())?;
    let client = session
        .register_client("rust-leaf-module", 1)
        .map_err(|e| e.to_string())?;
    let initialization_ms = init.elapsed().as_secs_f64() * 1000.;
    let ticket = session
        .submit(
            &client,
            batch.clone(),
            SubmitOptions {
                placement: Placement::RequireGpu(backend),
                ..Default::default()
            },
        )
        .map_err(|e| e.to_string())?;
    let receipt = ticket.wait().map_err(|e| e.to_string())?;
    if !session.is_current(&receipt) {
        return Err("stale GPU module cannot be published".into());
    }
    // Verification is included in total elapsed time, never hidden as a GPU win.
    let oracle = machine_codegen::cpu_emit(&batch, target)?;
    let mut expected = oracle.functions;
    expected.sort_by_key(|f| f.symbol);
    let mut actual = receipt.output.functions.clone();
    actual.sort_by_key(|f| f.symbol);
    if actual != expected {
        return Err("GPU module differs from CPU encoding oracle".into());
    }
    let bytes = machine_codegen::write_object(&batch, target, &receipt.output)?;
    let file = object::File::parse(bytes.as_slice()).map_err(|e| e.to_string())?;
    use object::Object as _;
    if file.kind() != object::ObjectKind::Relocatable {
        return Err("GPU output is not a relocatable object".into());
    }
    let mut publication = Publication::new();
    publication.write(&output, &bytes)?;
    let native_stats = stats.lock().unwrap().clone();
    let dispatches = native_stats
        .iter()
        .map(|s| s.kernel_dispatches)
        .sum::<u64>();
    let llvm_input_target = decoded.llvm_target;
    let json = serde_json::json!({"schema":"gpu-emit-module","version":1,"backend":match backend{GpuBackend::Metal=>"metal",GpuBackend::Cuda=>"cuda"},"physical_gpu":receipt.execution.is_physical_gpu(),"device_id":receipt.route.device_id,"kernel_dispatches":dispatches,"kernel_output_used":true,"gpu_executed":true,"performance_speedup_demonstrated":false,"scope":"strict whole LLVM leaf module to native object; CPU generates required unwind metadata; unsupported Rust modules must use explicit fallback","input_packet_sha256":hash(&data),"object_bytes":bytes.len(),"object_sha256":hash(&bytes),"function_count":batch.functions().len(),"target":batch.identity().target_abi,"llvm_input_target":llvm_input_target,"total_elapsed_ms":all.elapsed().as_secs_f64()*1000.,"initialization_ms":initialization_ms,"cpu_byte_oracle_verified":true,"unwind_metadata_required":batch.abis().iter().any(|a|a.requires_unwind),"native_library_sha256":hash(&fs::read(&library).map_err(|e|e.to_string())?),"native_stats":native_stats,"timing_scope":"includes packet decode/validation, GPU setup, GPU work/wait, CPU byte oracle, unwind/object serialization and output write; no original LLVM native object emission"});
    let text = serde_json::to_vec_pretty(&json).map_err(|e| e.to_string())?;
    publication.write(&report, &text)?;
    publication.committed = true;
    println!("{}", String::from_utf8_lossy(&text));
    Ok(())
}
fn main() {
    if let Err(error) = run() {
        eprintln!("gpu-emit-module: {error}");
        std::process::exit(1);
    }
}
