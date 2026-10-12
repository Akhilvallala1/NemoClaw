// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Pure selected-agent binding and connection projection.
use crate::{
    Error,
    config::{ConfigError, Document, validation::require},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
/// Explicit application authentication profile.
pub enum AuthenticationMode {
    OidcBearer,
    None,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
/// The installer delivers a static reference; refresh belongs to the application.
pub enum RefreshMode {
    None,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
/// Trust for the selected application transport.
pub enum TlsTrust {
    System,
    None,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
/// One explicitly selected sandbox agent and application-reachable OpenShell endpoint.
pub struct AgentConnection {
    /// Declared sandbox whose ownership and physical identity bind the connection.
    pub sandbox_ref: String,
    /// Agent name declared by the selected sandbox.
    pub agent: String,
    /// Canonical descriptor file path below the application data root.
    pub target_path: String,
    /// HTTPS origin for oidcBearer. For development-only none, omission derives the managed Docker gateway's private origin; an explicit value must match it exactly.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub gateway_endpoint: String,
    /// Declared application identity reference; issuance and authority remain external.
    pub authentication: ApplicationAuthentication,
    /// system for HTTPS/OIDC, or explicit none for the managed local development connection.
    pub tls: ApplicationTrust,
    /// Bounded application client deadlines.
    pub timeouts: ConnectionTimeouts,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
/// Static bearer delivery does not issue, refresh, or narrow an identity's authority.
pub struct ApplicationAuthentication {
    /// oidcBearer requires an external service identity. Explicit none selects development-only, unauthenticated HTTP to this deployment's managed Docker gateway; no automatic fallback.
    pub mode: AuthenticationMode,
    /// Required protected credential name for oidcBearer; absent or null for none. Speech credentials remain independent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub secret_ref: Option<String>,
    /// none: the application fails closed on expiry; no installer-owned refresh.
    pub refresh_mode: RefreshMode,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
/// Trust must match the explicitly selected authentication and transport profile.
pub struct ApplicationTrust {
    /// system uses image CA roots with HTTPS/OIDC. none explicitly selects plaintext for the bound local development gateway. Private CA delivery and skipped certificate verification are unsupported.
    pub trust: TlsTrust,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
/// Bounded application-client health and invocation deadlines.
pub struct ConnectionTimeouts {
    /// Non-generative native agent check deadline, 1–12 seconds.
    pub health_seconds: u64,
    /// Explicit agent invocation deadline, 1–120 seconds.
    pub invoke_seconds: u64,
}

impl AgentConnection {
    pub(super) fn validate(&self) -> Result<(), ConfigError> {
        let bearer = self.authentication.mode == AuthenticationMode::OidcBearer;
        require(
            bearer == self.authentication.secret_ref.is_some(),
            "container connection requires an explicit static bearer or credential-free local development profile",
        )?;
        require(
            self.tls.trust
                == if bearer {
                    TlsTrust::System
                } else {
                    TlsTrust::None
                },
            "container connection TLS trust must match its authentication profile",
        )?;
        require(
            (1..=12).contains(&self.timeouts.health_seconds)
                && (1..=120).contains(&self.timeouts.invoke_seconds),
            "container connection deadlines exceed the supported bounds",
        )?;
        if !bearer && self.gateway_endpoint.is_empty() {
            return Ok(());
        }
        let endpoint = url::Url::parse(&self.gateway_endpoint)
            .map_err(|_| ConfigError::new("invalid container gateway endpoint"))?;
        require(
            self.gateway_endpoint.len() <= 2048
                && endpoint.scheme() == if bearer { "https" } else { "http" }
                && endpoint.username().is_empty()
                && endpoint.password().is_none()
                && endpoint.query().is_none()
                && endpoint.fragment().is_none()
                && endpoint.path() == "/"
                && endpoint.host().is_some_and(|host| match host {
                    url::Host::Domain(name) => {
                        !name.eq_ignore_ascii_case("localhost") && !name.ends_with(".localhost")
                    }
                    url::Host::Ipv4(ip) => {
                        !ip.is_loopback()
                            && !ip.is_unspecified()
                            && !ip.is_multicast()
                            && !ip.is_broadcast()
                            && !ip.is_link_local()
                    }
                    url::Host::Ipv6(ip) => {
                        !ip.is_loopback()
                            && !ip.is_unspecified()
                            && !ip.is_multicast()
                            && !ip.is_unicast_link_local()
                    }
                }),
            "container gateway requires a valid origin for its explicit transport profile",
        )?;
        if !bearer {
            require(
                endpoint
                    .host()
                    .is_some_and(|host| matches!(host, url::Host::Ipv4(ip) if ip.is_private()))
                    && endpoint.port().is_some()
                    && self.gateway_endpoint == endpoint.origin().ascii_serialization(),
                "local development gateway requires a canonical private IPv4 origin",
            )?;
        }
        Ok(())
    }
    pub(super) fn descriptor(
        &self,
        owner: &str,
        workspace: &str,
        service: &str,
        sandbox_id: &str,
        credential_file: Option<&str>,
    ) -> Result<(String, Value), Error> {
        require(
            matches(crate::config::constraints::UUID, sandbox_id),
            "application sandbox identity is unresolved",
        )?;
        let descriptor = json!({
            "schemaVersion":"nemoclaw.agent-connection.v1", "deploymentUid":owner, "service":service,
            "gateway":{"endpoint":self.gateway_endpoint,"tls":{"trust":self.tls.trust,"caFile":null}},
            "authentication":{"mode":self.authentication.mode,"credentialFile":credential_file,"refreshMode":self.authentication.refresh_mode},
            "target":{"workspace":workspace,"sandbox":self.sandbox_ref,"sandboxId":sandbox_id,"agent":self.agent},
            "bridge":{"interfaceVersion":1,"command":"fabric-agent"}, "timeouts":self.timeouts
        });
        require(
            descriptor.to_string().len() <= nemoclaw_container_inputs::MAX_DESCRIPTOR_BYTES,
            "application connection descriptor exceeds its size limit",
        )?;
        Ok((self.target_path.clone(), descriptor))
    }
    pub fn validate_binding(
        &self,
        document: &Document,
        engine: &str,
        network: &str,
    ) -> Result<(), ConfigError> {
        let sandbox = document.sandbox(&self.sandbox_ref)?;
        require(
            sandbox.agent.name == self.agent,
            "container agent does not match its selected sandbox",
        )?;
        if self.authentication.mode == AuthenticationMode::None {
            let gateway = LocalGateway::from_document(document)?;
            let expected = gateway.endpoint()?;
            require(
                engine == gateway.engine && network == gateway.network_cidr,
                "local development connection requires the managed gateway's engine and network",
            )?;
            require(
                self.gateway_endpoint.is_empty() || self.gateway_endpoint == expected,
                "local development endpoint must match this deployment's managed gateway",
            )?;
        }
        Ok(())
    }
    pub(super) fn resolved_endpoint(&self, document: &Document) -> Result<String, ConfigError> {
        if self.authentication.mode == AuthenticationMode::None {
            LocalGateway::from_document(document)?.endpoint()
        } else {
            Ok(self.gateway_endpoint.clone())
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
/// Only the local gateway placement needed to validate a development connection.
pub struct LocalGateway {
    pub engine: String,
    pub network_cidr: String,
    pub port: u16,
}
impl LocalGateway {
    pub(super) fn from_document(document: &Document) -> Result<Self, ConfigError> {
        let gateway = document.spec.gateway.managed()?;
        gateway.validate_managed()?;
        require(
            gateway.runtime.provider == crate::config::ComputeDriver::Docker,
            "local development connection requires a managed local Docker gateway",
        )?;
        let port = url::Url::parse(&gateway.endpoint)
            .ok()
            .and_then(|origin| origin.port())
            .ok_or_else(|| ConfigError::new("missing managed gateway port"))?;
        Ok(Self {
            engine: gateway.engine.clone(),
            network_cidr: gateway.network_cidr.clone(),
            port,
        })
    }
    fn endpoint(&self) -> Result<String, ConfigError> {
        require(
            self.network_cidr
                .parse::<ipnet::Ipv4Net>()
                .is_ok_and(|net| {
                    net.addr().is_private() && net.prefix_len() == 24 && net.addr() == net.network()
                }),
            "invalid local gateway network",
        )?;
        require(
            self.engine.starts_with("unix:///")
                && crate::config::validate_engine_endpoint(&self.engine).is_ok()
                && self.port >= 1024,
            "invalid local gateway engine or port",
        )?;
        Ok(format!(
            "http://{}:{}",
            crate::config::gateway_address(&self.network_cidr)?,
            self.port
        ))
    }
    pub(super) fn validate(&self, engine: &str, endpoint: &str) -> Result<(), ConfigError> {
        require(
            self.engine == engine && endpoint == self.endpoint()?,
            "local development endpoint differs from its managed gateway binding",
        )
    }
}

pub(super) fn matches(pattern: &str, value: &str) -> bool {
    regex::Regex::new(pattern).unwrap().is_match(value) && !value.contains(['\0', '\r', '\n'])
}
