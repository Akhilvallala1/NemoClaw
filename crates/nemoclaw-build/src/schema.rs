// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use nemoclaw_sdk::config::schema::{SCHEMA_PATH, input_schema};
use std::{fs, path::Path};
mod reference;
pub use reference::render_reference;
pub const REFERENCE_PATH: &str = "docs/reference/configuration.md";

pub fn schema_bytes() -> Vec<u8> {
    let mut bytes = serde_json::to_vec_pretty(&input_schema()).expect("schema serialization");
    bytes.push(b'\n');
    bytes
}

pub fn generate(root: &Path, check: bool) -> Result<(), String> {
    let reference = render_reference(&input_schema())?;
    generated_file(root, SCHEMA_PATH, &schema_bytes(), check)?;
    generated_file(root, REFERENCE_PATH, reference.as_bytes(), check)?;
    if check {
        no_other_schema_version(root)?;
    }
    Ok(())
}

// Each API version has its own schema file. One left from another version
// would let editors check documents against a contract this SDK rejects.
fn no_other_schema_version(root: &Path) -> Result<(), String> {
    let (directory, current) = SCHEMA_PATH.rsplit_once('/').expect("schema directory");
    let entries = fs::read_dir(root.join(directory))
        .map_err(|error| format!("cannot read {directory}: {error}"))?;
    let mut others = entries
        .map(|entry| entry.map(|entry| entry.file_name().to_string_lossy().into_owned()))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("cannot read {directory}: {error}"))?
        .into_iter()
        .filter(|name| {
            name != current && name.starts_with("nemoclaw-") && name.ends_with(".schema.json")
        })
        .map(|name| format!("{directory}/{name}"))
        .collect::<Vec<_>>();
    others.sort_unstable();
    if others.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "{} must be removed; {SCHEMA_PATH} is the only configuration schema",
            others.join(", ")
        ))
    }
}

pub fn add_to_bundle(
    root: &Path,
    manifest: &mut nemoclaw_sdk::bundle::Manifest,
) -> Result<(), String> {
    generated_file(root, SCHEMA_PATH, &schema_bytes(), false)?;
    let hash = nemoclaw_sdk::bundle::hash_file(&root.join(SCHEMA_PATH))
        .map_err(|error| error.to_string())?;
    manifest.files.insert(SCHEMA_PATH.into(), hash);
    Ok(())
}

fn generated_file(root: &Path, relative: &str, bytes: &[u8], check: bool) -> Result<(), String> {
    let path = root.join(relative);
    if check {
        if fs::read(&path).is_ok_and(|existing| existing == bytes) {
            Ok(())
        } else {
            Err(format!(
                "{relative} is missing or stale; run cargo run --locked -p nemoclaw-build -- schema"
            ))
        }
    } else {
        fs::create_dir_all(path.parent().ok_or("invalid generated path")?)
            .map_err(|error| format!("cannot create {relative}: {error}"))?;
        fs::write(path, bytes).map_err(|error| format!("cannot write {relative}: {error}"))
    }
}
