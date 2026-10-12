// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! vLLM installer launch behavior; model and hardware qualification belongs to recipes.
use super::docker;
mod config;
mod container;
mod hardware_profile;
mod service_hardware;
use crate::Error;
pub use crate::services::placement::{ServicePlacement, ServicePublication};
pub use config::{Memory, Model, Service, ServiceAuthentication, Serving};
pub use container::{ServiceContainer, ServiceIpc};
pub use hardware_profile::HardwareProfile;
#[cfg(test)]
use nemoclaw_runtime::vllm::arguments;
pub use service_hardware::{DedicatedHardware, ServiceHardware, VllmLaunchMode};
pub(crate) mod schema;
#[cfg(test)]
mod tests;

use crate::{
    compile::Generations,
    config::{ConfigError, Document},
    managed::{Process, Spec},
    services::contract::{InstallPlan, Installer, RemovePlan},
};
use std::collections::BTreeMap;

pub const SERVICE_KIND: &str = "inference_service";
pub const STORAGE_KIND: &str = "inference_storage";
/// Data source that computes the vLLM runtime contract.
pub const RUNTIME_DATA_SOURCE: &str = "vllm_runtime";

/// OpenTofu attributes for the vLLM runtime contract.
pub fn runtime_fields() -> Result<crate::hcl_schema::Fields, crate::hcl_schema::Unmappable> {
    let schema = serde_json::to_value(schemars::schema_for!(nemoclaw_runtime::vllm::Service))
        .expect("the vLLM runtime schema serializes");
    crate::hcl_schema::fields(&schema, &[])
}

pub fn configured_service(spec: &Spec) -> Result<nemoclaw_runtime::vllm::Service, Error> {
    let configuration = spec.runtime_configuration()?;
    match nemoclaw_runtime::RuntimeSpec::decode(configuration)? {
        nemoclaw_runtime::RuntimeSpec::Vllm(service) => Ok(*service),
        _ => Err(Error::Conflict("runtime configuration is not vLLM")),
    }
}

impl Service {
    pub fn validate(&self) -> Result<(), ConfigError> {
        crate::config::schema::validate_service("vllm", self)?;
        if let Some(placement) = self.published_placement()? {
            placement.validate(self.serving.port)?;
        }
        self.runtime.validate()
    }
}

fn address(kind: &str, name: &str) -> String {
    format!("nemoclaw_{kind}.inference_{name}")
}

fn specification(
    document: &Document,
    name: &str,
    service: &Service,
    generations: &Generations,
) -> Result<Spec, Error> {
    let runtime_service = service.runtime_settings();
    let mut image_labels = service
        .recipe
        .as_ref()
        .map(|recipe| recipe.compatibility.image_labels.clone())
        .unwrap_or_default();
    image_labels.insert("org.nemoclaw.backend".into(), "vllm".into());
    image_labels.insert(
        nemoclaw_runtime::SPEC_VERSION_LABEL.into(),
        nemoclaw_runtime::SPEC_VERSION.into(),
    );
    if service.authentication.is_some() {
        image_labels.insert(
            "org.nemoclaw.inference.authentication".into(),
            "bearer-v1".into(),
        );
    }
    let placed = crate::services::placement::ResolvedPlacement::resolve(
        service.published_placement()?,
        &document.spec.gateway,
        service.serving.port,
    )?;
    let architecture = service.architecture()?.to_owned();
    let process = Process {
        engine: placed.engine.clone(),
        image: service.image.clone(),
        network_cidr: placed.network_cidr.clone(),
        create_network: placed.explicit,
        architecture,
        image_labels,
        pull_image: false,
        image_pull_policy: None,
        configuration: serde_json::to_string(&nemoclaw_runtime::RuntimeSpec::Vllm(Box::new(
            runtime_service,
        )))
        .map_err(|_| Error::State("cannot serialize service runtime configuration"))?,
        entrypoint: vec!["/usr/local/bin/nemoclaw-runtime".into()],
        command: Vec::new(),
        user: String::new(),
        environment: BTreeMap::new(),
        input_revision: String::new(),
        mount_target: "/data".into(),
        bind_address: placed.bind_address,
        port: service.serving.port as u16,
        shared_memory_bytes: service
            .container
            .as_ref()
            .map_or(8, |container| container.shared_memory_gi_b)
            * nemoclaw_runtime::hardware::GIB,
        host_ipc: service
            .container
            .as_ref()
            .is_some_and(|container| container.ipc == ServiceIpc::Host),
        memory_bytes: 104 * nemoclaw_runtime::hardware::GIB,
        gpu: true,
    };
    docker::specification(
        document,
        generations,
        SERVICE_KIND,
        format!("{}-inference-{name}", document.workspace()),
        if placed.explicit {
            Default::default()
        } else {
            document.spec.gateway.managed()?.runtime_settings()
        },
        process,
    )
}

