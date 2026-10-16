// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::*;

impl QuestionResolver<'_> {
    /// The harness question, offering the harnesses the image catalog lists.
    /// Harness settings have no schema here: Fabric validates them when the
    /// agent is configured.
    pub(super) fn collect_harness_question(
        &self,
        capabilities: &Capabilities,
        work: &mut ResolutionWork,
    ) {
        let active_harness = harness_path(&self.authored.values).or_else(|| {
            (self
                .position
                .selected_forms
                .get("/spec/sandboxes/0")
                .is_some_and(|form| form == "harness"))
            .then(|| "/spec/sandboxes/0/harness".into())
        });
        let chosen = active_harness
            .as_ref()
            .and_then(|path| self.authored.values.pointer(&format!("{path}/kind")))
            .and_then(Value::as_str);
        let harness_open = active_harness.is_some()
            && (chosen.is_none()
                || (self.definition.ask.contains(HARNESS)
                    && !self.decisions.accepted.contains(HARNESS)));
        // A harness the catalog doesn't list can't be confirmed for the
        // image, so the document isn't ready.
        if let Some(harness) = chosen
            && !capabilities
                .harnesses()
                .iter()
                .any(|listed| listed.as_str() == harness)
        {
            work.unverified.push(format!(
                "harness '{harness}' is not in the current Fabric catalog"
            ));
        }
        if !harness_open {
            return;
        }
        // The catalog supplies the harness choices; replace the generic SDK
        // leaf question if sparse traversal found the same field.
        work.questions.retain(|question| question.id != HARNESS);
        if capabilities.harnesses().is_empty() {
            work.unverified
                .push("no harness choices are advertised by the current Fabric catalog".into());
        }
        work.questions.push(JourneyQuestion {
            target: QuestionTarget::Harness,
            kind: JourneyQuestionKind::Field,
            reopened_because: None,
            id: HARNESS.into(),
            reason: if chosen.is_none() {
                JourneyQuestionReason::Missing
            } else {
                JourneyQuestionReason::ExplicitAsk
            },
            required: true,
            choices: capabilities
                .harnesses()
                .iter()
                .map(|harness| Value::String(harness.as_str().into()))
                .collect(),
            suggestion: chosen.map(|kind| Value::String(kind.into())),
            schema: serde_json::json!({"type":"string"}),
            title: None,
            description: None,
        });
    }
}
