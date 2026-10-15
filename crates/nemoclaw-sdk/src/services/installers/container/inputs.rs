// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Protected application files: their declarations, and the typed inputs of
//! the `protected_files` resource that publishes them.
use crate::{
    Error,
    backend::Row,
    config::{ConfigError, Credential, validation::require},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

use super::connection::{
    AgentConnection, AuthenticationMode, ConnectionTimeouts, TlsTrust, matches, validate_profile,
};

/// The resource kind, which is also its OpenTofu type.
pub const FILES_KIND: &str = "protected_files";
/// The provider that serves [`FILES_KIND`].
pub const PROVIDER: &str = "protected";

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

/// Digest of the declared input references. A change selects fresh disposable
/// storage, so no file from earlier references survives in the new volume.
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
    hex(Sha256::digest(reference_intent))
}

fn hex(bytes: impl AsRef<[u8]>) -> String {
    bytes.as_ref().iter().map(|b| format!("{b:02x}")).collect()
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

fn valid_credential_env(env: &str) -> bool {
    matches(crate::config::constraints::ENV, env)
        && !["TF_", "TOFU_", "PLUGIN_", "NEMOCLAW_INTERNAL_"]
            .iter()
            .any(|prefix| env.starts_with(prefix))
        && env != "CHECKPOINT_DISABLE"
}

/// Distinct files below `root`, none of them a parent of another, and none in
/// the reserved completion marker's place.
fn validate_paths<'a>(
    root: &str,
    paths: impl IntoIterator<Item = &'a str>,
) -> Result<(), ConfigError> {
    let mut targets = BTreeSet::new();
    for path in paths {
        require(
            safe_path(root, path) && targets.insert(path),
            "container input paths must be distinct files below the data root",
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
        !targets.iter().any(|path| {
            path.split('/')
                .any(|part| part == nemoclaw_container_inputs::MARKER)
        }),
        "container input path is reserved",
    )
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
    for (name, secret) in secrets {
        require(
            matches(crate::config::constraints::SLUG, name),
            "invalid container credential name",
        )?;
        require(
            valid_credential_env(&secret.credential.env),
            "invalid or reserved container credential reference",
        )?;
    }
    for (name, connection) in connections {
        require(
            matches(crate::config::constraints::SLUG, name)
                && matches(crate::config::constraints::SLUG, &connection.sandbox_ref)
                && matches(crate::config::constraints::SLUG, &connection.agent),
            "invalid container agent binding",
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
    validate_paths(
        root,
        secrets
            .values()
            .map(|secret| secret.target_path.as_str())
            .chain(connections.values().map(|c| c.target_path.as_str())),
    )
}

/// One protected credential file: the caller variable that holds its value,
/// and its path in the application.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CredentialFile {
    /// The provider's environment variable that holds the credential. Its value never enters state.
    pub env: String,
    /// Absolute file path below `root`.
    pub path: String,
}

/// The nonsecret settings of the application's agent connection descriptor.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ConnectionFile {
    /// Absolute descriptor path below `root`.
    pub path: String,
    /// Application service name written to the descriptor.
    pub service: String,
    /// OpenShell gateway origin the application reaches: HTTPS for oidcBearer, or a private IPv4 HTTP origin for none.
    pub endpoint: String,
    /// `system` for HTTPS, or `none` for development-only HTTP.
    pub trust: TlsTrust,
    /// `oidcBearer` or `none`.
    pub authentication: AuthenticationMode,
    /// The `credentials` entry holding the bearer token; required for oidcBearer.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub credential: Option<String>,
    /// Non-generative agent check deadline, 1–12 seconds.
    pub health_seconds: u64,
    /// Agent invocation deadline, 1–120 seconds.
    pub invoke_seconds: u64,
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

/// Row fields of the agent `ref`, as `(ref attribute, row field)`.
pub const AGENT_FIELDS: [(&str, &str); 5] = [
    ("workspace", "agent_workspace"),
    ("sandbox", "agent_sandbox"),
    ("sandbox_id", "agent_sandbox_id"),
    ("owner", "agent_owner"),
    ("name", "agent_name"),
];
/// Plain string inputs of the resource.
pub const SCALAR_FIELDS: [&str; 9] = [
    "engine",
    "volume",
    "owner",
    "generation",
    "application",
    "image",
    "architecture",
    "user",
    "root",
];
const CREDENTIALS: (&str, &str) = ("credentials", "credentials_json");
// OpenTofu reserves `connection` for provisioners.
const CONNECTION: (&str, &str) = ("agent_connection", "agent_connection_json");

/// Every row field of the resource, in schema order.
pub fn fields() -> Vec<&'static str> {
    SCALAR_FIELDS
        .into_iter()
        .chain([CREDENTIALS.1, CONNECTION.1])
        .chain(AGENT_FIELDS.map(|(_, field)| field))
        .collect()
}
/// Inputs that may be omitted: everything about the agent connection.
pub fn optional_fields() -> Vec<&'static str> {
    [CREDENTIALS.1, CONNECTION.1]
        .into_iter()
        .chain(AGENT_FIELDS.map(|(_, field)| field))
        .collect()
}

