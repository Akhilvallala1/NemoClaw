// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use super::{AgentTools, ConfigError, Document, Sandbox, SecretRef};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
/// Integration configuration attached inline to an agent or selected through integrationRefs. Unsupported kinds are rejected.
pub enum Integration {
    /// Web search with gateway-held credentials and explicit agent grants.
    WebSearch(WebSearch),
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
/// Managed search credentials and network grants. Native integration is configured through Fabric.
pub struct WebSearch {
    /// Supported search service.
    pub provider: SearchProvider,
    /// Host environment reference. OpenShell supplies the search provider's placeholder to the sandbox.
    pub credential: SecretRef,
}

/// A definition and its explicitly attached agents in one sandbox.
#[derive(Debug)]
pub struct IntegrationBinding<'a> {
    /// Name of the selected definition in its declaration scope.
    pub name: &'a str,
    /// Owning agent for an inline definition; None for an enclosing definition.
    pub agent: Option<&'a str>,
    pub definition: &'a Integration,
    pub agent_refs: Vec<&'a str>,
}

impl Sandbox {
    /// Resolve deployment and sandbox definitions without implicitly granting access.
    /// `name` is this sandbox's key, which diagnostics use to identify it.
    pub(crate) fn integration_bindings<'a>(
        &'a self,
        name: &str,
        shared: &'a BTreeMap<String, Integration>,
    ) -> Result<Vec<IntegrationBinding<'a>>, ConfigError> {
        validate_definitions(shared)?;
        validate_definitions(&self.integrations)?;
        if self
            .integrations
            .keys()
            .any(|name| shared.contains_key(name))
        {
            return Err(ConfigError::new(
                "sandbox integration names must not shadow deployment definitions",
            ));
        }
        let mut bindings = BTreeMap::new();
        let agent = &self.agent;
        validate_definitions(&agent.integrations)?;
        if agent
            .integrations
            .keys()
            .any(|name| shared.contains_key(name) || self.integrations.contains_key(name))
        {
            return Err(ConfigError::new(
                "agent integration names must not shadow enclosing definitions",
            ));
        }
        let mut names = BTreeSet::new();
        let references = agent
            .integration_refs
            .iter()
            .enumerate()
            .map(|(index, reference)| {
                let definition = self
                    .integrations
                    .get(reference)
                    .or_else(|| shared.get(reference))
                    .ok_or_else(|| {
                        super::references::missing_reference(
                            &format!(
                                "{}.agent.integrationRefs[{index}]",
                                super::references::sandbox_path(name)
                            ),
                            "integration",
                            reference,
                            shared
                                .keys()
                                .chain(self.integrations.keys())
                                .map(String::as_str),
                        )
                    })?;
                Ok((None, reference.as_str(), definition))
            });
        let inline = agent
            .integrations
            .iter()
            .map(|(name, definition)| Ok((Some(agent.name.as_str()), name.as_str(), definition)));
        for definition in references.chain(inline) {
            let (owner, name, definition) = definition?;
            if !names.insert(name) {
                return Err(ConfigError::new(
                    "agent integration references must be unique",
                ));
            }
            bindings
                .entry((owner, name))
                .or_insert_with(|| IntegrationBinding {
                    name,
                    agent: owner,
                    definition,
                    agent_refs: Vec::new(),
                })
                .agent_refs
                .push(&agent.name);
        }

        Ok(bindings.into_values().collect())
    }
}

impl Document {
    /// Resolve the deployment and sandbox integration definitions the named
    /// sandbox selects, without implicitly granting access.
    pub fn sandbox_integration_bindings(
        &self,
        sandbox: &str,
    ) -> Result<Vec<IntegrationBinding<'_>>, ConfigError> {
        let (name, sandbox) = self.named_sandbox(sandbox)?;
        sandbox.integration_bindings(name, &self.spec.integrations)
    }

    /// The web search attached to the named sandbox, if any.
    pub(crate) fn web_search(
        &self,
        sandbox: &str,
    ) -> Result<Option<RuntimeWebSearch>, ConfigError> {
        let mut selected = None;
        for binding in self.sandbox_integration_bindings(sandbox)? {
            match binding.definition {
                Integration::WebSearch(search) => {
                    if selected.is_some() {
                        return Err(ConfigError::new(
                            "a sandbox supports only one attached web search definition",
                        ));
                    }
                    selected = Some(RuntimeWebSearch {
                        provider: search.provider,
                        credential: search.credential.clone(),
                        agent_refs: binding.agent_refs.into_iter().map(str::to_owned).collect(),
                    });
                }
            }
        }
        if let Some(search) = &mut selected {
            search.agent_refs.sort();
        }
        Ok(selected)
    }
}

fn validate_definitions(definitions: &BTreeMap<String, Integration>) -> Result<(), ConfigError> {
    super::schema::validate_property("Spec", "integrations", &definitions)
}

// Resolve managed credential and network grants from explicit agent references.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RuntimeWebSearch {
    pub provider: SearchProvider,
    pub agent_refs: Vec<String>,
    pub credential: SecretRef,
}
pub use nemoclaw_openshell::search::{SearchProvider, search_provider_name};

/// Deployment graph address of a search provider's profile.
pub(crate) fn profile_address(provider: SearchProvider) -> &'static str {
    match provider {
        SearchProvider::Brave => "openshell_provider_profile.web_search",
        SearchProvider::Tavily => "openshell_provider_profile.web_search_tavily",
    }
}

/// Deployment graph address of a search provider's image-scoped profile.
pub(crate) fn image_profile_address(provider: SearchProvider, scope: &str) -> String {
    format!("{}_{scope}", profile_address(provider))
}

impl RuntimeWebSearch {
    pub(crate) fn validate<'a>(
        &self,
        agents: impl Iterator<Item = (&'a str, Option<&'a AgentTools>)>,
    ) -> Result<(), ConfigError> {
        let agents: std::collections::BTreeMap<_, _> = agents.collect();
        let mut names = std::collections::BTreeSet::new();
        if self.agent_refs.is_empty()
            || self
                .agent_refs
                .iter()
                .any(|name| !names.insert(name) || !agents.contains_key(name.as_str()))
        {
            return Err(ConfigError::new(
                "web search requires unique references to configured agents",
            ));
        }
        super::schema::validate_definition("SecretRef", &self.credential)
    }
}
