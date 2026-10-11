// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use gpu_rust_compiler::{
    codegen_service::*,
    leaf_packet,
    machine_codegen::{self, MachineTarget},
    native_codegen::NativeExecutor,
};
use object::Object as _;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    env, fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::Arc,
    time::Instant,
};

#[derive(Deserialize)]
struct Manifest {
    schema: String,
    version: u32,
    corpus_id: String,
    source_revision: String,
    toolchain_id: String,
    total_units: usize,
    eligible_units: usize,
    rejected_units: usize,
    rejection_reasons: BTreeMap<String, usize>,
    exhaustive_capture_verified: bool,
    #[serde(default)]
    inspection_wall_ms: f64,
    units: Vec<Unit>,
}
#[derive(Deserialize)]
struct Unit {
    input_path: PathBuf,
    input_sha256: String,
    status: String,
    packet_path: Option<PathBuf>,
    packet_sha256: Option<String>,
    target: Option<String>,
    eligibility_ms: f64,
    reason: Option<String>,
}
struct CapturedModule {
    input_sha256: String,
    packet_sha256: String,
    packet: Vec<u8>,
    target: MachineTarget,
    target_abi: String,
    functions: usize,
    instructions: usize,
}
struct Corpus {
    manifest: Manifest,
    modules: Vec<CapturedModule>,
    duplicate_eligible_units: usize,
    eligibility_sum_ms: f64,
}
fn hash(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}
fn file_hash(path: &Path) -> Result<String, String> {
    if !path.is_absolute() {
        return Err("census input and packet paths must be absolute".into());
    }
    let mut file = fs::File::open(path).map_err(|e| format!("read {}: {e}", path.display()))?;
    let mut digest = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let count = file.read(&mut buffer).map_err(|e| e.to_string())?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    Ok(digest
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect())
}
fn load(path: &Path) -> Result<Corpus, String> {
    let manifest: Manifest = serde_json::from_slice(&fs::read(path).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    if manifest.schema != "gpu-rust-corpus-census"
        || manifest.version != 1
        || !manifest.exhaustive_capture_verified
        || manifest.toolchain_id != "rust1.98.1-llvm22.1.8"
        || manifest.source_revision.is_empty()
        || manifest.corpus_id.is_empty()
        || manifest.total_units != manifest.units.len()
        || manifest.eligible_units.checked_add(manifest.rejected_units)
            != Some(manifest.total_units)
        || manifest.rejection_reasons.values().sum::<usize>() != manifest.rejected_units
        || !manifest.inspection_wall_ms.is_finite()
        || manifest.inspection_wall_ms < 0.
    {
        return Err("unverified, inconsistent or incompatible corpus census".into());
    }
    let mut paths = BTreeSet::new();
    let mut hashes = BTreeMap::<String, (String, Option<String>)>::new();
    let mut modules = Vec::new();
    let mut eligible = 0;
    let mut rejected = 0;
    let mut duplicate_eligible_units = 0;
    let mut eligibility_sum_ms = 0.;
    let mut packet_bytes = 0usize;
    for unit in &manifest.units {
        if !unit.eligibility_ms.is_finite() || unit.eligibility_ms < 0. {
            return Err("invalid eligibility timing".into());
        }
        eligibility_sum_ms += unit.eligibility_ms;
        if !paths.insert(fs::canonicalize(&unit.input_path).map_err(|e| e.to_string())?) {
            return Err("captured input path appears more than once".into());
        }
        if file_hash(&unit.input_path)? != unit.input_sha256 {
            return Err("captured input SHA256 differs from census".into());
        }
        let duplicate = if let Some(previous) = hashes.get(&unit.input_sha256) {
            if previous != &(unit.status.clone(), unit.packet_sha256.clone()) {
                return Err("duplicate input hash has conflicting eligibility or packet".into());
            }
            true
        } else {
            hashes.insert(
                unit.input_sha256.clone(),
                (unit.status.clone(), unit.packet_sha256.clone()),
            );
            false
        };
        match unit.status.as_str() {
            "eligible" => {
                eligible += 1;
                let path = unit
                    .packet_path
                    .as_ref()
                    .ok_or("eligible module lacks packet path")?;
                let expected = unit
                    .packet_sha256
                    .as_ref()
                    .ok_or("eligible module lacks packet hash")?;
                if file_hash(path)? != *expected {
                    return Err("eligible packet SHA256 differs from census".into());
                }
                if duplicate {
                    duplicate_eligible_units += 1;
                    continue;
                }
                let length = fs::metadata(path).map_err(|e| e.to_string())?.len();
                if length > 128 * 1024 * 1024 {
                    return Err("eligible packet exceeds 128 MiB".into());
                }
                packet_bytes = packet_bytes
                    .checked_add(length as usize)
                    .ok_or("packet size overflow")?;
                if packet_bytes > 128 * 1024 * 1024 {
                    return Err("unique replay corpus exceeds 128 MiB packet memory limit".into());
                }
                let packet = fs::read(path).map_err(|e| e.to_string())?;
                // Recheck the owned snapshot, rather than trusting a prior file read.
                if hash(&packet) != *expected {
                    return Err("eligible packet changed during snapshot".into());
                }
                let decoded = leaf_packet::decode(&packet)?;
                if let Some(target) = &unit.target {
                    if target != &decoded.llvm_target
                        && target != &decoded.batch.identity().target_abi
                    {
                        return Err("packet target differs from captured module target".into());
                    }
                }
                let target_abi = decoded.batch.identity().target_abi.clone();
                if modules
                    .first()
                    .is_some_and(|m: &CapturedModule| m.target_abi != target_abi)
                {
                    return Err("one replay corpus must use one target ABI".into());
                }
                modules.push(CapturedModule {
                    input_sha256: unit.input_sha256.clone(),
                    packet_sha256: expected.clone(),
                    packet,
                    target: decoded.target,
                    target_abi,
                    functions: decoded.batch.functions().len(),
                    instructions: decoded.batch.instructions().len(),
                });
            }
            "rejected" => {
                rejected += 1;
                if unit.reason.as_deref().is_none_or(|s| s.is_empty())
                    || unit.packet_path.is_some()
                    || unit.packet_sha256.is_some()
                {
                    return Err(
                        "rejected module lacks reason or improperly carries an eligible packet"
                            .into(),
                    );
                }
            }
            _ => return Err("unknown census eligibility status".into()),
        }
    }
    if eligible != manifest.eligible_units || rejected != manifest.rejected_units {
        return Err("census eligibility totals differ from unit rows".into());
    }
    Ok(Corpus {
        manifest,
        modules,
        duplicate_eligible_units,
        eligibility_sum_ms,
    })
}

struct Side {
    session: BuildSession,
    client: Client,
    placement: Placement,
    initialization_ms: f64,
}
fn make_side(
    executors: Vec<Box<dyn BatchExecutor>>,
    credits: usize,
    placement: Placement,
    initialization: Instant,
) -> Result<Side, String> {
    let session = BuildSession::new(
        SessionConfig {
            cpu_credit_limit: credits,
            ..Default::default()
        },
        executors,
    )
    .map_err(|e| e.to_string())?;
    let client = session
        .register_client("captured-module-replay", credits)
        .map_err(|e| e.to_string())?;
    Ok(Side {
        session,
        client,
        placement,
        initialization_ms: initialization.elapsed().as_secs_f64() * 1000.,
    })
}
fn run_round(
    side: &Side,
    corpus: &Corpus,
    round: usize,
    expected_objects: &mut BTreeMap<String, String>,
) -> Result<Value, String> {
    let started = Instant::now();
    let mut pending = VecDeque::<(usize, Arc<FlatBatch>, Ticket)>::new();
    let mut completed = Vec::new();
    let mut decode_pack_ms = 0.;
    for (index, module) in corpus.modules.iter().enumerate() {
        let preparation = Instant::now();
        let decoded = leaf_packet::decode_with_key(
            &module.packet,
            BatchKey {
                logical_id: module.input_sha256.clone(),
                generation: round as u64 + 1,
            },
        )?;
        decode_pack_ms += preparation.elapsed().as_secs_f64() * 1000.;
        loop {
            match side.session.submit(
                &side.client,
                decoded.batch.clone(),
                SubmitOptions {
                    placement: side.placement.clone(),
                    estimated_work: module.instructions as u64,
                    ..Default::default()
                },
            ) {
                Ok(ticket) => {
                    pending.push_back((index, decoded.batch.clone(), ticket));
                    break;
                }
                Err(ServiceError::Backpressure) => {
                    let (index, batch, ticket) = pending.pop_front().ok_or(
                        "batch exceeds service memory budget; no pending work can release credits",
                    )?;
                    completed.push((index, batch, ticket.wait().map_err(|e| e.to_string())?));
                }
                Err(error) => return Err(error.to_string()),
            }
        }
    }
    for (index, batch, ticket) in pending {
        completed.push((index, batch, ticket.wait().map_err(|e| e.to_string())?));
    }
    let emission_wall_ms = started.elapsed().as_secs_f64() * 1000.;
    completed.sort_by_key(|(index, _, _)| *index);
    let mut oracle_ms = 0.;
    let mut object_serialization_ms = 0.;
    let mut units = Vec::new();
    for (index, batch, receipt) in completed {
        if !side.session.is_current(&receipt) {
            return Err("stale replay output cannot be measured or published".into());
        }
        let module = &corpus.modules[index];
        let oracle_start = Instant::now();
        let mut expected = machine_codegen::cpu_emit(&batch, module.target)?.functions;
        expected.sort_by_key(|f| f.symbol);
        let mut actual = receipt.output.functions.clone();
        actual.sort_by_key(|f| f.symbol);
        if actual != expected {
            return Err("captured module output differs from independent CPU byte oracle".into());
        }
        oracle_ms += oracle_start.elapsed().as_secs_f64() * 1000.;
        let object_start = Instant::now();
        let bytes = machine_codegen::write_object(&batch, module.target, &receipt.output)?;
        if object::File::parse(bytes.as_slice())
            .map_err(|e| e.to_string())?
            .kind()
            != object::ObjectKind::Relocatable
        {
            return Err("replay emitted a nonrelocatable object".into());
        }
        let object_sha = hash(&bytes);
        if let Some(previous) = expected_objects.get(&module.input_sha256) {
            if previous != &object_sha {
                return Err("CPU/GPU or repeated corpus output is unstable".into());
            }
        } else {
            expected_objects.insert(module.input_sha256.clone(), object_sha.clone());
        }
        object_serialization_ms += object_start.elapsed().as_secs_f64() * 1000.;
        let (physical_gpu, kernel_dispatches, kernel_output_used) = match &receipt.execution {
            ExecutionRecord::Cpu => (false, 0, false),
            ExecutionRecord::PhysicalGpu {
                kernel_dispatches,
                kernel_output_used,
                ..
            } => (true, *kernel_dispatches, *kernel_output_used),
            ExecutionRecord::Simulated { .. } => {
                return Err("simulation cannot enter captured-corpus hardware comparison".into())
            }
        };
        if matches!(side.placement, Placement::RequireGpu(_))
            && (!physical_gpu || kernel_dispatches == 0 || !kernel_output_used)
        {
            return Err("required GPU replay lacks physical kernel-output evidence".into());
        }
        let costs = &receipt.costs;
        units.push(json!({"input_sha256":module.input_sha256,"packet_sha256":module.packet_sha256,"functions":module.functions,"instructions":module.instructions,"packet_bytes":module.packet.len(),"object_bytes":bytes.len(),"object_sha256":object_sha,"device_id":receipt.route.device_id,"physical_gpu":physical_gpu,"kernel_dispatches":kernel_dispatches,"kernel_output_used":kernel_output_used,"worker_stages_ms":{"validation":costs.validation.as_secs_f64()*1000.,"queue":costs.queue.as_secs_f64()*1000.,"prepare":costs.prepare.as_secs_f64()*1000.,"submit":costs.submit.as_secs_f64()*1000.,"wait":costs.wait.as_secs_f64()*1000.,"output_validation":costs.assemble.as_secs_f64()*1000.}}));
    }
    let wall = started.elapsed().as_secs_f64() * 1000.;
    Ok(
        json!({"round":round,"unique_modules":corpus.modules.len(),"decode_validate_pack_sum_ms":decode_pack_ms,"emission_wall_ms":emission_wall_ms,"cpu_byte_oracle_ms":oracle_ms,"object_serialization_validation_hash_ms":object_serialization_ms,"total_wall_ms":wall,"units":units,"timing_scope":"total wall includes packet decode/validation/pack, concurrent service execution, wait, independent CPU byte oracle, unwind/object serialization, object validation and hashes; worker sums overlap and are not wall time"}),
    )
}
fn publish(path: &Path, report: &Value) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(report).map_err(|e| e.to_string())?;
    let mut file = fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(path)
        .map_err(|e| e.to_string())?;
    if let Err(error) = file.write_all(&bytes).and_then(|_| file.sync_all()) {
        drop(file);
        let _ = fs::remove_file(path);
        return Err(error.to_string());
    }
    Ok(())
}
fn median(values: &mut [f64]) -> f64 {
    values.sort_by(f64::total_cmp);
    let middle = values.len() / 2;
    if values.len().is_multiple_of(2) {
        (values[middle - 1] + values[middle]) / 2.
    } else {
        values[middle]
    }
}
fn run() -> Result<(), String> {
    let all = Instant::now();
    let mut options = BTreeMap::new();
    let mut arguments = env::args().skip(1);
    while let Some(key) = arguments.next() {
        if key == "--help" {
            println!("gpu-corpus-replay --manifest CENSUS --report JSON --backend metal|cuda --library FILE [--shader FILE] [--devices 0,1] [--cpu-workers N] [--repeats N]\nReplay strict eligible whole Rust modules with retained CPU/GPU services; zero eligible modules stop before GPU initialization. Each unique module runs once per side per round; repetitions are not additional distinct work.");
            return Ok(());
        }
        if ![
            "--manifest",
            "--report",
            "--backend",
            "--library",
            "--shader",
            "--devices",
            "--cpu-workers",
            "--repeats",
        ]
        .contains(&key.as_str())
        {
            return Err(format!("unknown option {key}"));
        }
        let value = arguments
            .next()
            .ok_or_else(|| format!("missing value for {key}"))?;
        if options.insert(key.clone(), value).is_some() {
            return Err(format!("duplicate option {key}"));
        }
    }
    let required = |key: &str| {
        options
            .get(key)
            .cloned()
            .ok_or_else(|| format!("missing {key}"))
    };
    let manifest_path = PathBuf::from(required("--manifest")?);
    let report_path = PathBuf::from(required("--report")?);
    if report_path.exists() {
        return Err("replay report must be a new file".into());
    }
    let preparation = Instant::now();
    let corpus = load(&manifest_path)?;
    let census_validation_ms = preparation.elapsed().as_secs_f64() * 1000.;
    let mut report = json!({"schema":"gpu-rust-corpus-replay","version":1,"corpus_id":corpus.manifest.corpus_id,"source_revision":corpus.manifest.source_revision,"toolchain_id":corpus.manifest.toolchain_id,"manifest_sha256":hash(&fs::read(&manifest_path).map_err(|e|e.to_string())?),"total_units":corpus.manifest.total_units,"eligible_units":corpus.manifest.eligible_units,"rejected_units":corpus.manifest.rejected_units,"rejection_reasons":corpus.manifest.rejection_reasons,"exhaustive_capture_verified":corpus.manifest.exhaustive_capture_verified,"unique_replayed_units":corpus.modules.len(),"duplicate_eligible_units":corpus.duplicate_eligible_units,"census_validation_input_hash_snapshot_ms":census_validation_ms,"prior_census_inspection_wall_ms":corpus.manifest.inspection_wall_ms,"prior_census_eligibility_sum_ms":corpus.eligibility_sum_ms,"gpu_executed":false,"performance_speedup_demonstrated":false,"whole_build_speedup_demonstrated":false,"multi_gpu_scaling_demonstrated":false,"native_execution_verified":false,"scope":"captured whole Rust LLVM module code emission for strict eligible modules; excludes frontend, unsupported modules, CPU fallback, linker and generated-program runtime"});
    if corpus.modules.is_empty() {
        report["decision"] = "stop-zero-eligible-modules".into();
        report["total_elapsed_ms"] = json!(all.elapsed().as_secs_f64() * 1000.);
        publish(&report_path, &report)?;
        println!("{}", report_path.display());
        return Ok(());
    }
    let workers = options.get("--cpu-workers").map_or(Ok(4usize), |s| {
        s.parse::<usize>().map_err(|_| "invalid CPU worker count")
    })?;
    let repeats = options.get("--repeats").map_or(Ok(5usize), |s| {
        s.parse::<usize>().map_err(|_| "invalid repeat count")
    })?;
    let devices = options.get("--devices").map_or(Ok(vec![0]), |s| {
        s.split(',')
            .map(|s| s.parse::<u32>().map_err(|_| "invalid device index"))
            .collect::<Result<Vec<_>, _>>()
    })?;
    if !(1..=64).contains(&workers)
        || !(1..=64).contains(&repeats)
        || devices.is_empty()
        || devices.len() > 64
        || devices.iter().collect::<BTreeSet<_>>().len() != devices.len()
    {
        return Err("worker/repeat/device counts out of bounds or duplicate devices".into());
    }
    let backend_name = required("--backend")?;
    let backend = match backend_name.as_str() {
        "metal" => GpuBackend::Metal,
        "cuda" => GpuBackend::Cuda,
        _ => return Err("backend must be metal or cuda".into()),
    };
    let library = PathBuf::from(required("--library")?);
    let shader = options.get("--shader").map(PathBuf::from);
    let target = corpus.modules[0].target;
    let cpu_started = Instant::now();
    let cpu_executors = (0..workers)
        .map(|index| {
            Box::new(CpuCallbackExecutor::new(
                format!("cpu-{index}"),
                move |batch| machine_codegen::cpu_emit(batch, target),
            )) as Box<dyn BatchExecutor>
        })
        .collect();
    let cpu = make_side(cpu_executors, workers, Placement::Cpu, cpu_started)?;
    let gpu_started = Instant::now();
    let mut gpu_executors: Vec<Box<dyn BatchExecutor>> = Vec::new();
    let mut native_stats = Vec::new();
    for device in &devices {
        let executor = NativeExecutor::new(backend, target, &library, shader.as_deref(), *device)?;
        native_stats.push(executor.stats());
        gpu_executors.push(Box::new(executor));
    }
    let gpu = make_side(
        gpu_executors,
        devices.len(),
        Placement::RequireGpu(backend),
        gpu_started,
    )?;
    let mut expected_objects = BTreeMap::new();
    let mut rounds = Vec::new();
    let mut cpu_times = Vec::new();
    let mut gpu_times = Vec::new();
    for round in 0..repeats {
        let (cpu_result, gpu_result) = if round.is_multiple_of(2) {
            (
                run_round(&cpu, &corpus, round, &mut expected_objects)?,
                run_round(&gpu, &corpus, round, &mut expected_objects)?,
            )
        } else {
            let gpu_result = run_round(&gpu, &corpus, round, &mut expected_objects)?;
            (
                run_round(&cpu, &corpus, round, &mut expected_objects)?,
                gpu_result,
            )
        };
        cpu_times.push(cpu_result["total_wall_ms"].as_f64().unwrap());
        gpu_times.push(gpu_result["total_wall_ms"].as_f64().unwrap());
        rounds.push(json!({"round":round,"execution_order":if round%2==0 {"cpu-then-gpu"}else{"gpu-then-cpu"},"cpu":cpu_result,"gpu":gpu_result}));
    }
    let cpu_median = median(&mut cpu_times);
    let gpu_median = median(&mut gpu_times);
    let native_stats = native_stats
        .iter()
        .map(|s| s.lock().unwrap().clone())
        .collect::<Vec<_>>();
    report["decision"] = "measured-eligible-corpus-only-no-whole-build-qualification".into();
    report["gpu_executed"] = true.into();
    report["backend"] = backend_name.into();
    report["cpu_workers"] = workers.into();
    report["requested_devices"] = json!(devices);
    report["physical_device_ids"] = json!(gpu
        .session
        .capabilities()
        .iter()
        .map(|c| c.device_id.clone())
        .collect::<Vec<_>>());
    report["persistent_sessions"] = true.into();
    report["scoped_cpu_credits"] = json!({"cpu_service":workers,"gpu_service":devices.len(),"cargo_jobserver_integration":false});
    report["repeats"] = repeats.into();
    report["distinct_work_amplification"] = false.into();
    report["cpu_service_initialization_ms"] = json!(cpu.initialization_ms);
    report["gpu_service_initialization_ms"] = json!(gpu.initialization_ms);
    report["native_stats_per_device"] = json!(native_stats);
    report["all_cpu_byte_checks_passed"] = true.into();
    report["all_objects_stable"] = true.into();
    report["rounds"] = json!(rounds);
    report["cpu_median_total_wall_ms"] = json!(cpu_median);
    report["gpu_median_total_wall_ms"] = json!(gpu_median);
    report["eligible_corpus_total_wall_cpu_over_gpu_ratio"] = json!(cpu_median / gpu_median);
    report["amortized_prior_eligibility_export_sum_ms_per_round"] =
        json!(corpus.eligibility_sum_ms / repeats as f64);
    report["cpu_median_plus_amortized_startup_ms"] =
        json!(cpu_median + cpu.initialization_ms / repeats as f64);
    report["gpu_median_plus_amortized_startup_and_census_wall_ms"] = json!(
        gpu_median
            + (gpu.initialization_ms + census_validation_ms + corpus.manifest.inspection_wall_ms)
                / repeats as f64
    );
    report["native_library_sha256"] = json!(file_hash(
        &fs::canonicalize(&library).map_err(|e| e.to_string())?
    )?);
    report["shader_sha256"] = json!(shader
        .as_ref()
        .map(|s| fs::canonicalize(s)
            .map_err(|e| e.to_string())
            .and_then(|s| file_hash(&s)))
        .transpose()?);
    report["binary_sha256"] = json!(file_hash(&env::current_exe().map_err(|e| e.to_string())?)?);
    report["total_elapsed_ms"] = json!(all.elapsed().as_secs_f64() * 1000.);
    report["timing_scope"] = "Complete corpus rounds alternate CPU/GPU order and retain both services; each unique captured module executes once per side per round. Round walls include decode/pack, service execution, oracle and object serialization. Census validation, prior exporter timing and retained-session startup are separate; worker-stage and exporter sums are not summed as wall time. No warmup or failed units excluded; no native object files are retained.".into();
    report["cpu_baseline_scope"] = "matched leaf machine-code emission algorithm using parallel CPU callbacks; not native LLVM/TPDE or a strongest full-Rust CPU baseline; CPU startup-adjusted wall excludes GPU-only eligibility/export/census cost".into();
    publish(&report_path, &report)?;
    println!("{}", report_path.display());
    Ok(())
}
fn main() {
    if let Err(error) = run() {
        eprintln!("gpu-corpus-replay: {error}");
        std::process::exit(1);
    }
}
