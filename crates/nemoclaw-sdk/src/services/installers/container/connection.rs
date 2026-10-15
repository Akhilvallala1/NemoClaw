// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Pure selected-agent binding and connection projection.
use crate::config::{ConfigError, Document, validation::require};
use serde::{Deserialize, Serialize};

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
        validate_profile(
            self.authentication.mode,
            self.authentication.secret_ref.is_some(),
            self.tls.trust,
            (self.authentication.mode == AuthenticationMode::OidcBearer
                || !self.gateway_endpoint.is_empty())
            .then_some(self.gateway_endpoint.as_str()),
            &self.timeouts,
        )
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

/// Check one explicit transport profile: HTTPS with a static OIDC bearer
/// credential and system trust, or development-only plaintext HTTP to a
/// canonical private IPv4 origin with neither. `endpoint` may be omitted only
/// for HTTP, whose origin the SDK derives from the managed gateway.
pub(super) fn validate_profile(
    mode: AuthenticationMode,
    credential: bool,
    trust: TlsTrust,
    endpoint: Option<&str>,
    timeouts: &ConnectionTimeouts,
) -> Result<(), ConfigError> {
    let bearer = mode == AuthenticationMode::OidcBearer;
    require(
        bearer == credential,
        "container connection requires an explicit static bearer or credential-free local development profile",
    )?;
    require(
        trust
            == if bearer {
                TlsTrust::System
            } else {
                TlsTrust::None
            },
        "container connection TLS trust must match its authentication profile",
    )?;
    require(
        (1..=12).contains(&timeouts.health_seconds) && (1..=120).contains(&timeouts.invoke_seconds),
        "container connection deadlines exceed the supported bounds",
    )?;
    let Some(endpoint) = endpoint else {
        return require(!bearer, "container gateway requires an HTTPS origin");
    };
    let origin = url::Url::parse(endpoint)
        .map_err(|_| ConfigError::new("invalid container gateway endpoint"))?;
    require(
        endpoint.len() <= 2048
            && origin.scheme() == if bearer { "https" } else { "http" }
            && origin.username().is_empty()
            && origin.password().is_none()
            && origin.query().is_none()
            && origin.fragment().is_none()
            && origin.path() == "/"
            && origin.host().is_some_and(|host| match host {
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
            origin
                .host()
                .is_some_and(|host| matches!(host, url::Host::Ipv4(ip) if ip.is_private()))
                && origin.port().is_some()
                && endpoint == origin.origin().ascii_serialization(),
            "local development gateway requires a canonical private IPv4 origin",
        )?;
    }
    Ok(())
}

/// Only the local gateway placement needed to validate a development connection.
struct LocalGateway {
    engine: String,
    network_cidr: String,
    port: u16,
}
impl LocalGateway {
    fn from_document(document: &Document) -> Result<Self, ConfigError> {
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
}

pub(super) fn matches(pattern: &str, value: &str) -> bool {
    regex::Regex::new(pattern).unwrap().is_match(value) && !value.contains(['\0', '\r', '\n'])
}
