// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Package-independent service installer input and output.

/// Escape OpenTofu template sequences in every string of `value`.
pub(crate) fn literal(value: &mut serde_json::Value) {
    match value {
        serde_json::Value::String(text) => *text = text.replace("${", "$${").replace("%{", "%%{"),
        serde_json::Value::Array(values) => values.iter_mut().for_each(literal),
        serde_json::Value::Object(values) => values.values_mut().for_each(literal),
        _ => {}
    }
}

/// OpenTofu stage that executes an installer plan.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum InstallStage {
    Runtime,
    Deployment,
}

/// Declarative install result. OpenTofu performs the mutations in dependency order.
#[derive(Default)]
pub(crate) struct InstallPlan {
    pub targets: Vec<crate::compile::Target>,
    pub dependencies: std::collections::BTreeMap<String, Vec<String>>,
    pub image_checks: std::collections::BTreeMap<String, crate::managed::ImageRequirements>,
    pub replacement_triggers: std::collections::BTreeMap<String, Vec<String>>,
}

impl InstallPlan {
    pub(crate) fn configure(&self, graph: &mut serde_json::Value) -> Result<(), crate::Error> {
        for (name, requirements) in &self.image_checks {
            let mut attributes: serde_json::Value = serde_json::from_str(&requirements.json()?)
                .map_err(|_| crate::Error::State("invalid installation image requirements"))?;
            literal(&mut attributes);
            attributes["allow_missing"] = serde_json::json!(false);
            graph["data"]["nemoclaw_runtime_image"][name] = attributes;
        }
        for (address, triggers) in &self.replacement_triggers {
            let (kind, name) = address.split_once('.').ok_or(crate::Error::State(
                "invalid installation replacement address",
            ))?;
            let attributes = graph["resource"]
                .get_mut(kind)
                .and_then(|r| r.get_mut(name))
                .ok_or(crate::Error::State(
                    "installation replacement target is absent",
                ))?;
            attributes["lifecycle"]["replace_triggered_by"] = serde_json::json!(triggers);
        }
        Ok(())
    }
}

/// Destroy-time policy returned by an installer.
#[derive(Default)]
pub(crate) struct RemovePlan {
    pub retained: Vec<String>,
    pub required_storage: Vec<(String, String)>,
}

/// A managed package supports declarative install and remove.
pub(crate) trait Installer {
    fn install(
        &self,
        document: &crate::config::Document,
        name: &str,
        generations: &crate::compile::Generations,
    ) -> Result<InstallPlan, crate::Error>;

    fn remove(
        &self,
        document: &crate::config::Document,
        name: &str,
        generations: &crate::compile::Generations,
    ) -> Result<RemovePlan, crate::Error>;
}
