// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::*;

pub(super) fn native_value<'a>(
    values: &'a Value,
    selected_route: Option<usize>,
    id: &str,
) -> Option<&'a Value> {
    if let Some(path) = id.strip_prefix("workflow:") {
        values.pointer(&format!("{}/config/workflow{path}", harness_path(values)?))
    } else if let Some(path) = id.strip_prefix("model:") {
        values.pointer(&format!(
            "{}/{}/overrides/settings{path}",
            routes_path(values)?,
            selected_route?
        ))
    } else {
        None
    }
}

pub(super) fn routes_path(values: &Value) -> Option<String> {
    let sandbox = sandbox_path(values)?;
    let agent = values.pointer(&format!("{sandbox}/agent"))?;
    if agent.get("inference").is_some() {
        return Some(format!("{sandbox}/agent/inference/routes"));
    }
    let reference = agent.get("inferenceRef")?.as_str()?;
    let path = format!("/spec/inferences/{}/routes", escape(reference));
    values.pointer(&path).is_some().then_some(path)
}

pub(super) fn harness_path(values: &Value) -> Option<String> {
    let path = sandbox_path(values)?;
    let sandbox = values.pointer(&path)?;
    if let Some(reference) = sandbox.get("harnessRef").and_then(Value::as_str) {
        let path = format!("/spec/harnesses/{}", escape(reference));
        return values.pointer(&path).is_some().then_some(path);
    }
    sandbox
        .get("harness")
        .is_some()
        .then(|| format!("{path}/harness"))
}

pub(super) fn harness_kind(values: &Value) -> Option<&str> {
    values
        .pointer(&format!("{}/kind", harness_path(values)?))
        .and_then(Value::as_str)
}

pub(super) fn settings_path(values: &Value) -> Option<String> {
    harness_path(values).map(|path| format!("{path}/settings"))
}

/// The managed gateway's target key and the pointer to its engine, when the
/// selected target runs on a local engine. A cluster target has no engine.
pub(super) fn managed_target_engine(values: &Value) -> Option<(String, String)> {
    if values
        .pointer("/spec/gateway/management")
        .and_then(Value::as_str)
        != Some("managed")
    {
        return None;
    }
    let [key] = values
        .pointer(GATEWAY_TARGET)?
        .as_object()?
        .keys()
        .collect::<Vec<_>>()[..]
    else {
        return None;
    };
    let engine = format!("{GATEWAY_TARGET}/{}/engine", escape(key));
    sdk_field_schema_for(values, &engine).map(|_| (key.clone(), engine))
}

pub(super) fn scalar_question(schema: &Value, choices: &[Value]) -> bool {
    matches!(
        schema["type"].as_str(),
        Some("string" | "number" | "integer" | "boolean")
    ) || !choices.is_empty()
}