impl Installer for Service {
    fn install(
        &self,
        document: &Document,
        name: &str,
        generations: &Generations,
    ) -> Result<InstallPlan, Error> {
        let spec = specification(document, name, self, generations)?;
        let mut preparation = InstallPlan {
            targets: Vec::new(),
            dependencies: BTreeMap::new(),
        };
        if self.authentication.is_some() {
            let credentials = address(STORAGE_KIND, &format!("{name}_auth"));
            preparation.targets.push(docker::storage_target(
                &spec,
                STORAGE_KIND,
                credentials.clone(),
                format!("{}-auth", spec.name),
            )?);
            preparation
                .dependencies
                .insert(address(SERVICE_KIND, name), vec![credentials]);
        }
        if document.spec.gateway.as_managed().is_some() && self.placement.is_none() {
            preparation
                .dependencies
                .entry(address(SERVICE_KIND, name))
                .or_default()
                .push("nemoclaw_managed_gateway.runtime".into());
        }
        docker::install(
            spec,
            &format!("inference_{name}"),
            STORAGE_KIND,
            self.image_pull_policy,
            Default::default(),
            preparation,
        )
    }

    fn remove(
        &self,
        _document: &Document,
        name: &str,
        _generations: &Generations,
    ) -> Result<RemovePlan, Error> {
        let mut plan = RemovePlan {
            retained: vec![crate::docker_compute::address(&address(STORAGE_KIND, name))],
            required_storage: Vec::new(),
        };
        if self.authentication.is_some() {
            let storage = address(STORAGE_KIND, &format!("{name}_auth"));
            plan.retained.insert(0, storage.clone());
            plan.required_storage
                .push((address(SERVICE_KIND, name), storage));
        }
        Ok(plan)
    }
}

impl Service {
    pub(crate) fn credential_source(
        &self,
        document: &Document,
        name: &str,
        generations: &Generations,
    ) -> Result<Option<String>, Error> {
        if self.authentication.is_none() {
            return Ok(None);
        }
        let spec = specification(document, name, self, generations)?;
        Ok(Some(crate::services::authentication::source_json(
            &crate::services::authentication::Source::ManagedService {
                storage: docker::storage(&spec, format!("{}-auth", spec.name)),
                container: spec.name.clone(),
                endpoint: {
                    let process = spec
                        .process
                        .as_ref()
                        .ok_or(Error::State("missing service process"))?;
                    format!("http://{}:{}/v1", process.bind_address, process.port)
                },
            },
        )?))
    }
}

impl Service {
    /// Explicit placement and publication, or inheritance from the managed gateway.
    pub fn published_placement(
        &self,
    ) -> Result<
        Option<crate::services::placement::PublishedPlacement<'_>>,
        crate::config::ConfigError,
    > {
        crate::services::placement::PublishedPlacement::from_parts(
            self.placement.as_ref(),
            self.publication.as_ref(),
        )
    }
}
