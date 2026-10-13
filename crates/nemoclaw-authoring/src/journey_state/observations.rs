// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::*;

impl JourneyState {
    /// Resolve questions and readiness against the observations gathered so far.
    /// Endpoint models remain suggestions, while target observations can block
    /// readiness. Credential availability is informational; an empty sheet
    /// leaves compatibility unverified and lists references needed by plan.
    pub fn resolve_with_observations(
        &self,
        capabilities: &Capabilities,
        observations: &DiscoveryObservations,
    ) -> Result<JourneyResolution, Diagnostics> {
        let mut resolution = self.resolve(capabilities)?;
        // A host that can run only one local target makes it the suggestion,
        // even over a supplied value; the user still decides.
        let answered = self.answered_engines.as_deref().unwrap_or_default();
        let mut targets: Vec<&str> = Vec::new();
        for engine in answered {
            if !targets.contains(&engine.compute_driver.as_str()) {
                targets.push(engine.compute_driver.as_str());
            }
        }
        if let [only] = targets.as_slice()
            && let Some(question) = resolution
                .questions
                .iter_mut()
                .find(|question| question.id == GATEWAY_TARGET)
        {
            question.suggestion = Some(Value::String((*only).into()));
        }
        if !observations.is_empty()
            && let Some(document) = resolution.assessment.document()
        {
            resolution.target_assessment = Some(crate::assess_target(document, observations)?);
        }
        // Without an engine for its target, a managed gateway reports that cause
        // first. Only a Docker target has a default engine, Docker's standard
        // socket, and its read would report a mismatch rather than the cause.
        // That default is not offered as the engine either: accepting it would
        // author a socket no engine answered on.
        if let Some((target, engine)) = self.target_without_local_engine() {
            if let Some(question) = resolution
                .questions
                .iter_mut()
                .find(|question| question.id == engine)
            {
                question.suggestion = None;
            }
            let reason = format!(
                "No {target} engine answered on this machine. Start it, or set spec.gateway.target.{target}.engine to its socket."
            );
            // Podman has no default engine, so its document stays incomplete
            // and no target was assessed; the cause is still the first thing
            // to report.
            resolution
                .target_assessment
                .get_or_insert_with(|| crate::DiscoveryAssessment {
                    status: crate::CompatibilityStatus::Unverified,
                    reasons: Vec::new(),
                })
                .reasons
                .insert(0, reason);
        }
        let Some(document) = resolution.assessment.document() else {
            return Ok(resolution);
        };
        let unresolved = document
            .credential_names()
            .into_iter()
            .filter(|reference| {
                observations
                    .get(&CredentialRequest {
                        reference: (*reference).into(),
                    })
                    .is_none_or(|credential| credential.status != ObservationStatus::Available)
            })
            .collect::<Vec<_>>();
        if !unresolved.is_empty() {
            resolution.information.push(format!(
                "Credential availability is missing or unverified here: {}. Interactive plan prompts for missing values; set them first for a non-interactive run.",
                unresolved.join(", ")
            ));
        }
        let Some(request) = crate::inference_request_for_document(document, self.current_route())
            .ok()
            .flatten()
        else {
            return Ok(resolution);
        };
        let Some(observed) = observations.get(&request) else {
            return Ok(resolution);
        };
        if let Some(note) = catalog_credential_note(&request, observed) {
            resolution.information.push(note);
            if let Some(path) = self.route_model_path()
                && let Some(question) = resolution
                    .questions
                    .iter_mut()
                    .find(|question| question.id == path)
            {
                question.choices.clear();
                question.suggestion = None;
            }
            return Ok(resolution);
        }
        if observed.status != ObservationStatus::Available {
            return Ok(resolution);
        }
        let Some(path) = self.route_model_path() else {
            return Ok(resolution);
        };
        if let Some(question) = resolution
            .questions
            .iter_mut()
            .find(|question| question.id == path)
        {
            if let Some(suggestion) = question.suggestion.clone() {
                question.choices.push(suggestion);
            }
            for model in &observed.models {
                if !model.is_empty() && model.len() <= 512 && !model.chars().any(char::is_control) {
                    let value = Value::String(model.clone());
                    if !question.choices.contains(&value) {
                        question.choices.push(value);
                    }
                }
            }
        }
        Ok(resolution)
    }

