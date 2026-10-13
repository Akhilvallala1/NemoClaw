// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Deployment question discovery from the SDK input schema.

use crate::{
    Diagnostics,
    diagnostics::diagnostic,
    journey_definition::sandbox_path,
    pointer::{escape, replace_entry_keys},
    sdk_schema::{finite_choices, sdk_field_schema_for},
    settings::SettingQuestion,
};
use nemoclaw_sdk::config::valid_name;
use serde_json::Value;

pub(crate) fn deployment_questions_for_values(
    values: &Value,
    active_harness: Option<&str>,
    active_routes: Option<&str>,
) -> Result<Vec<SettingQuestion>, Diagnostics> {
    let mut questions = Vec::new();
    let sandbox = sandbox_path(values);
    collect(values, values, "", sandbox.as_deref(), &mut questions, 0)?;
    questions.retain(|question| {
        let fields = fields(&question.path);
        (!fields.contains("/execution/")
            || active_harness
                .is_some_and(|base| question.path.starts_with(&format!("{base}/execution/"))))
            && (!fields.contains("/routes/")
                || active_routes.is_some_and(|base| question.path.starts_with(&format!("{base}/"))))
    });
    Ok(questions)
}

/// `path` with the names of sandboxes, services, harnesses, and other named
/// definitions replaced by `*`, so a check for a field never matches a name.
fn fields(path: &str) -> String {
    replace_entry_keys(path, |_| "*".into())
}

/// `path` relative to `sandbox`, the pointer to the journey's only sandbox, or
/// `None` when `path` is outside that sandbox.
fn in_sandbox<'a>(path: &'a str, sandbox: Option<&str>) -> Option<&'a str> {
    path.strip_prefix(sandbox?)
        .filter(|rest| rest.is_empty() || rest.starts_with('/'))
}

// These are deployment-owned editing regions, not a second description of their fields
// or constraints. Native settings and model/provider choices have separate owner views.
fn region(path: &str, sandbox: Option<&str>) -> bool {
    let fields = fields(path);
    path.starts_with("/spec/gateway/")
        || path.starts_with("/spec/services/")
        || in_sandbox(path, sandbox).is_some_and(|rest| {
            rest.starts_with("/image/")
                || rest.starts_with("/network/")
                || rest.starts_with("/agent/auth/")
                || rest.starts_with("/harness/execution/")
        })
        || (fields.contains("/routes/") && fields.ends_with("/overrides/maxTokens"))
        || (fields.contains("/harnesses/") && fields.contains("/execution/"))
}
fn excluded(path: &str) -> bool {
    let fields = fields(path);
    fields.ends_with("/management")
        || (path.starts_with("/spec/services/") && fields.ends_with("/kind"))
}
fn complex(path: &str, sandbox: Option<&str>) -> bool {
    (path.starts_with("/spec/services/") && fields(path).ends_with("/recipe"))
        || in_sandbox(path, sandbox) == Some("/network/policy")
}
fn collect(
    root: &Value,
    value: &Value,
    path: &str,
    sandbox: Option<&str>,
    out: &mut Vec<SettingQuestion>,
    depth: usize,
) -> Result<(), Diagnostics> {
    if depth > 48 {
        return Err(diagnostic(
            "deployment",
            "Deployment question depth exceeded.",
        ));
    }
    if value.is_null() || !interested(path, sandbox) {
        return Ok(());
    }
    if region(path, sandbox)
        && !excluded(path)
        && (!value.is_object() && !value.is_array() || complex(path, sandbox) || value.is_array())
    {
        let Some((schema, required)) = sdk_field_schema_for(root, path) else {
            // A `false` schema accepts no value, so the only answer is to omit
            // (remove) the supplied field.
            out.push(SettingQuestion {
                path: path.into(),
                title: Some(title(path)),
                description: Some(
                    "The SDK schema does not define this field. Omit it to remove the value."
                        .into(),
                ),
                required: false,
                schema: Value::Bool(false),
                choices: Vec::new(),
                suggestion: Some(value.clone()),
            });
            return Ok(());
        };
        let mut choices = finite_choices(&schema);
        if choices.is_empty() && schema["type"] == "boolean" {
            choices = vec![Value::Bool(false), Value::Bool(true)];
        }
        out.push(SettingQuestion {
            path: path.into(),
            title: Some(title(path)),
            description: schema["description"].as_str().map(Into::into),
            required,
            schema,
            choices,
            suggestion: Some(value.clone()),
        });
        return Ok(());
    }
    if let Some(object) = value.as_object() {
        for (key, child) in object {
            collect(
                root,
                child,
                &format!("{path}/{}", escape(key)),
                sandbox,
                out,
                depth + 1,
            )?;
        }
    } else if let Some(array) = value.as_array() {
        for (index, child) in array.iter().enumerate() {
            collect(
                root,
                child,
                &format!("{path}/{index}"),
                sandbox,
                out,
                depth + 1,
            )?;
        }
    }
    Ok(())
}

