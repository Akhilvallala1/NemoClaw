// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Inputs of the `protected_files` resource, which publishes an application's
//! credential files and agent connection descriptor before it starts.
use super::connection::{AuthenticationMode, validate_profile};
use crate::{
    Error,
    backend::Row,
    config::{ConfigError, validation::require},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

/// The resource kind, which is also its OpenTofu type.
pub const FILES_KIND: &str = "protected_files";
/// Where the application mounts the files, read-only.
pub const ROOT: &str = "/run/nemoclaw";
/// The connection descriptor, relative to [`ROOT`].
pub const DESCRIPTOR: &str = "agent-connection.json";
/// Written last; its presence means every file was published.
pub const MARKER: &str = ".complete";

/// A credential's file, relative to [`ROOT`].
pub fn credential_file(name: &str) -> String {
    format!("secrets/{name}")
}

/// The nonsecret settings of the connection descriptor.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ConnectionFile {
    /// Application service name written to the descriptor.
    pub service: String,
    /// Gateway origin the application reaches.
    pub endpoint: String,
    /// `oidcBearer` or `none`.
    pub authentication: AuthenticationMode,
    /// The `credentials` entry holding the bearer token; required for oidcBearer.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub credential: Option<String>,
}

/// The selected agent, from its `fabric_agent` ref.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentTarget {
    pub workspace: String,
    pub sandbox: String,
    pub sandbox_id: String,
    pub owner: String,
    pub name: String,
}

/// `(ref attribute, row field)` pairs of the agent ref.
pub const AGENT_FIELDS: [(&str, &str); 5] = [
    ("workspace", "agent_workspace"),
    ("sandbox", "agent_sandbox"),
    ("sandbox_id", "agent_sandbox_id"),
    ("owner", "agent_owner"),
    ("name", "agent_name"),
];
/// Plain string inputs.
pub const SCALAR_FIELDS: [&str; 6] = ["engine", "name", "owner", "generation", "image", "user"];
const CREDENTIALS: (&str, &str) = ("credentials", "credentials_json");
// OpenTofu reserves `connection` for provisioners.
const CONNECTION: (&str, &str) = ("agent_connection", "agent_connection_json");

/// Every row field, in schema order.
pub fn fields() -> Vec<&'static str> {
    SCALAR_FIELDS
        .into_iter()
        .chain([CREDENTIALS.1, CONNECTION.1])
        .chain(AGENT_FIELDS.map(|(_, field)| field))
        .collect()
}
/// Inputs that may be omitted.
pub fn optional_fields() -> Vec<&'static str> {
    [CREDENTIALS.1, CONNECTION.1]
        .into_iter()
        .chain(AGENT_FIELDS.map(|(_, field)| field))
        .collect()
}

/// The typed `credentials` map and `agent_connection` block.
pub fn structured_inputs() -> Vec<nemoclaw_tofu::Structured> {
    #[derive(schemars::JsonSchema)]
    #[allow(dead_code)]
    struct Blocks {
        credentials: BTreeMap<String, String>,
        agent_connection: Option<ConnectionFile>,
    }
    let schema = serde_json::to_value(schemars::schema_for!(Blocks)).expect("schema serializes");
    let fields =
        nemoclaw_tofu::shape::fields(&schema, &[]).expect("protected file inputs map to OpenTofu");
    [CREDENTIALS, CONNECTION]
        .map(|(attribute, field)| nemoclaw_tofu::Structured {
            attribute,
            field,
            shape: fields[attribute].shape.clone(),
        })
        .into()
}

/// The `agent` input, which takes the selected `fabric_agent`'s ref.
pub fn references() -> Vec<nemoclaw_tofu::Reference> {
    vec![nemoclaw_tofu::Reference {
        attribute: "agent",
        kind: nemoclaw_fabric::agent::RESOURCE_TYPE,
        fields: AGENT_FIELDS.to_vec(),
        list: false,
    }]
}

/// Inputs of one `protected_files` resource. It names credentials by
/// environment variable and never holds their values.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Files {
    pub engine: String,
    /// The application container's name; the resource owns `<name>-inputs`.
    pub name: String,
    pub owner: String,
    pub generation: String,
    /// The application image, used for a setup container that never starts.
    pub image: String,
    /// Numeric non-root UID:GID that owns the files.
    pub user: String,
    /// Credential names and the provider environment variables holding them.
    pub credentials: BTreeMap<String, String>,
    pub connection: Option<ConnectionFile>,
    pub agent: Option<AgentTarget>,
}

impl Files {
    /// The inputs a row carries.
    ///
    /// # Errors
    /// Returns an error when a structured field is malformed.
    pub fn from_row(row: &Row) -> Result<Self, Error> {
        let text = |field: &str| row.get(field).cloned().unwrap_or_default();
        let json = |field: &str| -> Result<Option<Value>, Error> {
            match row.get(field).map(String::as_str) {
                None | Some("") => Ok(None),
                Some(encoded) => serde_json::from_str(encoded)
                    .map(Some)
                    .map_err(|_| Error::State("invalid protected file inputs")),
            }
        };
        fn decode<T: serde::de::DeserializeOwned>(
            value: Option<Value>,
        ) -> Result<Option<T>, Error> {
            value
                .map(serde_json::from_value)
                .transpose()
                .map_err(|_| Error::State("invalid protected file inputs"))
        }
        Ok(Self {
            engine: text("engine"),
            name: text("name"),
            owner: text("owner"),
            generation: text("generation"),
            image: text("image"),
            user: text("user"),
            credentials: decode(json(CREDENTIALS.1)?)?.unwrap_or_default(),
            connection: decode(json(CONNECTION.1)?)?,
            agent: AGENT_FIELDS
                .iter()
                .any(|(_, field)| !text(field).is_empty())
                .then(|| AgentTarget {
                    workspace: text("agent_workspace"),
                    sandbox: text("agent_sandbox"),
                    sandbox_id: text("agent_sandbox_id"),
                    owner: text("agent_owner"),
                    name: text("agent_name"),
                }),
        })
    }

