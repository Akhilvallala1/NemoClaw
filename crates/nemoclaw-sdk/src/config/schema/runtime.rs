// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Offline validators compiled once from the SDK contract, never from a deployment file.
use crate::config::{
    ConfigError, Document, RouteTuning,
    yaml_source::{self, escape},
};
use nemoclaw_runtime::schema::{select_variant, variant_keys};
use serde::Serialize;
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{Arc, LazyLock, Mutex},
};

static INPUT_SCHEMA: LazyLock<Value> = LazyLock::new(super::input_schema);
static INPUT: LazyLock<jsonschema::Validator> = LazyLock::new(|| compile(&INPUT_SCHEMA));
static NORMALIZED: LazyLock<Value> = LazyLock::new(|| super::build_schema(true));
static DOCUMENT: LazyLock<jsonschema::Validator> = LazyLock::new(|| compile(&NORMALIZED));
static DEFINITIONS: LazyLock<Mutex<BTreeMap<String, Arc<jsonschema::Validator>>>> =
    LazyLock::new(|| Mutex::new(BTreeMap::new()));
static TUNING_SCHEMA: LazyLock<Value> = LazyLock::new(|| {
    serde_json::to_value(schemars::schema_for!(RouteTuning)).expect("tuning schema")
});
static TUNING: LazyLock<jsonschema::Validator> = LazyLock::new(|| compile(&TUNING_SCHEMA));
static NAME: LazyLock<jsonschema::Validator> =
    LazyLock::new(|| compile(&INPUT_SCHEMA["$defs"]["Metadata"]["properties"]["name"]));
static FIELDS: LazyLock<BTreeSet<String>> = LazyLock::new(|| {
    fn collect(value: &Value, fields: &mut BTreeSet<String>) {
        if let Some(properties) = value["properties"].as_object() {
            fields.extend(properties.keys().cloned());
        }
        match value {
            Value::Object(object) => object.values().for_each(|value| collect(value, fields)),
            Value::Array(array) => array.iter().for_each(|value| collect(value, fields)),
            _ => {}
        }
    }
    let mut fields = BTreeSet::new();
    collect(&INPUT_SCHEMA, &mut fields);
    fields
});

fn compile(schema: &Value) -> jsonschema::Validator {
    jsonschema::validator_for(schema).expect("SDK configuration schema must compile")
}

fn check(
    validator: &jsonschema::Validator,
    value: &Value,
    schema: &Value,
    source: Option<&str>,
) -> Result<(), ConfigError> {
    validator
        .validate(value)
        .map_err(|error| diagnostic(&error, value, schema, source, ""))
}

