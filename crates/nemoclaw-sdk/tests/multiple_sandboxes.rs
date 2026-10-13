// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use nemoclaw_sdk::{
    compile::{Generations, compile},
    config::Document,
};
use serde_json::{Value, json};

fn generations() -> Generations {
    [
        "workspace",
        "provider",
        "sandbox",
        "ollama",
        "managed_gateway",
        "inference_service",
    ]
    .map(|name| (name.into(), "a".repeat(32)))
    .into()
}
fn example() -> Value {
    serde_saphyr::from_str(include_str!("../../../examples/fabric-openclaw.yaml")).unwrap()
}
fn graph(value: &Value) -> Value {
    compiled(&value.to_string())
}
fn compiled(text: &str) -> Value {
    compile(
        &Document::parse(text.as_bytes()).unwrap(),
        &generations(),
        "0.1.0",
    )
    .unwrap()
}
#[test]
fn different_adapters_separate_provider_grants() {
    let mut value = example();
    let mut other = value["spec"]["sandboxes"]["assistant"].clone();
    other["harness"] = json!({"kind":"deepagents"});
    value["spec"]["sandboxes"]["research"] = other;
    assert!(
        jsonschema::validator_for(&nemoclaw_sdk::config::schema::input_schema())
            .unwrap()
            .is_valid(&value)
    );
    let before = graph(&value);
    assert_eq!(
        before["resource"]["openshell_sandbox"]
            .as_object()
            .unwrap()
            .len(),
        2
    );
    assert_eq!(
        before["resource"]["openshell_provider_registration"]
            .as_object()
            .unwrap()
            .len(),
        2
    );
}

#[test]
fn sandbox_local_provider_and_inference_names_do_not_escape_their_scope() {
    let mut value = example();
    let providers = value["spec"]
        .as_object_mut()
        .unwrap()
        .remove("inferenceProviders")
        .unwrap();
    value["spec"]["sandboxes"]["assistant"]["inferenceProviders"] = providers;
    let mut other = value["spec"]["sandboxes"]["assistant"].clone();
    other["inferenceProviders"]["local"]["endpoint"] = json!("http://172.20.0.1:11447/v1");
    value["spec"]["sandboxes"]["other"] = other;
    let before = graph(&value);
    let providers = before["resource"]["openshell_provider_registration"]
        .as_object()
        .unwrap();
    assert_eq!(providers.len(), 2);
    assert_ne!(
        providers.values().next().unwrap()["name"],
        providers.values().next_back().unwrap()["name"]
    );
}

#[test]
fn adding_a_sandbox_preserves_existing_resource_addresses_and_values() {
    let mut value = example();
    let before = graph(&value);
    value["spec"]["sandboxes"]["additional"] = value["spec"]["sandboxes"]["assistant"].clone();
    let after = graph(&value);
    for (kind, instances) in before["resource"].as_object().unwrap() {
        for (name, instance) in instances.as_object().unwrap() {
            let mut prior = instance.clone();
            let mut next = after["resource"][kind][name].clone();
            // Adding an earlier sandbox changes the discovery expression; its resolved image metadata is identical.
            for field in ["runtime_json", "binaries_json"] {
                prior.as_object_mut().unwrap().remove(field);
                next.as_object_mut().unwrap().remove(field);
            }
            assert_eq!(prior, next);
        }
    }
}

#[test]
fn reversed_sandbox_and_provider_keys_parse_to_the_same_document_and_digest() {
    let mut value = example();
    let mut other = value["spec"]["sandboxes"]["assistant"].clone();
    let mut provider = value["spec"]["inferenceProviders"]["local"].clone();
    provider["endpoint"] = json!("http://172.20.0.1:11447/v1");
    value["spec"]["inferenceProviders"]["other-models"] = provider;
    other["agent"]["inference"]["routes"][0]["providerRef"] = json!("other-models");
    value["spec"]["sandboxes"]["bob"] = other;
    let document = Document::parse(value.to_string().as_bytes()).unwrap();
    let reversed =
        crate::support::reversed(&value, &["/spec/sandboxes", "/spec/inferenceProviders"]);
    let reversed = Document::parse(reversed.as_bytes()).unwrap();
    assert_eq!(document, reversed);
    assert_eq!(document.digest(), reversed.digest());
}

#[test]
fn five_agent_example_compiles_to_five_independent_sandboxes_sharing_inference() {
    let value: Value =
        serde_saphyr::from_str(include_str!("../../../examples/multiple-sandboxes.yaml")).unwrap();
    assert!(
        jsonschema::validator_for(&nemoclaw_sdk::config::schema::input_schema())
            .unwrap()
            .is_valid(&value)
    );
    let document = Document::parse(value.to_string().as_bytes()).unwrap();
    assert_eq!(
        Document::parse(document.yaml().unwrap().as_bytes()).unwrap(),
        document
    );
    let rows = nemoclaw_sdk::compile::targets(&document, &generations()).unwrap();
    let sandboxes: Vec<_> = rows.iter().filter(|row| row.kind == "sandbox").collect();
    assert_eq!(sandboxes.len(), 5);
    assert_eq!(rows.iter().filter(|row| row.kind == "provider").count(), 3);
    let mut counts = std::collections::BTreeMap::new();
    for (name, sandbox) in &document.spec.sandboxes {
        let harness = document.sandbox_harness(name).unwrap();
        *counts.entry(harness.kind.as_str()).or_insert(0) += 1;
        let row = sandboxes
            .iter()
            .find(|row| &row.values["name"] == name)
            .unwrap();
        let configuration = rows
            .iter()
            .find(|candidate| {
                candidate.kind == "agent_configuration" && &candidate.values["name"] == name
            })
            .unwrap();
        let settings: Value = serde_json::from_str(&configuration.values["config_json"]).unwrap();
        assert_eq!(settings["metadata"]["name"], sandbox.agent.name);
        assert_eq!(row.values["agent_name"], sandbox.agent.name);
    }
    assert_eq!(
        counts,
        [
            ("nvidia.fabric.openclaw", 2),
            ("nvidia.fabric.langchain.deepagents", 2),
            ("nvidia.fabric.pi", 1)
        ]
        .into()
    );
}

#[test]
fn managed_discovery_compiles_a_second_sandbox_with_another_adapter() {
    let mut value: Value =
        serde_saphyr::from_str(include_str!("../../../examples/onboarding/openclaw.yaml")).unwrap();
    let mut other = value["spec"]["sandboxes"]["assistant"].clone();
    other["harness"] = json!({"kind":"deepagents"});
    value["spec"]["sandboxes"]["research"] = other;
    graph(&value);
}
