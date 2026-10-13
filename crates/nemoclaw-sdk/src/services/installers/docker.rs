// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Shared Docker resource assembly; callers own service settings and lifecycle policy.
use crate::{
    Error,
    backend::Row,
    compile::{Generations, Target},
    config::{ComputeDriver, Document, ImagePullPolicy, ManagedGateway},
    managed::{Process, Spec, Storage},
    services::contract::InstallPlan,
};

pub(super) fn specification(
    document: &Document,
    generations: &Generations,
    kind: &str,
    name: String,
    gateway: ManagedGateway,
    process: Process,
) -> Result<Spec, Error> {
    let generation = generations
        .get(kind)
        .filter(|generation| !generation.is_empty())
        .ok_or(Error::State("missing Docker service generation"))?;
    let spec = Spec {
        layout: 0,
        compute_driver: ComputeDriver::Docker,
        kind: kind.into(),
        name,
        owner: document.metadata.uid.clone(),
        generation: generation.clone(),
        gateway,
        process: Some(process),
    };
    spec.validate()?;
    Ok(spec)
}

pub(super) fn storage(spec: &Spec, name: String) -> Storage {
    Storage {
        name,
        owner: spec.owner.clone(),
        generation: spec.generation.clone(),
        engine: spec.engine().into(),
    }
}

pub(super) fn storage_target(
    spec: &Spec,
    kind: &str,
    address: String,
    name: String,
) -> Result<Target, Error> {
    Ok(Target {
        kind: kind.into(),
        address,
        values: storage(spec, name).row()?,
    })
}

pub(super) fn install(
    spec: Spec,
    name: &str,
    storage_kind: &str,
    policy: Option<ImagePullPolicy>,
    mut values: Row,
    mut preparation: InstallPlan,
) -> Result<InstallPlan, Error> {
    values.insert("spec".into(), spec.json()?);
    if let Some(policy) = policy {
        values.insert("image_pull_policy".into(), policy.as_str().into());
    }
    let address = format!("nemoclaw_{}.{name}", spec.kind);
    let storage_address = format!("nemoclaw_{storage_kind}.{name}");
    let storage = storage_target(&spec, storage_kind, storage_address.clone(), spec.volume())?;
    preparation
        .dependencies
        .entry(address.clone())
        .or_default()
        .insert(0, storage_address);
    let mut targets = vec![
        storage,
        Target {
            kind: spec.kind,
            address,
            values,
        },
    ];
    targets.extend(preparation.targets);
    Ok(InstallPlan {
        targets,
        ..preparation
    })
}
