// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Nonsecret intent for protected application input delivery.
use crate::{
    Error,
    config::{ConfigError, Credential, validation::require},
    managed::Storage,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

pub const INPUTS_KIND: &str = "container_inputs";
use super::connection::{AgentConnection, AuthenticationMode, LocalGateway, matches};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
/// A preloaded, immutable NemoClaw setup image. It runs only to publish protected inputs.
pub struct InputSetup {
    /// Repository SHA-256 manifest digest. Build from image/container-inputs/Dockerfile and preload it in the selected engine; no implicit pull.
    pub image: String,
}
impl InputSetup {
    pub fn validate(&self) -> Result<(), ConfigError> {
        require(
            matches(crate::config::constraints::IMAGE, &self.image),
            "input setup image must be pinned by a SHA-256 digest",
        )
    }
}

pub fn input_revision(
    user: &str,
    root: &str,
    secrets: &BTreeMap<String, ProtectedCredential>,
    connections: &BTreeMap<String, AgentConnection>,
) -> String {
    if secrets.is_empty() && connections.is_empty() {
        return String::new();
    }
    let reference_intent =
        serde_json::to_vec(&(user, root, secrets, connections)).expect("typed input references");
    Sha256::digest(reference_intent)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
/// A caller-supplied token reference delivered as a protected file, never Docker environment.
pub struct ProtectedCredential {
    /// Caller environment reference; no value appears in deployment configuration or state.
    pub credential: Credential,
    /// Canonical file path below this application's data root.
    pub target_path: String,
}

fn safe_path(root: &str, target: &str) -> bool {
    target.len() <= 512
        && target
            .strip_prefix(&format!("{root}/"))
            .is_some_and(nemoclaw_container_inputs::relative_path)
}

pub fn validate_inputs(
    root: &str,
    secrets: &BTreeMap<String, ProtectedCredential>,
    connections: &BTreeMap<String, AgentConnection>,
) -> Result<(), ConfigError> {
    require(
        secrets.len() <= 16 && connections.len() <= 1,
        "container input count exceeds the supported limit",
    )?;
    let mut targets = BTreeSet::new();
    for (name, secret) in secrets {
        require(
            matches(crate::config::constraints::SLUG, name),
            "invalid container credential name",
        )?;
        require(
            matches(crate::config::constraints::ENV, &secret.credential.env)
                && !["TF_", "TOFU_", "PLUGIN_", "NEMOCLAW_INTERNAL_"]
                    .iter()
                    .any(|p| secret.credential.env.starts_with(p))
                && secret.credential.env != "CHECKPOINT_DISABLE",
            "invalid or reserved container credential reference",
        )?;
        require(
            safe_path(root, &secret.target_path) && targets.insert(secret.target_path.as_str()),
            "container input paths must be distinct files below the data root",
        )?;
    }
    for (name, connection) in connections {
        require(
            matches(crate::config::constraints::SLUG, name)
                && matches(crate::config::constraints::SLUG, &connection.sandbox_ref)
                && matches(crate::config::constraints::SLUG, &connection.agent),
            "invalid container agent binding",
        )?;
        require(
            safe_path(root, &connection.target_path)
                && targets.insert(connection.target_path.as_str()),
            "container input paths must be distinct files below the data root",
        )?;
        connection.validate()?;
        require(
            connection
                .authentication
                .secret_ref
                .as_ref()
                .is_none_or(|name| secrets.contains_key(name)),
            "container connection credential reference is undeclared",
        )?;
    }
    for path in &targets {
        require(
            !targets
                .iter()
                .any(|other| other != path && other.starts_with(&format!("{path}/"))),
            "container input file collides with a parent directory",
        )?;
    }
    require(
        !targets
            .iter()
            .any(|path| path.split('/').any(|part| part == ".nemoclaw-inputs")),
        "container input path is reserved",
    )?;
    Ok(())
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
/// Minimal provider intent: input references and owned storage, never launch settings or values.
pub struct InputsSpec {
    pub storage: Storage,
    pub architecture: String,
    pub user: String,
    pub root: String,
    pub revision: String,
    pub setup: InputSetup,
    pub service: String,
    pub workspace: String,
    pub secrets: BTreeMap<String, ProtectedCredential>,
    pub connections: BTreeMap<String, AgentConnection>,
    pub local_gateway: Option<LocalGateway>,
}
impl InputsSpec {
    pub fn validate(&self) -> Result<(), Error> {
        self.storage.validate()?;
        self.setup.validate()?;
        require(
            matches(r"^nc-[a-f0-9]{16}$", &self.workspace)
                && matches(crate::config::constraints::SLUG, &self.service)
                && matches!(self.architecture.as_str(), "arm64" | "amd64")
                && matches(crate::config::constraints::APPLICATION_USER, &self.user)
                && matches(crate::config::constraints::APPLICATION_ROOT, &self.root)
                && self.storage.engine.starts_with("unix:///")
                && (!self.secrets.is_empty() || !self.connections.is_empty()),
            "invalid application input identity",
        )?;
        validate_inputs(&self.root, &self.secrets, &self.connections)?;
        require(
            self.revision
                == input_revision(&self.user, &self.root, &self.secrets, &self.connections)
                && self.storage.name
                    == crate::managed::data_volume(&self.application_name(), &self.revision),
            "application input storage or revision differs from its references",
        )?;
        let local = self
            .connections
            .values()
            .find(|c| c.authentication.mode == AuthenticationMode::None);
        match (local, &self.local_gateway) {
            (Some(connection), Some(gateway)) => {
                gateway.validate(&self.storage.engine, &connection.gateway_endpoint)?
            }
            (None, None) => {}
            _ => return Err(Error::State("invalid application local gateway binding")),
        }
        Ok(())
    }
    pub fn descriptor(&self, sandbox_id: &str) -> Result<Option<(String, Value)>, Error> {
        self.validate()?;
        self.connections
            .values()
            .next()
            .map(|connection| {
                connection.descriptor(
                    &self.storage.owner,
                    &self.workspace,
                    &self.service,
                    sandbox_id,
                    connection
                        .authentication
                        .secret_ref
                        .as_ref()
                        .map(|name| self.secrets[name].target_path.as_str()),
                )
            })
            .transpose()
    }
    pub fn application_name(&self) -> String {
        format!("{}-container-{}", self.workspace, self.service)
    }
    pub fn helper_name(&self) -> String {
        format!("{}-inputs", self.application_name())
    }
    pub fn image_requirements(&self) -> crate::managed::ImageRequirements {
        crate::managed::ImageRequirements {
            engine: self.storage.engine.clone(),
            image: self.setup.image.clone(),
            architecture: self.architecture.clone(),
            contract: crate::managed::ImageContract::Inputs,
        }
    }
}

pub(crate) fn constrain_schema(defs: &mut serde_json::Map<String, Value>) {
    use crate::config::{constraints as c, schema::validation::property};
    property(
        &mut defs["InputSetup"],
        "image",
        json!({"pattern":c::IMAGE}),
    );
    let service = defs["ServiceDefinition"]["oneOf"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|v| v["properties"]["kind"]["const"] == "container")
        .unwrap();
    property(
        service,
        "secrets",
        json!({"maxProperties":16,"propertyNames":{"pattern":c::SLUG}}),
    );
    property(
        service,
        "agentConnections",
        json!({"maxProperties":1,"propertyNames":{"pattern":c::SLUG}}),
    );
    for field in ["sandboxRef", "agent"] {
        property(
            &mut defs["AgentConnection"],
            field,
            json!({"pattern":c::SLUG}),
        );
    }
    property(
        &mut defs["ApplicationAuthentication"],
        "secretRef",
        json!({"pattern":c::SLUG}),
    );
    defs["ApplicationAuthentication"]["allOf"] = json!([{
        "if":{"properties":{"mode":{"const":"oidcBearer"}}},
        "then":{"required":["secretRef"],"properties":{"secretRef":{"type":"string","minLength":1}}},
        "else":{"properties":{"secretRef":{"type":"null"}}}
    }]);
    defs["AgentConnection"]["allOf"] = json!([{
        "if":{"properties":{"authentication":{"properties":{"mode":{"const":"oidcBearer"}}}}},
        "then":{"required":["gatewayEndpoint"],"properties":{"gatewayEndpoint":{"minLength":1},"tls":{"properties":{"trust":{"const":"system"}}}}},
        "else":{"properties":{"tls":{"properties":{"trust":{"const":"none"}}}}}
    }]);
    property(
        &mut defs["ConnectionTimeouts"],
        "healthSeconds",
        json!({"minimum":1,"maximum":12}),
    );
    property(
        &mut defs["ConnectionTimeouts"],
        "invokeSeconds",
        json!({"minimum":1,"maximum":120}),
    );
}
