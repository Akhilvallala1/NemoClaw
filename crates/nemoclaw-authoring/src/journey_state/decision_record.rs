// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Records deliberate answers, omissions, and dependency invalidation.

use super::*;

/// The user's decisions about applicable questions, separate from supplied values.
#[derive(Clone, Debug, Default)]
pub(super) struct DecisionRecord {
    pub(super) accepted: BTreeSet<String>,
    pub(super) targets: BTreeMap<String, QuestionTarget>,
    pub(super) reopened_by: BTreeMap<String, String>,
    pub(super) omitted: BTreeSet<String>,
    pub(super) selected_presets: BTreeMap<usize, ProviderPreset>,
    pub(super) accepted_presets: BTreeSet<usize>,
}

impl DecisionRecord {
    pub(super) fn status(&self, id: &str, selected_route: Option<usize>) -> DecisionStatus {
        // The compound provider preset is a decision about one route, even
        // though its question ID contains no route index.
        if matches!(
            self.targets.get(id),
            Some(QuestionTarget::InferencePreset { .. })
        ) {
            return if selected_route.is_some_and(|route| self.accepted_presets.contains(&route)) {
                DecisionStatus::Accepted
            } else {
                DecisionStatus::Unreviewed
            };
        }
        if let Some(because) = self.reopened_by.get(id) {
            DecisionStatus::Reopened {
                because: because.clone(),
            }
        } else if self.omitted.contains(id) {
            DecisionStatus::Omitted
        } else if self.accepted.contains(id) {
            DecisionStatus::Accepted
        } else {
            DecisionStatus::Unreviewed
        }
    }

    pub(super) fn record_answer(&mut self, id: &str, target: &QuestionTarget, omitted: bool) {
        self.accepted.insert(id.into());
        self.targets.insert(id.into(), target.clone());
        self.reopened_by.remove(id);
        if let QuestionTarget::InferencePreset { route } = target {
            self.accepted_presets.insert(*route);
        } else if omitted {
            self.omitted.insert(id.into());
        } else {
            self.omitted.remove(id);
        }
    }

    pub(super) fn reopen(&mut self, id: &str, cause: &str) {
        if self.accepted.remove(id) || self.reopened_by.contains_key(id) {
            self.reopened_by.insert(id.into(), cause.into());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preset_decisions_follow_the_selected_route() {
        let mut record = DecisionRecord::default();
        record.record_answer(
            "inference:preset",
            &QuestionTarget::InferencePreset { route: 0 },
            false,
        );
        assert_eq!(
            record.status("inference:preset", Some(0)),
            DecisionStatus::Accepted
        );
        assert_eq!(
            record.status("inference:preset", Some(1)),
            DecisionStatus::Unreviewed
        );
    }

    #[test]
    fn recording_uses_the_resolved_target_instead_of_the_display_id() {
        let mut record = DecisionRecord::default();
        record.record_answer(
            "a display id with no route prefix",
            &QuestionTarget::InferencePreset { route: 2 },
            false,
        );
        assert!(record.accepted_presets.contains(&2));
    }
}