/// `variant` is the schema location of the union variant that the input
/// selected on the way to this error, or empty when it selected none.
fn diagnostic(
    error: &jsonschema::ValidationError<'_>,
    root: &Value,
    schema: &Value,
    source: Option<&str>,
    variant: &str,
) -> ConfigError {
    use jsonschema::error::{TypeKind, ValidationErrorKind as Kind};
    let schema_path = error.schema_path().as_str();
    let union = match error.kind() {
        Kind::OneOfNotValid { context } | Kind::AnyOf { context } => schema
            .pointer(schema_path)
            .and_then(Value::as_array)
            .map(|variants| (variants, context)),
        _ => None,
    };
    // Select the variant the input names, so errors describe its fields rather than
    // unrelated alternatives. Never render rejected values or arbitrary map keys.
    if let Some((variants, context)) = union
        && let Some(index) = select_variant(variants, error.instance())
        && let Some(error) = context.get(index).and_then(|errors| errors.first())
    {
        let variant = format!("{schema_path}/{index}");
        return diagnostic(error, root, schema, source, &variant);
    }
    let keyed = union.and_then(|(variants, _)| variant_keys(variants));
    // A union of constants or bounds, such as a string choice, lists them.
    let scalar_choices = || {
        let (variants, _) = union?;
        let alternatives = variants
            .iter()
            .map(scalar_constraint)
            .collect::<Option<Vec<_>>>()?;
        Some(format!("must be {}", alternatives.join(" or ")))
    };
    let constraint = if let Some(message) = removed_fields(schema, error) {
        message
    } else if let Some(mut keys) = keyed {
        // The input named no single variant: list the declared keys, never the
        // input's, unless the union carries its own message. An enclosing
        // rule's message describes a different constraint.
        let own = schema_path
            .rsplit_once('/')
            .and_then(|(union, _)| schema.pointer(union)?.get("x-nemoclaw-error")?.as_str());
        own.map(str::to_owned).unwrap_or_else(|| {
            keys.sort_unstable();
            format!("must contain exactly one of: {}", keys.join(", "))
        })
    } else if let Some(message) = annotation(schema, error, variant) {
        message.to_owned()
    } else {
        match error.kind() {
            Kind::Enum { options } => format!("allowed values: {options}"),
            Kind::Constant { expected_value } => format!("must be {expected_value}"),
            Kind::Minimum { limit } => format!("must be at least {limit}"),
            Kind::Maximum { limit } => format!("must be at most {limit}"),
            Kind::MinItems { limit } => {
                format!("must have at least {}", count(*limit, "item", "items"))
            }
            Kind::MaxItems { limit } => {
                format!("must have at most {}", count(*limit, "item", "items"))
            }
            Kind::MinProperties { limit } => {
                format!("must have at least {}", count(*limit, "entry", "entries"))
            }
            Kind::MaxProperties { limit } => {
                format!("must have at most {}", count(*limit, "entry", "entries"))
            }
            Kind::Required { property } => format!("required field: {property}"),
            Kind::Pattern { pattern } => format!("required pattern: {pattern}"),
            // The rejected key is input, so only the rule it broke is shown.
            Kind::PropertyNames { error } => match error.kind() {
                Kind::Pattern { pattern } => format!("each name requires pattern: {pattern}"),
                _ => "names must be valid".into(),
            },
            Kind::Type {
                kind: TypeKind::Single(kind),
            } => format!("must be {kind}"),
            Kind::Type {
                kind: TypeKind::Multiple(kinds),
            } => format!(
                "must be {}",
                kinds
                    .iter()
                    .map(|kind| kind.to_string())
                    .collect::<Vec<_>>()
                    .join(" or ")
            ),
            Kind::AnyOf { .. } => scalar_choices()
                .unwrap_or_else(|| "must match an allowed combination of fields".into()),
            Kind::OneOfNotValid { .. } => {
                scalar_choices().unwrap_or_else(|| "must match one allowed object shape".into())
            }
            // A closed object without declared properties reports any field
            // as a false schema.
            Kind::AdditionalProperties { .. } | Kind::FalseSchema => {
                "unknown fields are not allowed".into()
            }
            _ => error.kind().keyword().to_owned(),
        }
    };
    let pointer = error.instance_path().to_string();
    let path = instance_path(&pointer, root);
    // A rejected name is located at its own key, though the path names only
    // its collection.
    let rejected_key = match error.kind() {
        Kind::PropertyNames { error } => error.instance().as_str().map(escape),
        _ => None,
    };
    let position = source
        .and_then(|text| match &rejected_key {
            Some(key) => yaml_source::position(text, &format!("{pointer}/{key}"), true),
            None => yaml_source::position(text, &pointer, false),
        })
        .map(|(line, column)| format!(" (line {line}, column {column})"))
        .unwrap_or_default();
    ConfigError(format!(
        "configuration violates schema at {path}{position}: {constraint}"
    ))
}

