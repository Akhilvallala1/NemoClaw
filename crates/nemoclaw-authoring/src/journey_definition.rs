// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Sparse values and deliberate question guidance for one onboarding journey.

use nemoclaw_sdk::config::{Document, valid_name};
use serde_json::Value;
use std::collections::BTreeSet;

use crate::{
    Capabilities, Diagnostics, PartialDocument,
    diagnostics::diagnostic,
    sdk_schema::{sdk_field_possible, sdk_field_schema_for},
};

pub(crate) const NAME: &str = "/metadata/name";
pub(crate) const INFERENCE_PRESET: &str = "inference:preset";

/// The pointer to the journey's only sandbox, `/spec/sandboxes/<name>`, when
/// `/spec/sandboxes` holds exactly one object and its key is a valid name.
/// Questions address the sandbox by this key, so a key the SDK rejects never
/// becomes part of a question ID.
pub(crate) fn sandbox_path(values: &Value) -> Option<String> {
    let sandboxes = values.pointer("/spec/sandboxes")?.as_object()?;
    let [(name, sandbox)] = sandboxes.iter().collect::<Vec<_>>()[..] else {
        return None;
    };
    (sandbox.is_object() && valid_name(name)).then(|| format!("/spec/sandboxes/{name}"))
}

/// The pointer to the inline harness kind of the journey's only sandbox,
/// which is also the ID of the harness question.
pub(crate) fn harness_field(values: &Value) -> Option<String> {
    sandbox_path(values).map(|sandbox| format!("{sandbox}/harness/kind"))
}

/// The name of a one-sandbox document's sandbox; `None` for any other count.
pub(crate) fn sole_sandbox(document: &Document) -> Option<&str> {
    let mut names = document.spec.sandboxes.keys();
    match (names.next(), names.next()) {
        (Some(name), None) => Some(name),
        _ => None,
    }
}

/// A schema-discovered family of applicable questions. The schema determines
/// which fields exist and whether they are required; this only asks to review
/// supplied values in that family.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum JourneyScope {
    ActiveAdapterSettings,
    NativeSettings,
    RouteModels,
    InferenceApi,
    DeploymentFields,
}

/// A target check that a journey requires before its completed document is
/// ready to leave authoring. The observation remains separate from authored
/// desired state.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum TargetPrerequisite {
    EngineAndImageCompatible,
}

/// Select one field or a family discovered from the active SDK and Fabric
/// schemas. Selection controls prompting, not applicability or requiredness.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum JourneySelector {
    Field(String),
    Scope(JourneyScope),
}

impl From<&str> for JourneySelector {
    fn from(value: &str) -> Self {
        Self::Field(value.into())
    }
}

impl From<String> for JourneySelector {
    fn from(value: String) -> Self {
        Self::Field(value)
    }
}

impl From<JourneyScope> for JourneySelector {
    fn from(value: JourneyScope) -> Self {
        Self::Scope(value)
    }
}

/// A deployment seed and deliberate prompt or omission guidance.
/// Starts a single-sandbox run and supports a bounded preview through the same
/// resolver. Unsupported SDK structure remains an explicit frontier.
#[derive(Clone, Debug)]
pub struct JourneyDefinition {
    pub(crate) id: String,
    pub(crate) base: PartialDocument,
    pub(crate) ask: BTreeSet<String>,
    pub(crate) ask_order: Vec<String>,
    pub(crate) ask_scopes: BTreeSet<JourneyScope>,
    pub(crate) omit: BTreeSet<String>,
    pub(crate) omit_scopes: BTreeSet<JourneyScope>,
    pub(crate) target_prerequisites: BTreeSet<TargetPrerequisite>,
}

impl JourneyDefinition {
    pub fn new(id: impl Into<String>, base: PartialDocument) -> Self {
        Self {
            id: id.into(),
            base,
            ask: BTreeSet::new(),
            ask_order: Vec::new(),
            ask_scopes: BTreeSet::new(),
            omit: BTreeSet::new(),
            omit_scopes: BTreeSet::new(),
            target_prerequisites: BTreeSet::new(),
        }
    }

    pub fn ask(mut self, selectors: impl IntoIterator<Item = impl Into<JourneySelector>>) -> Self {
        for selector in selectors {
            match selector.into() {
                JourneySelector::Field(field) => {
                    if self.ask.insert(field.clone()) {
                        self.ask_order.push(field);
                    }
                }
                JourneySelector::Scope(scope) => {
                    self.ask_scopes.insert(scope);
                }
            }
        }
        self
    }

    /// Leave absent optional values unset without a prompt. A scope omits only
    /// the absent optional values it discovers; exact `ask` guidance still asks.
    pub fn omit(mut self, selectors: impl IntoIterator<Item = impl Into<JourneySelector>>) -> Self {
        for selector in selectors {
            match selector.into() {
                JourneySelector::Field(field) => {
                    self.omit.insert(field);
                }
                JourneySelector::Scope(scope) => {
                    self.omit_scopes.insert(scope);
                }
            }
        }
        self
    }

    pub fn require_target(
        mut self,
        prerequisites: impl IntoIterator<Item = TargetPrerequisite>,
    ) -> Self {
        self.target_prerequisites.extend(prerequisites);
        self
    }

    /// Start mutable resolution over the sparse v1 single-sandbox envelope.
    pub fn start(&self, capabilities: &Capabilities) -> Result<crate::JourneyState, Diagnostics> {
        if sandbox_path(self.base.supplied()).is_none() {
            return Err(diagnostic(
                "journey",
                "The v1 journey requires exactly one sandbox keyed by a lowercase name.",
            ));
        }
        self.validate_guidance(capabilities)?;
        crate::JourneyState::new(self.clone())
    }

