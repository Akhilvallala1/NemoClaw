// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! An application's connection to one sandbox agent through the OpenShell gateway.
use crate::config::{ConfigError, Document, validation::require};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
/// How the application authenticates to the gateway.
pub enum AuthenticationMode {
    /// HTTPS with system trust and a static bearer credential from `secrets`.
    OidcBearer,
    /// Development-only plaintext HTTP to this deployment's managed Docker gateway, without authentication.
    None,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
/// The sandbox agent the application invokes. NemoClaw writes a nonsecret
/// connection descriptor before the application starts.
pub struct AgentConnection {
    /// Declared sandbox whose agent the application invokes.
    pub sandbox_ref: String,
    /// HTTPS gateway origin for oidcBearer. Omit for none; NemoClaw derives the managed gateway's private origin.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub gateway_endpoint: String,
    /// Explicit authentication; an omitted or failed mode never selects none.
    pub authentication: ApplicationAuthentication,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
/// The application's identity at the gateway. Issuance and refresh stay with the application.
pub struct ApplicationAuthentication {
    /// oidcBearer for HTTPS with a bearer credential, or none for development-only HTTP.
    pub mode: AuthenticationMode,
    /// The `secrets` entry holding the bearer token; required for oidcBearer.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub secret_ref: Option<String>,
}

/// Check one explicit profile: HTTPS with a credential, or plaintext HTTP to a
/// canonical private IPv4 origin without one. `endpoint` may be omitted only
/// for HTTP, whose origin the SDK derives.
pub(super) fn validate_profile(
    mode: AuthenticationMode,
    credential: bool,
    endpoint: Option<&str>,
) -> Result<(), ConfigError> {
    let bearer = mode == AuthenticationMode::OidcBearer;
    require(
        bearer == credential,
        "oidcBearer requires secretRef, and none forbids it",
    )?;
    let Some(endpoint) = endpoint else {
        return require(!bearer, "oidcBearer requires an HTTPS gatewayEndpoint");
    };
    let origin = url::Url::parse(endpoint)
        .map_err(|_| ConfigError::new("invalid container gateway endpoint"))?;
    require(
        origin.scheme() == if bearer { "https" } else { "http" }
            && origin.username().is_empty()
            && origin.password().is_none()
            && origin.query().is_none()
            && origin.fragment().is_none()
            && origin.path() == "/"
            && (bearer
                || origin.port().is_some()
                    && matches!(origin.host(), Some(url::Host::Ipv4(ip)) if ip.is_private())),
        "gatewayEndpoint must be an HTTPS origin, or an HTTP private IPv4 origin for none",
    )
}

impl AgentConnection {
    pub(super) fn validate(&self) -> Result<(), ConfigError> {
        validate_profile(
            self.authentication.mode,
            self.authentication.secret_ref.is_some(),
            (!self.gateway_endpoint.is_empty()).then_some(self.gateway_endpoint.as_str()),
        )
    }
    /// The selected sandbox's agent name.
    pub(crate) fn agent<'a>(&self, document: &'a Document) -> Result<&'a str, ConfigError> {
        Ok(&document.sandbox(&self.sandbox_ref)?.agent.name)
    }
    /// The origin the application reaches. For none, it is this deployment's
    /// managed Docker gateway on its private network.
    pub(crate) fn endpoint(&self, document: &Document) -> Result<String, ConfigError> {
        if self.authentication.mode == AuthenticationMode::OidcBearer {
            return Ok(self.gateway_endpoint.clone());
        }
        let gateway = super::Service::gateway(document)?;
        let port = url::Url::parse(&gateway.endpoint)
            .ok()
            .and_then(|origin| origin.port())
            .ok_or_else(|| ConfigError::new("missing managed gateway port"))?;
        let derived = format!(
            "http://{}:{port}",
            crate::config::gateway_address(&gateway.network_cidr)?
        );
        require(
            self.gateway_endpoint.is_empty() || self.gateway_endpoint == derived,
            "gatewayEndpoint for none must be this deployment's managed gateway",
        )?;
        Ok(derived)
    }
}
