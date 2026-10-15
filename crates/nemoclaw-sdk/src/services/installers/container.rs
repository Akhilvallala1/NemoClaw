// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Image-owned applications use the same compute compiler as typed inference services.
use super::docker;
use crate::{
    Error,
    compile::{Generations, Target},
    config::{ConfigError, Document, ImagePullPolicy, validation::require},
    managed::{ImageLaunch, Process, Spec},
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

/// Check the application policy on a compiled launch before installation or state reuse.
pub(crate) fn validate_spec(spec: &Spec) -> Result<(), Error> {
    spec.validate()?;
    let process = spec
        .process
        .as_ref()
        .filter(|p| p.image_owned.is_some())
        .ok_or(Error::Conflict("application requires image-owned startup"))?;
    let matches = |pattern: &str, value: &str| regex::Regex::new(pattern).unwrap().is_match(value);
    let image = process.image_owned.as_ref().unwrap();
    let valid = process.engine.starts_with("unix:///")
        && matches(crate::config::constraints::APPLICATION_USER, &image.user)
        && matches(crate::config::constraints::IMAGE, &process.image)
        && !process.image.contains(['\0', '\r', '\n'])
        && matches!(process.architecture.as_str(), "arm64" | "amd64")
        && process
            .network_cidr
            .parse::<ipnet::Ipv4Net>()
            .is_ok_and(|net| {
                net.addr().is_private() && net.prefix_len() == 24 && net.addr() == net.network()
            })
        && !process.gpu
        && !process.host_ipc
        && process.memory_bytes == 1 << 30
        && process.shared_memory_bytes == 64 << 20
        && matches(
            crate::config::constraints::APPLICATION_ROOT,
            &process.mount_target,
        )
        && (process.port == 0 && process.bind_address.is_empty()
            || process.port >= 1024
                && process
                    .bind_address
                    .parse::<std::net::Ipv4Addr>()
                    .is_ok_and(|ip| ip.is_private() || ip.is_loopback()));
    if !valid {
        return Err(Error::Conflict("invalid application process"));
    }
    Ok(())
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
/// An ordinary Docker application, not an OpenShell sandbox or inference provider.
pub struct Service {
    /// Immutable application image. The image owns its entrypoint, CMD, and HEALTHCHECK.
    pub image: String,
    /// Omission selects IfNotPresent. Never requires an image in the selected engine.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "ImagePullPolicy")]
    pub image_pull_policy: Option<ImagePullPolicy>,
    /// Linux image architecture: arm64 or amd64. This does not select a host architecture.
    pub architecture: String,
    /// Numeric non-root UID:GID. Omission selects 65532:65532.
    #[serde(default = "default_user")]
    pub user: String,
    /// Literal non-secret application settings. Credentials must not be supplied here.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub environment: BTreeMap<String, String>,
    /// Explicit preloaded immutable setup image; required when protected inputs are declared. No caller-supplied setup commands are accepted.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_setup: Option<inputs::InputSetup>,
    /// Protected token references. Setup publishes root-confined files before dependent application startup.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub secrets: BTreeMap<String, inputs::ProtectedCredential>,
    /// Explicit connection projection and selected-agent readiness ordering.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub agent_connections: BTreeMap<String, connection::AgentConnection>,
    /// Local Docker placement. Omission inherits the managed Docker gateway's engine and network.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "ContainerPlacement")]
    pub placement: Option<ContainerPlacement>,
    /// Optional loopback or private IPv4 TCP publication. Omission publishes no port.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "ContainerPublication")]
    pub publication: Option<ContainerPublication>,
    /// Disposable application data. Destroy removes this volume; external data is not mounted.
    pub data: ContainerData,
    /// Apply-time observation of the image-owned Docker HEALTHCHECK; no mutation or task invocation.
    #[serde(default)]
    pub readiness: ContainerReadiness,
    /// Declared services that must be ready before this container starts. This injects no settings.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub depends_on: Vec<String>,
}
fn default_user() -> String {
    "65532:65532".into()
}
fn startup_timeout() -> u64 {
    300
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
/// Local Docker engine and application network. Remote engines are not qualified here.
pub struct ContainerPlacement {
    /// Local Unix Docker socket endpoint. TCP and SSH endpoints are rejected.
    pub engine: String,
    /// Canonical private IPv4 /24. Services sharing an engine must use the same network.
    #[serde(rename = "networkCIDR")]
    pub network_cidr: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
/// One application TCP listener, independent of inference URL conventions.
pub struct ContainerPublication {
    /// Loopback or private host IPv4 address; public and wildcard addresses are rejected by SDK validation.
    pub bind_address: String,
    /// Same unprivileged TCP port inside the container and on the selected host.
    pub port: u16,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
/// An owned disposable data volume. The image must supply the writable non-root mount directory.
pub struct ContainerData {
    /// One canonical application directory below /var/lib, owned by the image's non-root user.
    pub mount_path: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
/// Apply observes Docker health only while this bounded startup wait is active.
pub struct ContainerReadiness {
    /// Bounded startup wait, 1–3600 seconds. Omission selects 300 seconds.
    #[serde(default = "startup_timeout")]
    pub startup_timeout_seconds: u64,
}
impl Default for ContainerReadiness {
    fn default() -> Self {
        Self {
            startup_timeout_seconds: startup_timeout(),
        }
    }
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
    property(service, "architecture", json!({"enum":["arm64","amd64"]}));
    property(
        service,
        "user",
        json!({"pattern":c::APPLICATION_USER, "default":"65532:65532"}),
    );
    property(
        service,
        "environment",
        json!({"maxProperties":128,"propertyNames":{"pattern":c::ENV},"additionalProperties":{"type":"string","maxLength":65536,"pattern":"^[^\\u0000]*$(?![\\s\\S])"}}),
    );
    property(
        service,
        "dependsOn",
        json!({"maxItems":128,"uniqueItems":true,"items":{"type":"string","pattern":c::SLUG}}),
    );
    property(
        &mut defs["ContainerData"],
        "mountPath",
        json!({"pattern":c::APPLICATION_ROOT}),
    );
    property(
        &mut defs["ContainerReadiness"],
        "startupTimeoutSeconds",
        json!({"minimum":1,"maximum":3600,"default":300}),
    );
    property(
        &mut defs["ContainerPublication"],
        "port",
        json!({"minimum":1024,"maximum":65535}),
    );
    property(
        &mut defs["ContainerPublication"],
        "bindAddress",
        json!({"format":"ipv4"}),
    );
    property(
        &mut defs["ContainerPlacement"],
        "engine",
        json!({"pattern":"^unix:///"}),
    );
}

impl Service {
    pub(crate) fn preflight(&self, secrets: &dyn crate::Secrets) -> Result<(), Error> {
        for secret in self.secrets.values() {
            let value = secrets.resolve(&secret.credential.env)?;
            if !nemoclaw_container_inputs::credential(&value) {
                return Err(crate::ObservationError::Authentication.into());
            }
        }
        Ok(())
    }
    pub fn validate(&self) -> Result<(), ConfigError> {
        crate::config::schema::validate_service("container", self)?;
        require(
            self.input_setup.is_some()
                == (!self.secrets.is_empty() || !self.agent_connections.is_empty()),
            "inputSetup is required exactly when protected inputs are declared",
        )?;
        if let Some(setup) = &self.input_setup {
            setup.validate()?;
        }
        inputs::validate_inputs(
            &self.data.mount_path,
            &self.secrets,
            &self.agent_connections,
        )?;
        require(
            self.environment.values().map(String::len).sum::<usize>() <= 128 << 10,
            "container environment exceeds its size limit",
        )?;
        if let Some(publication) = &self.publication {
            let ip: std::net::Ipv4Addr = publication
                .bind_address
                .parse()
                .map_err(|_| ConfigError::new("invalid container publication address"))?;
            require(
                ip.is_loopback() || ip.is_private(),
                "container publication requires a loopback or private IPv4 address",
            )?;
        }
        if let Some(placement) = &self.placement {
            require(
                placement.engine.starts_with("unix:///")
                    && crate::config::validate_engine_endpoint(&placement.engine).is_ok(),
                "container placement requires a local Docker socket",
            )?;
            let net: ipnet::Ipv4Net = placement
                .network_cidr
                .parse()
                .map_err(|_| ConfigError::new("invalid container network"))?;
            require(
                net.addr().is_private() && net.prefix_len() == 24 && net.addr() == net.network(),
                "container network requires a canonical private IPv4 /24",
            )?;
        }
        Ok(())
    }
    pub(crate) fn location(&self, document: &Document) -> Result<(String, String), ConfigError> {
        if let Some(placement) = &self.placement {
            return Ok((placement.engine.clone(), placement.network_cidr.clone()));
        }
        require(
            document.spec.gateway.runtime().provider == crate::config::ComputeDriver::Docker,
            "container requires a managed Docker gateway or explicit local Docker placement",
        )?;
        let gateway = document.spec.gateway.managed()?;
        require(
            gateway.engine.starts_with("unix:///"),
            "container requires a local Docker engine",
        )?;
        Ok((gateway.engine.clone(), gateway.network_cidr.clone()))
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
        let (engine, network_cidr) = self.location(document)?;
        let shared_gateway = document.spec.gateway.as_managed().filter(|gateway| {
            gateway.engine == engine
                && gateway.network_cidr == network_cidr
                && gateway.runtime.provider == crate::config::ComputeDriver::Docker
        });
        let mut connections = self.agent_connections.clone();
        for connection in connections.values_mut() {
            connection.validate_binding(document, &engine, &network_cidr)?;
            connection.gateway_endpoint = connection.resolved_endpoint(document)?;
        }
        let process = Process {
            engine,
            image: self.image.clone(),
            network_cidr,
            create_network: shared_gateway.is_none(),
            architecture: self.architecture.clone(),
            image_owned: Some(ImageLaunch {
                user: self.user.clone(),
                environment: self.environment.clone(),
                input_revision: inputs::input_revision(
                    &self.user,
                    &self.data.mount_path,
                    &self.secrets,
                    &connections,
                ),
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
            shared_gateway.map_or_else(Default::default, |gateway| gateway.runtime_settings()),
            process,
        )?;
        validate_spec(&spec)?;
        let values = crate::backend::Row::from([(
            "wait_timeout_seconds".into(),
            self.readiness.startup_timeout_seconds.to_string(),
        )]);
        let mut dependencies = Vec::new();
        for dependency in &self.depends_on {
            match &document.spec.services[dependency] {
                super::super::ServiceDefinition::Container(_) => dependencies.push(format!(
                    "data.{HEALTH_DATA_SOURCE}.{SERVICE_KIND}_{dependency}"
                )),
                super::super::ServiceDefinition::OllamaProxy(_) => dependencies.push(format!(
                    "data.{}.{}_{dependency}",
                    crate::services::provider_types::readiness_type(super::ollama::proxy::PROXY)
                        .expect("the proxy has readiness"),
                    super::ollama::proxy::PROXY
                )),
                // Runtime-stage inference is ready before the deployment graph executes.
                super::super::ServiceDefinition::Ollama(_)
                | super::super::ServiceDefinition::Vllm(_) => {}
            }
        }
        let mut targets = Vec::new();
        let mut edges = BTreeMap::new();
        let mut image_checks = BTreeMap::new();
        let mut replacement_triggers = BTreeMap::new();
        for connection in self.agent_connections.values() {
            dependencies.push(format!(
                "data.fabric_agent_readiness.{}",
                connection.sandbox_ref
            ));
        }
        if !self.secrets.is_empty() || !self.agent_connections.is_empty() {
            let files_address = format!(
                "{}.{name}",
                crate::compile::resource_type(inputs::FILES_KIND)
            );
            let connection = connections.values().next();
            let files = inputs::Files {
                engine: spec.engine().into(),
                volume: spec.volume(),
                owner: spec.owner.clone(),
                generation: spec.generation.clone(),
                application: spec.name.clone(),
                image: self
                    .input_setup
                    .as_ref()
                    .ok_or(Error::State("missing protected input setup image"))?
                    .image
                    .clone(),
                architecture: self.architecture.clone(),
                user: self.user.clone(),
                root: self.data.mount_path.clone(),
                credentials: self
                    .secrets
                    .iter()
                    .map(|(key, secret)| {
                        (
                            key.clone(),
                            inputs::CredentialFile {
                                env: secret.credential.env.clone(),
                                path: secret.target_path.clone(),
                            },
                        )
                    })
                    .collect(),
                connection: connection.map(|connection| inputs::ConnectionFile {
                    path: connection.target_path.clone(),
                    service: name.into(),
                    endpoint: connection.gateway_endpoint.clone(),
                    trust: connection.tls.trust,
                    authentication: connection.authentication.mode,
                    credential: connection.authentication.secret_ref.clone(),
                    health_seconds: connection.timeouts.health_seconds,
                    invoke_seconds: connection.timeouts.invoke_seconds,
                }),
                // The graph replaces these with the agent's ref; the sandbox
                // name selects it.
                agent: connection.map(|connection| inputs::AgentTarget {
                    workspace: document.workspace(),
                    sandbox: connection.sandbox_ref.clone(),
                    owner: document.metadata.uid.clone(),
                    name: connection.agent.clone(),
                    ..Default::default()
                }),
            };
            files.validate(false)?;
            image_checks.insert(
                format!("protected_files_{name}"),
                files.image_requirements(),
            );
            replacement_triggers.insert(address(SERVICE_KIND, name), vec![files_address.clone()]);
            targets.push(Target {
                kind: inputs::FILES_KIND.into(),
                address: files_address.clone(),
                values: files.row(),
            });
            edges.insert(files_address.clone(), vec![address(STORAGE_KIND, name)]);
            dependencies.push(files_address);
        }
        edges.insert(address(SERVICE_KIND, name), dependencies);
        docker::install(
            spec,
            name,
            STORAGE_KIND,
            self.image_pull_policy,
            values,
            InstallPlan {
                targets,
                dependencies: edges,
                image_checks,
                replacement_triggers,
            },
        )
    }
    fn remove(&self, _: &Document, _: &str, _: &Generations) -> Result<RemovePlan, Error> {
        Ok(RemovePlan::default())
    }
}
