// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Image-owned applications use the same compute compiler as typed inference services.
use super::docker;
use crate::{
    Error,
    compile::{Generations, Target},
    config::{ConfigError, Credential, Document, validation::require},
    managed::{ImageLaunch, Process},
    services::contract::{InstallPlan, Installer, RemovePlan},
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::BTreeMap;
pub mod connection;
pub mod inputs;

pub const SERVICE_KIND: &str = "container_service";
pub const STORAGE_KIND: &str = "container_storage";
/// Data source that waits for an application's Docker HEALTHCHECK.
pub const HEALTH_DATA_SOURCE: &str = "host_container_health";
/// How long apply waits for the HEALTHCHECK to report healthy.
pub const STARTUP_TIMEOUT_SECONDS: u64 = 300;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
/// An ordinary Docker application on the managed Docker gateway's engine and
/// network, not an OpenShell sandbox or inference provider.
pub struct Service {
    /// Immutable application image. The image owns its entrypoint, CMD, and HEALTHCHECK.
    pub image: String,
    /// Numeric non-root UID:GID. Omission selects 65532:65532.
    #[serde(default = "default_user")]
    pub user: String,
    /// Literal non-secret application settings. Credentials must not be supplied here.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub environment: BTreeMap<String, String>,
    /// Optional loopback or private IPv4 TCP publication. Omission publishes no port.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "ContainerPublication")]
    pub publication: Option<ContainerPublication>,
    /// Disposable application data. Destroy removes this volume.
    pub data: ContainerData,
    /// Credential references. NemoClaw writes each value to a private file,
    /// /run/nemoclaw/secrets/<name>, before the application starts; values
    /// never enter its environment, configuration, or state.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub secrets: BTreeMap<String, Credential>,
    /// The sandbox agent the application invokes. NemoClaw writes its
    /// descriptor to /run/nemoclaw/agent-connection.json, and starts the
    /// application after the agent is ready.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_connection: Option<connection::AgentConnection>,
}
fn default_user() -> String {
    "65532:65532".into()
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
/// One application TCP listener on the host.
pub struct ContainerPublication {
    /// Loopback or private host IPv4 address.
    pub bind_address: String,
    /// Same unprivileged TCP port inside the container and on the host.
    pub port: u16,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
/// An owned disposable data volume. The image must supply the writable non-root mount directory.
pub struct ContainerData {
    /// One application directory below /var/lib, owned by the image's non-root user.
    pub mount_path: String,
}

pub(crate) fn constrain_schema(defs: &mut serde_json::Map<String, serde_json::Value>) {
    use crate::config::{constraints as c, schema::validation::property};
    let service = defs["ServiceDefinition"]["oneOf"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|variant| variant["properties"]["kind"]["const"] == "container")
        .unwrap();
    property(service, "image", json!({"pattern":c::IMAGE}));
    property(
        service,
        "user",
        json!({"pattern":c::APPLICATION_USER, "default":"65532:65532"}),
    );
    property(
        service,
        "environment",
        json!({"propertyNames":{"pattern":c::ENV}}),
    );
    property(
        service,
        "secrets",
        json!({"propertyNames":{"pattern":c::SLUG}}),
    );
    property(
        &mut defs["ContainerData"],
        "mountPath",
        json!({"pattern":c::APPLICATION_ROOT}),
    );
    property(
        &mut defs["ContainerPublication"],
        "port",
        json!({"minimum":1024,"maximum":65535}),
    );
}

impl Service {
    pub fn validate(&self) -> Result<(), ConfigError> {
        crate::config::schema::validate_service("container", self)?;
        if let Some(publication) = &self.publication {
            require(
                publication
                    .bind_address
                    .parse::<std::net::Ipv4Addr>()
                    .is_ok_and(|ip| ip.is_loopback() || ip.is_private()),
                "container publication requires a loopback or private IPv4 address",
            )?;
        }
        if let Some(connection) = &self.agent_connection {
            connection.validate()?;
            require(
                connection
                    .authentication
                    .secret_ref
                    .as_ref()
                    .is_none_or(|name| self.secrets.contains_key(name)),
                "agentConnection secretRef names no declared secret",
            )?;
        }
        Ok(())
    }
    fn protected(&self) -> bool {
        !self.secrets.is_empty() || self.agent_connection.is_some()
    }
    /// The managed local Docker gateway whose engine and network the application shares.
    pub(crate) fn gateway(
        document: &Document,
    ) -> Result<&crate::config::ManagedGateway, ConfigError> {
        let gateway = document.spec.gateway.managed()?;
        require(
            gateway.runtime.provider == crate::config::ComputeDriver::Docker
                && gateway.engine.starts_with("unix:///"),
            "container requires a managed local Docker gateway",
        )?;
        Ok(gateway)
    }
}
fn address(kind: &str, name: &str) -> String {
    format!("nemoclaw_{kind}.{name}")
}

impl Installer for Service {
    fn install(
        &self,
        document: &Document,
        name: &str,
        generations: &Generations,
    ) -> Result<InstallPlan, Error> {
        self.validate()?;
        let gateway = Self::gateway(document)?;
        let process = Process {
            engine: gateway.engine.clone(),
            image: self.image.clone(),
            network_cidr: gateway.network_cidr.clone(),
            image_owned: Some(ImageLaunch {
                user: self.user.clone(),
                environment: self.environment.clone(),
                protected_inputs: self.protected(),
            }),
            mount_target: self.data.mount_path.clone(),
            bind_address: self
                .publication
                .as_ref()
                .map_or(String::new(), |p| p.bind_address.clone()),
            port: self.publication.as_ref().map_or(0, |p| p.port),
            shared_memory_bytes: 64 << 20,
            memory_bytes: 1 << 30,
            ..Process::default()
        };
        let spec = docker::specification(
            document,
            generations,
            SERVICE_KIND,
            format!("{}-container-{name}", document.workspace()),
            gateway.runtime_settings(),
            process,
        )?;
        let mut plan = InstallPlan::default();
        if self.protected() {
            let files = format!("{}.{name}", inputs::FILES_KIND);
            let connection = self
                .agent_connection
                .as_ref()
                .map(|connection| -> Result<_, ConfigError> {
                    let file = inputs::ConnectionFile {
                        service: name.into(),
                        endpoint: connection.endpoint(document)?,
                        authentication: connection.authentication.mode,
                        credential: connection.authentication.secret_ref.clone(),
                    };
                    // The graph replaces these with the agent's ref; the
                    // sandbox name selects it.
                    let agent = inputs::AgentTarget {
                        workspace: document.workspace(),
                        sandbox: connection.sandbox_ref.clone(),
                        owner: document.metadata.uid.clone(),
                        name: connection.agent(document)?.into(),
                        ..Default::default()
                    };
                    Ok((file, agent))
                })
                .transpose()?;
            let inputs = inputs::Files {
                engine: spec.engine().into(),
                name: spec.name.clone(),
                owner: spec.owner.clone(),
                generation: spec.generation.clone(),
                image: self.image.clone(),
                user: self.user.clone(),
                credentials: self
                    .secrets
                    .iter()
                    .map(|(key, credential)| (key.clone(), credential.env.clone()))
                    .collect(),
                agent: connection.as_ref().map(|(_, agent)| agent.clone()),
                connection: connection.map(|(file, _)| file),
            };
            inputs.validate(false)?;
            plan.targets.push(Target {
                kind: inputs::FILES_KIND.into(),
                address: files.clone(),
                values: inputs.row(),
            });
            let mut dependencies = vec![files];
            if let Some(connection) = &self.agent_connection {
                dependencies.push(format!(
                    "data.fabric_agent_readiness.{}",
                    connection.sandbox_ref
                ));
            }
            plan.dependencies
                .insert(address(SERVICE_KIND, name), dependencies);
        }
        docker::install(spec, name, STORAGE_KIND, None, Default::default(), plan)
    }
    fn remove(&self, _: &Document, _: &str, _: &Generations) -> Result<RemovePlan, Error> {
        Ok(RemovePlan::default())
    }
}
