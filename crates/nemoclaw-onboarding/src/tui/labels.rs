// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use nemoclaw_authoring::{
    JourneyQuestion, JourneyQuestionKind, ProviderPreset, mask_entry_keys, replace_entry_keys,
};
use serde::Deserialize;
use serde_json::Value;
use std::{collections::BTreeMap, sync::OnceLock};

#[derive(Default, Deserialize)]
struct Text {
    #[serde(default)]
    questions: BTreeMap<String, QuestionText>,
    #[serde(default)]
    choices: BTreeMap<String, BTreeMap<String, String>>,
}

#[derive(Default, Deserialize)]
struct QuestionText {
    title: Option<String>,
    description: Option<String>,
}

/// Friendly text for questions and choices from `text.json`, keyed by
/// question ID with `*` standing for array indices, sandbox, provider, and
/// service names, gateway target keys, and adapter IDs. Entries
/// override the titles and descriptions advertised by the SDK and Fabric
/// schemas. Describe Fabric adapter and model settings in the Fabric adapter
/// descriptors instead, so every client receives the same text.
fn text() -> &'static Text {
    static TEXT: OnceLock<Text> = OnceLock::new();
    TEXT.get_or_init(|| {
        serde_json::from_str(include_str!("text.json")).expect("valid TUI text map")
    })
}

/// Map keys for a question ID, most specific first: the ID itself, then with
/// array indices, the names of sandboxes, providers, services, and other named
/// definitions, and the gateway target key replaced by `*`, then also the
/// adapter ID. A key is a name only by its position in the ID.
fn keys(id: &str) -> [String; 3] {
    let named = replace_entry_keys(id, |_| "*".into());
    let parts = named.split('/').collect::<Vec<_>>();
    let indices = parts
        .iter()
        .enumerate()
        .map(|(index, part)| {
            let target = index == 4 && parts[1..4] == ["spec", "gateway", "target"];
            if target || (!part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit())) {
                "*"
            } else {
                part
            }
        })
        .collect::<Vec<_>>()
        .join("/");
    let adapter = match indices
        .strip_prefix("adapter:")
        .and_then(|rest| rest.split_once(':'))
    {
        Some((_, pointer)) => format!("adapter:*:{pointer}"),
        None => indices.clone(),
    };
    [id.to_owned(), indices, adapter]
}

fn question_text(id: &str) -> Option<&'static QuestionText> {
    keys(id).iter().find_map(|key| text().questions.get(key))
}

/// Map text first, then the schema's title, then a label derived from the ID.
pub(super) fn title(question: &JourneyQuestion) -> String {
    question_text(question.id())
        .and_then(|text| text.title.clone())
        .or_else(|| question.title().map(str::to_owned))
        .unwrap_or_else(|| label(question))
}

/// Map text first, then the schema's description.
pub(super) fn description(question: &JourneyQuestion) -> Option<String> {
    question_text(question.id())
        .and_then(|text| text.description.clone())
        .or_else(|| question.description().map(str::to_owned))
}

pub(super) fn choice(question: &JourneyQuestion, value: &Value) -> String {
    let mapped = value.as_str().and_then(|value| {
        keys(question.id())
            .iter()
            .find_map(|key| text().choices.get(key)?.get(value).cloned())
    });
    mapped
        .or_else(|| {
            (question.id() == "inference:preset")
                .then(|| {
                    ProviderPreset::from_id(value.as_str()?).map(|preset| preset.label().to_owned())
                })
                .flatten()
        })
        .unwrap_or_else(|| display_value(value))
}

/// NemoClaw-owned questions need a title and description from the map or
/// schema. Fabric adapter and model settings are described upstream.
#[cfg(test)]
pub(super) fn missing_text(question: &JourneyQuestion) -> Option<&'static str> {
    let id = question.id();
    if id.starts_with("adapter:") || id.starts_with("model:") || id.starts_with("workflow:") {
        return None;
    }
    if question_text(id)
        .and_then(|text| text.title.as_ref())
        .is_none()
        && question.title().is_none()
    {
        Some("title")
    } else if description(question).is_none() {
        Some("description")
    } else {
        None
    }
}

pub(super) fn display_value(value: &Value) -> String {
    value
        .as_str()
        .map_or_else(|| value.to_string(), str::to_owned)
}

pub(super) fn label(question: &JourneyQuestion) -> String {
    let id = question.id();
    if id.starts_with("adapter:") && id.ends_with(':') {
        return "Adapter settings".into();
    }
    if question.kind() == JourneyQuestionKind::StructuralForm {
        return format!(
            "Choose {} form",
            id.rsplit('/').next().unwrap_or("configuration")
        );
    }
    readable(id)
}