    /// The chosen local target of a managed gateway without an authored
    /// engine, and that engine's pointer, when this machine was asked and no
    /// engine answered for that target.
    fn target_without_local_engine(&self) -> Option<(String, String)> {
        let answered = self.answered_engines.as_deref()?;
        let (target, engine) = managed_target_engine(&self.authored.values)?;
        (self.authored.values.pointer(&engine).is_none()
            && !answered
                .iter()
                .any(|observed| observed.compute_driver.as_str() == target))
        .then_some((target, engine))
    }

    /// Accept remaining suggestions as one explicit, fact-gated action.
    /// Required questions without a suggestion and route choices stay manual.
    pub fn delegate_remaining(
        &self,
        capabilities: &Capabilities,
        observations: &DiscoveryObservations,
    ) -> Result<Self, Diagnostics> {
        self.check_delegation(capabilities, observations)?;
        let mut candidate = self.clone();
        for _ in 0..256 {
            let resolution = candidate.resolve_with_observations(capabilities, observations)?;
            let Some(question) = resolution.next_question() else {
                if resolution.materialized_document().is_some() {
                    candidate.check_delegation(capabilities, observations)?;
                    return Ok(candidate);
                }
                return Err(diagnostic(
                    "delegation",
                    "Remaining SDK or Fabric constraints need individual answers.",
                ));
            };
            if question.id == ROUTE_SELECTION {
                return Err(diagnostic(
                    "delegation",
                    "Select each inference route before delegating its questions.",
                ));
            }
            let value = question.suggestion.clone();
            if value.is_none() && question.required {
                return Err(diagnostic(
                    "delegation",
                    "A required question has no safe suggested answer.",
                ));
            }
            candidate.answer(capabilities, question.id(), value)?;
        }
        Err(diagnostic(
            "delegation",
            "Too many questions remain to delegate safely.",
        ))
    }

    pub(super) fn check_delegation(
        &self,
        capabilities: &Capabilities,
        observations: &DiscoveryObservations,
    ) -> Result<(), Diagnostics> {
        if !harness_field(&self.authored.values)
            .is_some_and(|field| self.decisions.accepted.contains(&field))
        {
            return Err(diagnostic(
                "delegation",
                "Choose a harness before delegating settings.",
            ));
        }
        let resolution = self.resolve(capabilities)?;
        let document = resolution
            .assessment()
            .document()
            .ok_or_else(|| diagnostic("delegation", "The desired state is not SDK-valid yet."))?;
        let target = crate::assess_target(document, observations)?;
        if target.status != CompatibilityStatus::Compatible {
            return Err(diagnostic(
                "delegation",
                "Target engine and image compatibility is not verified.",
            ));
        }
        let request = crate::inference_request_for_document(document, self.current_route())?
            .ok_or_else(|| {
                diagnostic(
                    "delegation",
                    "The selected route has no external model catalog to verify.",
                )
            })?;
        let endpoint = observations
            .get(&request)
            .ok_or_else(|| diagnostic("delegation", "Model discovery is missing or stale."))?;
        if let Some(note) = catalog_credential_note(&request, endpoint) {
            return Err(diagnostic("inference:catalog:credential", &note));
        }
        if endpoint.status != ObservationStatus::Available
            || endpoint.reachable != Some(true)
            || !matches!(
                endpoint.authentication,
                AuthenticationStatus::Accepted | AuthenticationStatus::NotRequired
            )
        {
            return Err(diagnostic(
                "delegation",
                "The model catalog could not be verified.",
            ));
        }
        let model = self
            .route_model_path()
            .and_then(|path| self.authored.values.pointer(&path))
            .and_then(Value::as_str)
            .ok_or_else(|| {
                diagnostic("delegation", "Choose a model before delegating settings.")
            })?;
        if !endpoint.models.iter().any(|advertised| advertised == model) {
            return Err(diagnostic(
                "delegation",
                "The selected model was not advertised by the endpoint.",
            ));
        }
        Ok(())
    }
}

/// Only a reachable server's explicit authentication requirement establishes
/// this condition. A denied key or unreachable catalog remains a real failure.
fn catalog_credential_note(
    request: &nemoclaw_sdk::inference_discovery::EndpointRequest,
    endpoint: &nemoclaw_sdk::inference_discovery::EndpointObservation,
) -> Option<String> {
    if endpoint.status != ObservationStatus::Unavailable
        || endpoint.reachable != Some(true)
        || endpoint.authentication != AuthenticationStatus::Required
    {
        return None;
    }
    request.credential_env.as_ref().map(|reference| format!(
        "Model catalog needs credential {reference}. Set it to see model suggestions and use bulk acceptance, or enter a model identifier to continue individually."
    ))
}