/// The message of the nearest annotated schema node enclosing the failing
/// keyword, so a rule built from nested `properties`, `items`, `allOf`, or
/// `then` steps keeps its explanation. A missing field prefers its own
/// annotation. Canonical schema locations never cross `$ref`, so the walk ends
/// at a definition root; it also ends at the selected variant's root, so a
/// union's message cannot hide a more specific error inside that variant.
fn annotation<'s>(
    schema: &'s Value,
    error: &jsonschema::ValidationError<'_>,
    variant: &str,
) -> Option<&'s str> {
    use jsonschema::error::ValidationErrorKind as Kind;
    let message = |pointer: &str| schema.pointer(pointer)?.get("x-nemoclaw-error")?.as_str();
    let path = error.schema_path().as_str();
    if let Kind::Required { property } = error.kind()
        && let (Some(object), Some(name)) = (path.strip_suffix("/required"), property.as_str())
        && let Some(found) = message(&format!("{object}/properties/{}", escape(name)))
    {
        return Some(found);
    }
    let floor = path
        .strip_prefix(variant)
        .filter(|rest| rest.is_empty() || rest.starts_with('/'))
        .map_or(0, |_| variant.len());
    let mut current = path;
    while let Some((parent, _)) = current.rsplit_once('/') {
        if parent.is_empty() || parent == "/$defs" || parent.len() < floor {
            break;
        }
        if let Some(found) = message(parent) {
            return Some(found);
        }
        current = parent;
    }
    None
}

/// The replacements for fields an earlier document shape accepted, when the
/// rejecting object lists them under `x-nemoclaw-removed-fields`, so an
/// earlier document gets every hint at once. `runtime` leads, since it chose
/// where the other fields now live; the rest follow the annotation's order.
/// Only the schema's text is rendered, never arbitrary input keys.
fn removed_fields(schema: &Value, error: &jsonschema::ValidationError<'_>) -> Option<String> {
    use jsonschema::error::ValidationErrorKind as Kind;
    let Kind::AdditionalProperties { unexpected } = error.kind() else {
        return None;
    };
    let object = error
        .schema_path()
        .as_str()
        .strip_suffix("/additionalProperties")?;
    let removed = schema
        .pointer(object)?
        .get("x-nemoclaw-removed-fields")?
        .as_object()?;
    let mut matched = removed
        .iter()
        .filter(|(field, _)| unexpected.contains(field))
        .filter_map(|(field, message)| Some((field.as_str(), message.as_str()?)))
        .collect::<Vec<_>>();
    matched.sort_by_key(|(field, _)| *field != "runtime");
    (!matched.is_empty()).then(|| {
        matched
            .into_iter()
            .map(|(_, message)| message)
            .collect::<Vec<_>>()
            .join("; ")
    })
}

fn count(limit: u64, one: &str, many: &str) -> String {
    if limit == 1 {
        format!("1 {one}")
    } else {
        format!("{limit} {many}")
    }
}

fn scalar_constraint(schema: &Value) -> Option<String> {
    if let Some(value) = schema.get("const") {
        return Some(value.to_string());
    }
    match (schema.get("minimum"), schema.get("maximum")) {
        (Some(minimum), Some(maximum)) => Some(format!("between {minimum} and {maximum}")),
        (Some(minimum), None) => Some(format!("at least {minimum}")),
        (None, Some(maximum)) => Some(format!("at most {maximum}")),
        _ => None,
    }
}

fn instance_path(pointer: &str, root: &Value) -> String {
    if pointer.is_empty() {
        return "document root".into();
    }
    let mut path = String::new();
    let mut current = root;
    let parts: Vec<_> = pointer
        .split('/')
        .skip(1)
        .map(|part| part.replace("~1", "/").replace("~0", "~"))
        .collect();
    for (offset, key) in parts.iter().enumerate() {
        if current.is_array()
            && let Ok(index) = key.parse::<usize>()
        {
            path.push_str(&format!("[{index}]"));
            current = &current[index];
        } else {
            // Only names in declared application collections can be shown. Invalid
            // names and opaque map keys remain hidden even if they resemble values.
            let named = match parts[..offset]
                .iter()
                .map(String::as_str)
                .collect::<Vec<_>>()
                .as_slice()
            {
                [
                    "spec",
                    "services" | "harnesses" | "inferences" | "integrations" | "inferenceProviders"
                    | "sandboxes",
                ] => true,
                [
                    "spec",
                    "sandboxes",
                    sandbox,
                    "harnesses" | "inferences" | "integrations" | "inferenceProviders",
                ]
                | ["spec", "sandboxes", sandbox, "agent", "integrations"] => {
                    NAME.is_valid(&Value::String((*sandbox).to_owned()))
                }
                _ => false,
            };
            let visible = if named {
                NAME.is_valid(&Value::String(key.clone()))
            } else {
                FIELDS.contains(key)
            };
            if !path.is_empty() {
                path.push('.');
            }
            path.push_str(if visible { key } else { "[entry]" });
            current = &current[key];
        }
    }
    path
}