    pub(crate) fn validate_guidance(&self, capabilities: &Capabilities) -> Result<(), Diagnostics> {
        if let Some(field) = self.ask.intersection(&self.omit).next() {
            return Err(diagnostic(
                "journey",
                &format!("'{field}' cannot be both asked and omitted"),
            ));
        }
        if let Some(scope) = self.ask_scopes.intersection(&self.omit_scopes).next() {
            return Err(diagnostic(
                "journey",
                &format!("scope {scope:?} cannot be both asked and omitted"),
            ));
        }
        if let Some(scope) = self
            .omit_scopes
            .iter()
            .find(|scope| **scope != JourneyScope::ActiveAdapterSettings)
        {
            return Err(diagnostic(
                "journey",
                &format!("scope {scope:?} cannot be omitted in this preview"),
            ));
        }
        let supplied = self.base.supplied();
        let sandbox = sandbox_path(supplied);
        let harness = harness_field(supplied);
        for field in &self.ask {
            if field == NAME || Some(field) == harness.as_ref() || field == INFERENCE_PRESET {
                continue;
            }
            // A field of another sandbox or of an absent provider would add
            // that entry when answered.
            let entry = |collection: &str| {
                let rest = field.strip_prefix(collection)?.strip_prefix('/')?;
                Some(rest.split_once('/').map_or(rest, |(key, _)| key))
            };
            if let Some(key) = entry("/spec/sandboxes")
                && sandbox.as_ref() != Some(&format!("/spec/sandboxes/{key}"))
            {
                return Err(diagnostic(
                    "journey",
                    "asked fields must belong to the journey's sandbox",
                ));
            }
            if let Some(key) = entry("/spec/inferenceProviders")
                && supplied
                    .pointer(&format!("/spec/inferenceProviders/{key}"))
                    .is_none()
            {
                return Err(diagnostic(
                    "journey",
                    "asked provider fields must belong to a supplied provider",
                ));
            }
            if sdk_field_schema_for(self.base.supplied(), field).is_some()
                || sdk_field_possible(field)
            {
                continue;
            }
            if native_field(field) {
                continue;
            }
            let Some((adapter, _)) = adapter_field(field) else {
                return Err(diagnostic(
                    "journey",
                    &format!("cannot ask '{field}' in this preview"),
                ));
            };
            adapter_schema(capabilities, adapter)?;
        }
        for field in &self.omit {
            if field.starts_with('/') {
                let current = sdk_field_schema_for(self.base.supplied(), field);
                if current.is_none() && !sdk_field_possible(field) {
                    return Err(diagnostic(
                        "journey",
                        &format!("cannot omit '{field}' in this preview"),
                    ));
                }
                if current.is_some_and(|(_, required)| required) {
                    return Err(diagnostic(
                        "journey",
                        &format!("required SDK field '{field}' cannot be omitted"),
                    ));
                }
                if self.base.supplied().pointer(field).is_some() {
                    return Err(diagnostic(
                        "journey",
                        &format!("supplied SDK field '{field}' cannot be omitted"),
                    ));
                }
                continue;
            }
            if native_field(field) {
                continue;
            }
            let Some((adapter, pointer)) = adapter_field(field) else {
                return Err(diagnostic(
                    "journey",
                    &format!("cannot omit '{field}' in this preview"),
                ));
            };
            if pointer.is_empty() {
                return Err(diagnostic(
                    "journey",
                    "required adapter settings alternatives cannot be omitted",
                ));
            }
            if let (Some(sandbox), Some(harness)) = (&sandbox, &harness)
                && supplied.pointer(harness).and_then(Value::as_str) == Some(adapter)
                && supplied
                    .pointer(&format!("{sandbox}/harness/settings{pointer}"))
                    .is_some()
            {
                return Err(diagnostic(
                    "journey",
                    &format!("supplied setting '{field}' cannot be omitted"),
                ));
            }
            adapter_schema(capabilities, adapter)?;
        }
        Ok(())
    }

    /// Print a bounded symbolic preview using the current question resolver.
    pub fn print_tree(&self, capabilities: &Capabilities) -> Result<String, Diagnostics> {
        crate::journey_tree::print_tree(self, capabilities)
    }
}

pub(crate) fn adapter_schema<'a>(
    capabilities: &'a Capabilities,
    adapter: &str,
) -> Result<Option<&'a Value>, Diagnostics> {
    let Some(alternatives) = capabilities.schemas.get(adapter) else {
        return Ok(None);
    };
    let Some((_, schema)) = alternatives.first() else {
        return Ok(None);
    };
    if alternatives.iter().any(|(_, other)| other != schema) {
        return Err(diagnostic(
            "journey",
            &format!("adapter '{adapter}' has ambiguous setting schemas"),
        ));
    }
    Ok(Some(schema))
}

pub(crate) fn adapter_field(field: &str) -> Option<(&str, &str)> {
    let suffix = field.strip_prefix("adapter:")?;
    let (adapter, path) = suffix.split_once(':')?;
    (!adapter.is_empty() && (path.is_empty() || path.starts_with('/'))).then_some((adapter, path))
}

pub(crate) fn native_field(field: &str) -> bool {
    field == "workflow:/target_id"
        || field == "workflow:/settings"
        || field.starts_with("workflow:/settings/")
        || field
            .strip_prefix("model:/")
            .is_some_and(|path| !path.is_empty())
}