fn title(path: &str) -> String {
    fn words(value: &str) -> String {
        let mut result = String::new();
        let mut previous_lower = false;
        for ch in value.chars() {
            if ch.is_uppercase() && previous_lower {
                result.push(' ');
            }
            result.push(ch);
            previous_lower = ch.is_lowercase();
        }
        result
    }
    // A key the SDK rejects as a name is not shown.
    let path = replace_entry_keys(path, |key| {
        if valid_name(key) { key } else { "[entry]" }.to_owned()
    });
    let parts: Vec<_> = path.split('/').filter(|part| !part.is_empty()).collect();
    let (prefix, rest) = if parts.get(1) == Some(&"gateway") {
        ("Gateway".to_owned(), &parts[2..])
    } else if parts.get(1) == Some(&"services") {
        (
            format!("Service {}", parts.get(2).unwrap_or(&"")),
            &parts[3..],
        )
    } else if parts.get(1) == Some(&"sandboxes") {
        ("Agent".to_owned(), &parts[3..])
    } else {
        ("Deployment".to_owned(), &parts[1..])
    };
    format!(
        "{prefix}: {}",
        rest.iter()
            .filter(|part| !matches!(**part, "agent" | "harness") && part.parse::<usize>().is_err())
            .map(|part| words(part))
            .collect::<Vec<_>>()
            .join(" / ")
    )
}

fn interested(path: &str, sandbox: Option<&str>) -> bool {
    let fields = fields(path);
    // A path is inside a root or an ancestor that leads to one.
    let near = |root: &str| {
        path == root
            || path.starts_with(&format!("{root}/"))
            || root.starts_with(&format!("{path}/"))
    };
    ([
        "/spec/gateway",
        "/spec/services",
        "/spec/inferences",
        "/spec/harnesses",
    ]
    .into_iter()
    .any(near)
        || sandbox.is_some_and(|sandbox| {
            [
                "/image",
                "/network",
                "/agent/auth",
                "/harness/execution",
                "/agent/inference",
                "/inferences",
                "/harnesses",
            ]
            .into_iter()
            .any(|region| near(&format!("{sandbox}{region}")))
        }))
        && !fields.contains("/settings")
        && !fields.contains("/config")
}

#[cfg(test)]
mod tests {
    use super::title;

    #[test]
    fn a_title_shows_a_definition_key_only_when_it_is_a_name() {
        for (path, expected) in [
            (
                "/spec/services/qwen/serving/port",
                "Service qwen: serving / port",
            ),
            (
                "/spec/services/PRIVATE INVALID NAME/image",
                "Service [entry]: image",
            ),
            (
                "/spec/harnesses/PRIVATE INVALID NAME/execution/timeoutSeconds",
                "Deployment: harnesses / [entry] / execution / timeout Seconds",
            ),
        ] {
            assert_eq!(title(path), expected);
        }
    }
}