fn value(value: &impl Serialize) -> Result<Value, ConfigError> {
    serde_json::to_value(value)
        .map_err(|_| ConfigError::new("cannot encode configuration for validation"))
}

pub(crate) fn validate_input(value: &Value, source: Option<&str>) -> Result<(), ConfigError> {
    check(&INPUT, value, &INPUT_SCHEMA, source)
}

pub(crate) fn validate_document(document: &Document) -> Result<(), ConfigError> {
    check(&DOCUMENT, &value(document)?, &NORMALIZED, None)
}

pub(crate) fn validate_definition(
    name: &'static str,
    object: &impl Serialize,
) -> Result<(), ConfigError> {
    validate_at(&format!("/$defs/{name}"), object)
}

pub(crate) fn validate_property(
    definition: &'static str,
    field: &'static str,
    object: &impl Serialize,
) -> Result<(), ConfigError> {
    validate_at(&format!("/$defs/{definition}/properties/{field}"), object)
}

fn validate_at(path: &str, object: &impl Serialize) -> Result<(), ConfigError> {
    let validator = {
        let mut cache = DEFINITIONS.lock().expect("schema validator cache");
        cache
            .entry(path.to_owned())
            .or_insert_with(|| {
                assert!(
                    NORMALIZED.pointer(path).is_some(),
                    "unknown schema path: {path}"
                );
                Arc::new(compile(&json!({
                    "$schema": NORMALIZED["$schema"],
                    "$defs": NORMALIZED["$defs"],
                    "$ref": format!("#{path}")
                })))
            })
            .clone()
    };
    check(&validator, &value(object)?, &NORMALIZED, None)
}

pub(crate) fn validate_service(
    kind: &'static str,
    service: &impl Serialize,
) -> Result<(), ConfigError> {
    let mut object = value(service)?;
    object["kind"] = json!(kind);
    validate_definition("ServiceDefinition", &object)
}