/// `adapter:x:/interfaces/dashboard/port` reads as "Dashboard: port".
fn readable(id: &str) -> String {
    let id = mask_entry_keys(id);
    let pointer = id
        .rsplit_once(':')
        .map_or(id.as_str(), |(_, pointer)| pointer);
    let mut parts = pointer
        .split('/')
        .filter(|part| !part.is_empty() && !part.bytes().all(|byte| byte.is_ascii_digit()))
        .map(words);
    let last = parts.next_back().unwrap_or_else(|| words(&id));
    match parts.next_back() {
        Some(parent) if !matches!(parent.as_str(), "Spec" | "Settings") => {
            acronyms(&format!("{parent}: {}", last.to_lowercase()))
        }
        _ => last,
    }
}

/// Keep acronyms upper case: "Cli" and "base url" read as "CLI" and "base URL".
fn acronyms(text: &str) -> String {
    text.split(' ')
        .map(|word| {
            if matches!(
                word.to_lowercase().as_str(),
                "api"
                    | "cidr"
                    | "cli"
                    | "cpu"
                    | "gpu"
                    | "id"
                    | "ipc"
                    | "kv"
                    | "sdk"
                    | "tui"
                    | "url"
                    | "usd"
            ) {
                word.to_uppercase()
            } else {
                word.to_owned()
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// `timeout_seconds` and `networkCidr` become "Timeout seconds" and "Network CIDR".
fn words(part: &str) -> String {
    let mut text = String::new();
    let mut previous_lower = false;
    for character in part.chars() {
        if matches!(character, '_' | '-') {
            text.push(' ');
            previous_lower = false;
            continue;
        }
        if character.is_uppercase() && previous_lower {
            text.push(' ');
        }
        previous_lower = character.is_lowercase();
        text.push(character);
    }
    let mut characters = text.chars();
    acronyms(
        &characters
            .next()
            .map(|first| first.to_uppercase().chain(characters).collect::<String>())
            .unwrap_or_default(),
    )
}

/// The managed service a question belongs to, shown under its title.
pub(super) fn service(question: &JourneyQuestion) -> Option<String> {
    let id = mask_entry_keys(question.id());
    let name = id.strip_prefix("/spec/services/")?.split('/').next()?;
    Some(name.to_owned())
}

// External labels stay unchanged in authored values; escape them only for the terminal.
pub(super) fn terminal_text(value: &str) -> String {
    value
        .chars()
        .flat_map(|character| {
            if character.is_control()
                || matches!(character, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
            {
                character.escape_default().collect::<Vec<_>>()
            } else {
                vec![character]
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::{keys, readable};

    #[test]
    fn map_keys_generalize_indices_collection_keys_and_adapters() {
        assert_eq!(
            keys("/spec/sandboxes/assistant/agent/inference/routes/1/name")[1],
            "/spec/sandboxes/*/agent/inference/routes/*/name"
        );
        assert_eq!(
            keys("form:/spec/sandboxes/assistant/agent")[1],
            "form:/spec/sandboxes/*/agent"
        );
        assert_eq!(
            keys("/spec/inferenceProviders/nvidia-prod/api")[1],
            "/spec/inferenceProviders/*/api"
        );
        assert_eq!(
            keys("/spec/sandboxes/assistant/inferenceProviders/own/endpoint")[1],
            "/spec/sandboxes/*/inferenceProviders/*/endpoint"
        );
        assert_eq!(
            keys("/spec/services/qwen/serving/port")[1],
            "/spec/services/*/serving/port"
        );
        assert_eq!(
            keys("/spec/gateway/target/podman/engine")[1],
            "/spec/gateway/target/*/engine"
        );
        // The target key question itself names no key.
        assert_eq!(keys("/spec/gateway/target")[1], "/spec/gateway/target");
        // Only a key's position makes it a name; a name can equal a field.
        assert_eq!(
            keys("/spec/sandboxes/services/image/ref")[1],
            "/spec/sandboxes/*/image/ref"
        );
        assert_eq!(
            keys("/spec/sandboxes/target/inferenceProviders/sandboxes/endpoint")[1],
            "/spec/sandboxes/*/inferenceProviders/*/endpoint"
        );
        assert_eq!(
            keys("adapter:x:/services/port")[1],
            "adapter:x:/services/port"
        );
        assert_eq!(
            keys("/spec/gateway/kubernetes/target/endpoint")[1],
            "/spec/gateway/kubernetes/target/endpoint"
        );
        assert_eq!(
            keys("adapter:nvidia.fabric.openclaw:/native_config/cron")[2],
            "adapter:*:/native_config/cron"
        );
    }

    #[test]
    fn generated_titles_are_readable() {
        assert_eq!(readable("adapter:x:/timeout_seconds"), "Timeout seconds");
        assert_eq!(
            readable("adapter:x:/interfaces/dashboard/port"),
            "Dashboard: port"
        );
        assert_eq!(readable("adapter:x:/base_url"), "Base URL");
        assert_eq!(readable("adapter:x:/cli"), "CLI");
        assert_eq!(
            readable("/spec/gateway/target/docker/networkCidr"),
            "Docker: network CIDR"
        );
        assert_eq!(
            readable("/spec/inferenceProviders/PRIVATE INVALID NAME/endpoint"),
            "[entry]: endpoint"
        );
    }
}