    /// The row that carries these inputs.
    pub fn row(&self) -> Row {
        let mut row: Row = [
            ("engine", &self.engine),
            ("name", &self.name),
            ("owner", &self.owner),
            ("generation", &self.generation),
            ("image", &self.image),
            ("user", &self.user),
        ]
        .map(|(field, value)| (field.to_owned(), value.clone()))
        .into();
        if !self.credentials.is_empty() {
            row.insert(
                CREDENTIALS.1.into(),
                serde_json::to_string(&self.credentials).expect("credential references"),
            );
        }
        if let Some(connection) = &self.connection {
            row.insert(
                CONNECTION.1.into(),
                serde_json::to_string(connection).expect("connection settings"),
            );
        }
        if let Some(agent) = &self.agent {
            let values = [
                &agent.workspace,
                &agent.sandbox,
                &agent.sandbox_id,
                &agent.owner,
                &agent.name,
            ];
            for ((_, field), value) in AGENT_FIELDS.into_iter().zip(values) {
                row.insert(field.into(), value.clone());
            }
        }
        row
    }

    /// Check the inputs offline. `resolved` also requires the agent's sandbox
    /// identity, known only once the sandbox exists.
    ///
    /// # Errors
    /// Returns the violated requirement, never a value.
    pub fn validate(&self, resolved: bool) -> Result<(), ConfigError> {
        let slug = |value: &str| {
            regex::Regex::new(crate::config::constraints::SLUG)
                .unwrap()
                .is_match(value)
        };
        require(
            self.engine.starts_with("unix:///")
                && !self.name.is_empty()
                && !self.owner.is_empty()
                && !self.generation.is_empty()
                && !self.image.is_empty()
                && regex::Regex::new(crate::config::constraints::APPLICATION_USER)
                    .unwrap()
                    .is_match(&self.user)
                && self.credentials.keys().all(|name| slug(name)),
            "invalid protected file engine, ownership, image, user, or credential name",
        )?;
        match (&self.connection, &self.agent) {
            (None, None) => require(
                !self.credentials.is_empty(),
                "protected files require a credential or a connection",
            ),
            (Some(connection), Some(agent)) => {
                validate_profile(
                    connection.authentication,
                    connection.credential.is_some(),
                    Some(&connection.endpoint),
                )?;
                require(
                    connection
                        .credential
                        .as_ref()
                        .is_none_or(|name| self.credentials.contains_key(name))
                        && agent.owner == self.owner
                        && (!resolved
                            || regex::Regex::new(crate::config::constraints::UUID)
                                .unwrap()
                                .is_match(&agent.sandbox_id)),
                    "the connection must name a declared credential and this deployment's resolved agent",
                )
            }
            _ => Err(ConfigError::new(
                "a connection and its agent must be declared together",
            )),
        }
    }

    /// The setup container and the volume it writes.
    pub fn helper_name(&self) -> String {
        format!("{}-inputs", self.name)
    }

    /// Digest of the nonsecret inputs that determine the published files.
    pub fn revision(&self) -> String {
        let published = (
            &self.owner,
            &self.user,
            &self.credentials,
            &self.connection,
            &self.agent,
        );
        Sha256::digest(serde_json::to_vec(&published).expect("nonsecret inputs"))
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect()
    }

    /// The connection descriptor, once the agent's sandbox is resolved.
    ///
    /// # Errors
    /// Returns an error when the inputs are invalid or the sandbox is unresolved.
    pub fn descriptor(&self) -> Result<Option<Value>, Error> {
        self.validate(true)?;
        let (Some(connection), Some(agent)) = (&self.connection, &self.agent) else {
            return Ok(None);
        };
        let bearer = connection.authentication == AuthenticationMode::OidcBearer;
        Ok(Some(json!({
            "schemaVersion":"nemoclaw.agent-connection.v1", "deploymentUid":self.owner, "service":connection.service,
            "gateway":{"endpoint":connection.endpoint,"tls":{"trust":if bearer {"system"} else {"none"},"caFile":null}},
            "authentication":{"mode":connection.authentication,
                "credentialFile":connection.credential.as_ref().map(|name| format!("{ROOT}/{}", credential_file(name))),
                "refreshMode":"none"},
            "target":{"workspace":agent.workspace,"sandbox":agent.sandbox,"sandboxId":agent.sandbox_id,"agent":agent.name},
            "bridge":{"interfaceVersion":1,"command":"fabric-agent"},
            "timeouts":{"healthSeconds":12,"invokeSeconds":120}
        })))
    }
}