pub(crate) fn validate_tuning(tuning: &RouteTuning) -> Result<(), ConfigError> {
    check(&TUNING, &value(tuning)?, &TUNING_SCHEMA, None)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Field names come from the SDK schema, so diagnostics may show them.
    fn keyed(key: &str, schema: Value) -> Value {
        json!({"type": "object", "properties": {key: schema}, "required": [key], "additionalProperties": false})
    }

    fn targets() -> Value {
        json!({
            "type": "object",
            "properties": {"gateway": {"$ref": "#/$defs/Target"}},
            "$defs": {
                "Target": {"oneOf": [
                    keyed("docker", json!({"$ref": "#/$defs/Local"})),
                    keyed("podman", json!({"$ref": "#/$defs/Local"})),
                    keyed("kubernetes", json!({"$ref": "#/$defs/Cluster"})),
                ]},
                "Local": {
                    "type": "object",
                    "properties": {"engine": {"type": "string", "minLength": 1}},
                    "additionalProperties": false
                },
                "Cluster": {
                    "type": "object",
                    "properties": {
                        "endpoint": {"type": "string", "pattern": "^https://"},
                        "namespace": {"type": "string"}
                    },
                    "required": ["endpoint"],
                    "additionalProperties": false
                }
            }
        })
    }

    fn message(schema: &Value, instance: Value) -> String {
        check(&compile(schema), &instance, schema, None)
            .unwrap_err()
            .to_string()
    }

    #[test]
    fn an_error_inside_the_named_single_key_variant_names_its_field() {
        let error = message(
            &targets(),
            json!({"gateway": {"kubernetes": {"endpoint": "http://127.0.0.1:1"}}}),
        );
        assert_eq!(
            error,
            "configuration violates schema at gateway.kubernetes.endpoint: required pattern: ^https://"
        );
        let error = message(&targets(), json!({"gateway": {"kubernetes": {}}}));
        assert_eq!(
            error,
            r#"configuration violates schema at gateway.kubernetes: required field: "endpoint""#
        );
    }

    #[test]
    fn a_single_key_union_without_one_known_key_lists_the_declared_keys() {
        for instance in [
            json!({"PRIVATE_SENTINEL": {}}),
            json!({}),
            json!({"docker": {}, "podman": {}}),
            json!("PRIVATE_SENTINEL"),
        ] {
            let error = message(&targets(), json!({"gateway": instance}));
            assert_eq!(
                error,
                "configuration violates schema at gateway: must contain exactly one of: docker, kubernetes, podman",
                "{instance}"
            );
        }
    }

    #[test]
    fn a_single_key_union_prefers_its_own_annotation_when_no_key_selects_a_variant() {
        let mut schema = targets();
        schema["$defs"]["Target"]["x-nemoclaw-error"] = json!("gateway must name one target");
        let error = message(&schema, json!({"gateway": {"dokcer": {}}}));
        assert_eq!(
            error,
            "configuration violates schema at gateway: gateway must name one target"
        );
        assert!(!error.contains("dokcer"), "{error}");
        // The union's message does not hide an error inside the selected variant.
        schema["$defs"]["Target"]["oneOf"][2]["properties"]["kubernetes"] =
            schema["$defs"]["Cluster"].clone();
        let error = message(&schema, json!({"gateway": {"kubernetes": {"endpoint": 1}}}));
        assert_eq!(
            error,
            "configuration violates schema at gateway.kubernetes.endpoint: must be string"
        );
    }

    #[test]
    fn an_inline_single_key_union_without_one_known_key_ignores_annotated_ancestors() {
        let union = |annotation: Option<&str>| {
            let mut target = json!({"oneOf": [
                keyed("docker", json!({"type": "object"})),
                keyed("podman", json!({"type": "object"})),
            ]});
            if let Some(annotation) = annotation {
                target["x-nemoclaw-error"] = json!(annotation);
            }
            json!({
                "type": "object",
                "properties": {"gateway": {
                    "type": "object",
                    "properties": {"target": target},
                    "x-nemoclaw-error": "the gateway must name an endpoint"
                }}
            })
        };
        for target in [json!({"dokcer": {}}), json!({})] {
            let instance = json!({"gateway": {"target": target}});
            assert_eq!(
                message(&union(None), instance.clone()),
                "configuration violates schema at gateway.target: must contain exactly one of: docker, podman",
                "{instance}"
            );
            assert_eq!(
                message(&union(Some("the gateway names one target")), instance),
                "configuration violates schema at gateway.target: the gateway names one target"
            );
        }
    }

    #[test]
    fn a_nested_rule_reports_the_nearest_enclosing_annotation() {
        let schema = json!({
            "type": "object",
            "properties": {"gateway": {
                "type": "object",
                "properties": {"environment": {
                    "type": "array",
                    "items": {"type": "string", "not": {"const": "PATH"}},
                    "x-nemoclaw-error": "environment names must not shadow process controls"
                }},
                "if": {"required": ["namespace"]},
                "then": {
                    "properties": {"endpoint": {"pattern": "^https://"}},
                    "allOf": [{"not": {"required": ["engine"]}}],
                    "x-nemoclaw-error": "a cluster target requires HTTPS and excludes engine"
                }
            }}
        });
        for (instance, path, expected) in [
            (
                json!({"environment": ["PATH"]}),
                "gateway.environment[0]",
                "environment names must not shadow process controls",
            ),
            (
                json!({"namespace": "agents", "endpoint": "http://127.0.0.1:1"}),
                "gateway.endpoint",
                "a cluster target requires HTTPS and excludes engine",
            ),
            (
                json!({"namespace": "agents", "engine": "unix:///run/engine.sock"}),
                "gateway",
                "a cluster target requires HTTPS and excludes engine",
            ),
        ] {
            assert_eq!(
                message(&schema, json!({"gateway": instance})),
                format!("configuration violates schema at {path}: {expected}")
            );
        }
    }

    #[test]
    fn a_field_that_no_schema_allows_is_unknown() {
        let schema = json!({
            "type": "object",
            "properties": {"gateway": {"type": "object", "properties": {"target": false}}}
        });
        assert_eq!(
            message(&schema, json!({"gateway": {"target": {}}})),
            "configuration violates schema at gateway.target: unknown fields are not allowed"
        );
    }

    #[test]
    fn a_path_shows_collection_keys_only_when_they_are_names() {
        let entry = json!({
            "agent": {"inference": {"routes": [{"provider": {}}]}, "integrations": {"search": {}}},
            "harnesses": {"shared": {}},
            "inferenceProviders": {"own": {}, "Private-Sentinel": {}}
        });
        let root = json!({"spec": {
            "inferenceProviders": {"local": {}, "Private-Sentinel": {}},
            "sandboxes": {"assistant": entry.clone(), "Private-Sentinel": entry}
        }});
        for (pointer, expected) in [
            ("/spec/sandboxes", "spec.sandboxes"),
            (
                "/spec/sandboxes/assistant/agent",
                "spec.sandboxes.assistant.agent",
            ),
            (
                "/spec/sandboxes/assistant/agent/inference/routes/0/provider",
                "spec.sandboxes.assistant.agent.inference.routes[0].provider",
            ),
            (
                "/spec/inferenceProviders/local",
                "spec.inferenceProviders.local",
            ),
            (
                "/spec/sandboxes/assistant/inferenceProviders/own",
                "spec.sandboxes.assistant.inferenceProviders.own",
            ),
            (
                "/spec/sandboxes/assistant/harnesses/shared",
                "spec.sandboxes.assistant.harnesses.shared",
            ),
            (
                "/spec/sandboxes/assistant/agent/integrations/search",
                "spec.sandboxes.assistant.agent.integrations.search",
            ),
            (
                "/spec/inferenceProviders/Private-Sentinel",
                "spec.inferenceProviders.[entry]",
            ),
            (
                "/spec/sandboxes/assistant/inferenceProviders/Private-Sentinel",
                "spec.sandboxes.assistant.inferenceProviders.[entry]",
            ),
            (
                "/spec/sandboxes/Private-Sentinel/agent",
                "spec.sandboxes.[entry].agent",
            ),
            (
                "/spec/sandboxes/Private-Sentinel/harnesses/shared",
                "spec.sandboxes.[entry].harnesses.[entry]",
            ),
        ] {
            assert_eq!(instance_path(pointer, &root), expected, "{pointer}");
        }
    }

    #[test]
    fn a_collection_size_error_states_its_bound() {
        let schema = json!({
            "type": "object",
            "properties": {
                "routes": {"type": "array", "minItems": 1, "maxItems": 2},
                "services": {"type": "object", "minProperties": 2, "maxProperties": 1}
            }
        });
        for (instance, expected) in [
            (json!({"routes": []}), "routes: must have at least 1 item"),
            (
                json!({"routes": [1, 2, 3]}),
                "routes: must have at most 2 items",
            ),
            (
                json!({"services": {}}),
                "services: must have at least 2 entries",
            ),
            (
                json!({"services": {"a": 1, "b": 2}}),
                "services: must have at most 1 entry",
            ),
        ] {
            assert_eq!(
                message(&schema, instance),
                format!("configuration violates schema at {expected}")
            );
        }
    }

    #[test]
    fn a_missing_field_reports_its_own_annotation() {
        let schema = json!({
            "type": "object",
            "properties": {"gateway": {
                "type": "object",
                "properties": {
                    "engine": {"type": "string", "x-nemoclaw-error": "the engine names a local socket"},
                    "endpoint": {"type": "string"}
                },
                "required": ["engine", "endpoint"],
                "x-nemoclaw-error": "the gateway is incomplete"
            }}
        });
        assert_eq!(
            message(
                &schema,
                json!({"gateway": {"endpoint": "http://127.0.0.1:1"}})
            ),
            "configuration violates schema at gateway: the engine names a local socket"
        );
        assert_eq!(
            message(
                &schema,
                json!({"gateway": {"engine": "unix:///run/engine.sock"}})
            ),
            "configuration violates schema at gateway: the gateway is incomplete"
        );
    }
}