/// The typed `credentials` and `agent_connection` inputs, shaped by their JSON schema.
pub fn structured_inputs() -> Vec<nemoclaw_tofu::Structured> {
    #[derive(schemars::JsonSchema)]
    #[allow(dead_code)]
    struct Blocks {
        credentials: BTreeMap<String, CredentialFile>,
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

/// Inputs of one `protected_files` resource. It holds credential references,
/// never their values.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Files {
    pub engine: String,
    /// The owned volume that receives the files.
    pub volume: String,
    pub owner: String,
    pub generation: String,
    /// The owned application container, which must be stopped while files change.
    pub application: String,
    /// The pinned setup image that publishes the files.
    pub image: String,
    pub architecture: String,
    /// Numeric non-root UID:GID that owns the files.
    pub user: String,
    /// The application's mount path for `volume`.
    pub root: String,
    pub credentials: BTreeMap<String, CredentialFile>,
    pub connection: Option<ConnectionFile>,
    pub agent: Option<AgentTarget>,
}

impl Files {
    /// The inputs a row carries.
    ///
    /// # Errors
    /// Returns an error when a field is missing or malformed.
    pub fn from_row(row: &Row) -> Result<Self, Error> {
        let invalid = || Error::State("invalid protected file inputs");
        let text = |field: &str| row.get(field).cloned().unwrap_or_default();
        let json = |field: &str| -> Result<Option<Value>, Error> {
            match row.get(field).map(String::as_str) {
                None | Some("") => Ok(None),
                Some(encoded) => serde_json::from_str(encoded)
                    .map(Some)
                    .map_err(|_| invalid()),
            }
        };
        let credentials = json(CREDENTIALS.1)?
            .map(serde_json::from_value)
            .transpose()
            .map_err(|_| invalid())?
            .unwrap_or_default();
        let connection = json(CONNECTION.1)?
            .map(serde_json::from_value)
            .transpose()
            .map_err(|_| invalid())?;
        let agent = AGENT_FIELDS
            .iter()
            .any(|(_, field)| !text(field).is_empty())
            .then(|| AgentTarget {
                workspace: text("agent_workspace"),
                sandbox: text("agent_sandbox"),
                sandbox_id: text("agent_sandbox_id"),
                owner: text("agent_owner"),
                name: text("agent_name"),
            });
        Ok(Self {
            engine: text("engine"),
            volume: text("volume"),
            owner: text("owner"),
            generation: text("generation"),
            application: text("application"),
            image: text("image"),
            architecture: text("architecture"),
            user: text("user"),
            root: text("root"),
            credentials,
            connection,
            agent,
        })
    }

    /// The row that carries these inputs.
    pub fn row(&self) -> Row {
        let mut row: Row = [
            ("engine", &self.engine),
            ("volume", &self.volume),
            ("owner", &self.owner),
            ("generation", &self.generation),
            ("application", &self.application),
            ("image", &self.image),
            ("architecture", &self.architecture),
            ("user", &self.user),
            ("root", &self.root),
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
            for (value, (_, field)) in [
                &agent.workspace,
                &agent.sandbox,
                &agent.sandbox_id,
                &agent.owner,
                &agent.name,
            ]
            .into_iter()
            .zip(AGENT_FIELDS)
            {
                row.insert(field.into(), value.clone());
            }
        }
        row
    }

    /// Check the inputs without contacting an engine or reading credentials.
    /// `resolved` also requires the agent's physical sandbox identity, which
    /// is known only once its sandbox exists.
    ///
    /// # Errors
    /// Returns an error naming the violated requirement, never a value.
    pub fn validate(&self, resolved: bool) -> Result<(), ConfigError> {
        let storage = crate::managed::Storage {
            name: self.volume.clone(),
            owner: self.owner.clone(),
            generation: self.generation.clone(),
            engine: self.engine.clone(),
        };
        require(
            storage.validate().is_ok()
                && self.engine.starts_with("unix:///")
                && matches(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,200}$", &self.application)
                && matches(crate::config::constraints::IMAGE, &self.image)
                && matches!(self.architecture.as_str(), "arm64" | "amd64")
                && matches(crate::config::constraints::APPLICATION_USER, &self.user)
                && matches(crate::config::constraints::APPLICATION_ROOT, &self.root),
            "invalid protected file owner, volume, application, image, or user",
        )?;
        require(
            (!self.credentials.is_empty() || self.connection.is_some())
                && self.credentials.len() <= 16,
            "protected files require 1 to 16 credentials or a connection",
        )?;
        for (name, credential) in &self.credentials {
            require(
                matches(crate::config::constraints::SLUG, name)
                    && valid_credential_env(&credential.env),
                "invalid or reserved protected credential reference",
            )?;
        }
        if let Some(connection) = &self.connection {
            require(
                matches(crate::config::constraints::SLUG, &connection.service),
                "invalid connection service name",
            )?;
            validate_profile(
                connection.authentication,
                connection.credential.is_some(),
                connection.trust,
                Some(&connection.endpoint),
                &ConnectionTimeouts {
                    health_seconds: connection.health_seconds,
                    invoke_seconds: connection.invoke_seconds,
                },
            )?;
            require(
                connection
                    .credential
                    .as_ref()
                    .is_none_or(|name| self.credentials.contains_key(name)),
                "connection credential names no declared credential",
            )?;
        }
        match (&self.connection, &self.agent) {
            (Some(_), Some(agent)) => require(
                matches(crate::config::constraints::SLUG, &agent.sandbox)
                    && matches(crate::config::constraints::SLUG, &agent.name)
                    && matches(r"^[a-z0-9][a-z0-9-]{0,62}$", &agent.workspace)
                    && agent.owner == self.owner
                    && (!resolved || matches(crate::config::constraints::UUID, &agent.sandbox_id)),
                "connection agent must be this deployment's resolved fabric_agent",
            )?,
            (None, None) => {}
            _ => {
                return Err(ConfigError::new(
                    "a connection and its agent must be declared together",
                ));
            }
        }
        validate_paths(
            &self.root,
            self.credentials
                .values()
                .map(|credential| credential.path.as_str())
                .chain(self.connection.iter().map(|c| c.path.as_str())),
        )
    }

    /// Digest of the nonsecret inputs that determine the published files,
    /// which the completion marker records. The setup image, engine, and
    /// volume are excluded: replacing the helper republishes the same files.
    pub fn revision(&self) -> String {
        let published = (
            &self.owner,
            &self.user,
            &self.root,
            &self.credentials,
            &self.connection,
            &self.agent,
        );
        hex(Sha256::digest(
            serde_json::to_vec(&published).expect("nonsecret inputs"),
        ))
    }

    /// The setup container that publishes the files.
    pub fn helper_name(&self) -> String {
        format!("{}-inputs", self.application)
    }

    /// A path relative to `root`.
    pub fn relative<'a>(&self, path: &'a str) -> &'a str {
        &path[self.root.len() + 1..]
    }

    /// The connection descriptor's relative path and content, once the agent
    /// sandbox is resolved.
    ///
    /// # Errors
    /// Returns an error when the inputs are invalid or the sandbox is unresolved.
    pub fn descriptor(&self) -> Result<Option<(String, Value)>, Error> {
        self.validate(true)?;
        let (Some(connection), Some(agent)) = (&self.connection, &self.agent) else {
            return Ok(None);
        };
        let credential_file = connection
            .credential
            .as_ref()
            .map(|name| self.credentials[name].path.as_str());
        let descriptor = json!({
            "schemaVersion":"nemoclaw.agent-connection.v1", "deploymentUid":self.owner, "service":connection.service,
            "gateway":{"endpoint":connection.endpoint,"tls":{"trust":connection.trust,"caFile":null}},
            "authentication":{"mode":connection.authentication,"credentialFile":credential_file,"refreshMode":"none"},
            "target":{"workspace":agent.workspace,"sandbox":agent.sandbox,"sandboxId":agent.sandbox_id,"agent":agent.name},
            "bridge":{"interfaceVersion":1,"command":"fabric-agent"},
            "timeouts":{"healthSeconds":connection.health_seconds,"invokeSeconds":connection.invoke_seconds}
        });
        require(
            descriptor.to_string().len() <= nemoclaw_container_inputs::MAX_DESCRIPTOR_BYTES,
            "application connection descriptor exceeds its size limit",
        )?;
        Ok(Some((
            self.relative(&connection.path).to_owned(),
            descriptor,
        )))
    }

    /// The `host_image` inputs that check the setup image before any change.
    pub fn image_requirements(&self) -> Value {
        json!({
            "engine": self.engine, "image": self.image, "architecture": self.architecture,
            "labels": {nemoclaw_container_inputs::CONTRACT_LABEL: nemoclaw_container_inputs::CONTRACT_VERSION}
        })
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
