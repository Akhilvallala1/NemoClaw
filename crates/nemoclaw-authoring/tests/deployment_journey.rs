// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use nemoclaw_authoring::{
    Capabilities, JourneyDefinition, JourneyQuestionReason, JourneyScope, PartialDocument,
};
use nemoclaw_sdk::config::Document;
use serde_json::{Value, json};
use std::collections::BTreeSet;

fn example(name: &str) -> PartialDocument {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../examples")
        .join(name);
    PartialDocument::from_yaml(&std::fs::read(path).unwrap()).unwrap()
}

fn journey(name: &str) -> nemoclaw_authoring::JourneyState {
    let capabilities = Capabilities::available();
    JourneyDefinition::new(name, example(name))
        .ask([JourneyScope::DeploymentFields])
        .start(&capabilities)
        .unwrap()
}

#[test]
fn supplied_deployment_field_is_asked_before_unrelated_required_answers() {
    let capabilities = Capabilities::available();
    let mut supplied = PartialDocument::from_yaml(include_bytes!("fixtures/minimum-inline.yaml"))
        .unwrap()
        .supplied()
        .clone();
    supplied["spec"]["gateway"] = json!({
        "management": "external",
        "endpoint": "http://127.0.0.1:19001"
    });
    let base = PartialDocument::from_yaml(supplied.to_string().as_bytes()).unwrap();
    let mut state = JourneyDefinition::new("sparse-deployment", base)
        .ask([JourneyScope::DeploymentFields])
        .start(&capabilities)
        .unwrap();
    let path = "/spec/gateway/endpoint";
    let resolution = state.resolve(&capabilities).unwrap();
    assert!(resolution.assessment().document().is_none());
    let question = resolution
        .question(path)
        .expect("supplied endpoint question");
    assert_eq!(question.reason(), JourneyQuestionReason::ExplicitAsk);
    assert_eq!(
        question.suggestion(),
        Some(&json!("http://127.0.0.1:19001"))
    );
    state
        .answer(&capabilities, path, Some(json!("http://127.0.0.1:19002")))
        .unwrap();
    assert_eq!(
        state.values().pointer(path),
        Some(&json!("http://127.0.0.1:19002"))
    );
}

#[test]
fn unknown_supplied_deployment_field_can_be_removed() {
    let capabilities = Capabilities::available();
    let mut supplied = example("onboarding/openclaw.yaml").supplied().clone();
    supplied["spec"]["gateway"]["target"]["docker"]["enginee"] =
        json!("unix:///var/run/docker.sock");
    let base = PartialDocument::from_yaml(supplied.to_string().as_bytes()).unwrap();
    let mut state = JourneyDefinition::new("unknown-deployment-field", base)
        .ask([JourneyScope::DeploymentFields])
        .start(&capabilities)
        .unwrap();
    let path = "/spec/gateway/target/docker/enginee";
    let question = state
        .resolve(&capabilities)
        .unwrap()
        .question(path)
        .cloned()
        .expect("unknown field question");
    assert_eq!(question.reason(), JourneyQuestionReason::InvalidSupplied);
    assert!(!question.required());
    assert!(state.answer(&capabilities, path, Some(json!("x"))).is_err());
    state.answer(&capabilities, path, None).unwrap();
    assert_eq!(state.values().pointer(path), None);
    assert!(
        state
            .resolve(&capabilities)
            .unwrap()
            .assessment()
            .document()
            .is_some()
    );
}

#[test]
fn deployment_questions_carry_titles_and_sdk_descriptions() {
    let capabilities = Capabilities::available();
    let resolution = journey("fabric-pi.yaml").resolve(&capabilities).unwrap();
    let endpoint = resolution
        .question("/spec/gateway/endpoint")
        .expect("gateway endpoint question");
    assert_eq!(endpoint.title(), Some("Gateway: endpoint"));
    assert_eq!(
        endpoint.description(),
        Some("Gateway HTTP(S) origin, without a path.")
    );
}

#[test]
fn external_gateway_questions_preserve_deployment_and_reject_invalid_or_stale_answers() {
    let capabilities = Capabilities::available();
    let mut state = journey("fabric-pi.yaml");
    let resolution = state.resolve(&capabilities).unwrap();
    assert!(resolution.question("/spec/gateway/endpoint").is_some());
    assert!(
        resolution
            .question("/spec/gateway/target/docker/engine")
            .is_none()
    );
    assert!(resolution.question("/metadata/uid").is_none());
    let before = state.values().clone();
    assert!(
        state
            .answer(&capabilities, "/metadata/uid", Some(json!("bad")))
            .is_err()
    );
    assert!(
        state
            .answer(
                &capabilities,
                "/spec/gateway/endpoint",
                Some(json!("invalid-url"))
            )
            .is_err()
    );
    assert_eq!(state.values(), &before);
    state
        .answer(
            &capabilities,
            "/spec/gateway/endpoint",
            Some(json!("http://127.0.0.1:19001")),
        )
        .unwrap();
    let mut expected = before;
    expected["spec"]["gateway"]["endpoint"] = json!("http://127.0.0.1:19001");
    assert_eq!(state.values(), &expected);
}

#[test]
fn managed_service_questions_use_sdk_types_and_keep_recipe_as_one_value() {
    let capabilities = Capabilities::available();
    let mut state = journey("spark/remote-vllm.yaml");
    let resolution = state.resolve(&capabilities).unwrap();
    for path in [
        "/spec/services/qwen/placement/engine",
        "/spec/services/qwen/publication/endpoint",
        "/spec/services/qwen/model/revision",
        "/spec/services/qwen/serving/contextTokens",
        "/spec/services/qwen/memory/gpuMemoryGiB",
    ] {
        assert!(resolution.question(path).is_some(), "missing {path}");
    }
    let before = state.values().clone();
    let path = "/spec/services/qwen/serving/contextTokens";
    assert!(state.answer(&capabilities, path, Some(json!(-1))).is_err());
    assert_eq!(state.values(), &before);

    let recipe = journey("spark/spark-inline.yaml");
    let resolution = recipe.resolve(&capabilities).unwrap();
    let recipes = resolution
        .questions()
        .iter()
        .filter(|question| question.id().contains("/recipe"))
        .collect::<Vec<_>>();
    assert_eq!(recipes.len(), 1);
    assert!(recipes[0].schema().get("$defs").is_some());
    assert!(recipes[0].suggestion().unwrap().is_object());
}

#[test]
fn optional_supplied_deployment_field_can_be_omitted_through_the_shared_question() {
    let capabilities = Capabilities::available();
    let mut supplied = example("onboarding/openclaw.yaml").supplied().clone();
    supplied["spec"]["gateway"]["target"]["docker"]["imagePullPolicy"] = json!("Never");
    let base = PartialDocument::from_yaml(supplied.to_string().as_bytes()).unwrap();
    let mut state = JourneyDefinition::new("optional-deployment", base)
        .ask([JourneyScope::DeploymentFields])
        .start(&capabilities)
        .unwrap();
    let path = "/spec/gateway/target/docker/imagePullPolicy";
    let resolution = state.resolve(&capabilities).unwrap();
    let question = resolution.question(path).expect("deployment question");
    assert!(!question.required());
    assert_eq!(question.suggestion(), Some(&json!("Never")));

    state.answer(&capabilities, path, None).unwrap();
    assert!(state.values().pointer(path).is_none());
    assert!(
        state
            .resolve(&capabilities)
            .unwrap()
            .assessment()
            .document()
            .is_some()
    );
}

#[test]
fn deployment_questions_follow_the_selected_sdk_hardware_form() {
    let capabilities = Capabilities::available();
    let dedicated = journey("nemotron-amd64.yaml");
    let question = dedicated
        .resolve(&capabilities)
        .unwrap()
        .question("/spec/services/nemotron/hardware/architecture")
        .cloned()
        .expect("dedicated hardware architecture question");
    assert!(question.required());
    assert_eq!(question.choices(), &[json!("amd64")]);

    let profiled = journey("spark/remote-vllm.yaml");
    let question = profiled
        .resolve(&capabilities)
        .unwrap()
        .question("/spec/services/qwen/hardware/profile")
        .cloned()
        .expect("profiled hardware question");
    assert!(question.required());
    assert_eq!(question.suggestion(), Some(&json!("dgx-spark")));
}

#[test]
fn single_sandbox_examples_offer_existing_sdk_values_without_changing_them() {
    fn files(root: &std::path::Path, result: &mut Vec<std::path::PathBuf>) {
        for entry in std::fs::read_dir(root).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                files(&path, result);
            } else if path
                .extension()
                .is_some_and(|ext| ext == "yaml" || ext == "yml")
            {
                result.push(path);
            }
        }
    }
    let capabilities = Capabilities::available();
    let mut paths = Vec::new();
    files(
        &std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../examples"),
        &mut paths,
    );
    let mut covered = 0;
    for path in paths {
        let bytes = std::fs::read(&path).unwrap();
        let document = Document::parse(bytes.as_slice()).unwrap();
        if document.spec.sandboxes.len() != 1 {
            continue;
        }
        let base = PartialDocument::from_yaml(&bytes).unwrap();
        let mut state = JourneyDefinition::new("example", base)
            .ask([JourneyScope::DeploymentFields])
            .start(&capabilities)
            .unwrap();
        let before = serde_json::to_value(&document).unwrap();
        let resolution = state.resolve(&capabilities).unwrap();
        let questions = resolution
            .questions()
            .iter()
            .filter(|question| {
                question.reason() == JourneyQuestionReason::ExplicitAsk
                    && question.id().starts_with('/')
            })
            .collect::<Vec<_>>();
        assert!(!questions.is_empty(), "{}", path.display());
        for question in &questions {
            assert_eq!(question.suggestion(), before.pointer(question.id()));
            assert_eq!(
                nemoclaw_sdk::json_schema::schema_accepts(
                    question.schema(),
                    question.suggestion().unwrap()
                ),
                Some(true),
                "{}",
                question.id()
            );
        }
        let first = questions[0];
        state
            .answer(&capabilities, first.id(), first.suggestion().cloned())
            .unwrap();
        let after = state.resolve(&capabilities).unwrap();
        assert_eq!(
            serde_json::to_value(after.assessment().document().unwrap()).unwrap(),
            before
        );
        covered += 1;
    }
    assert_eq!(covered, 30);
}

#[test]
fn reference_scoped_execution_questions_follow_the_selected_harness_only() {
    let capabilities = Capabilities::available();
    let mut value = example("fabric-openclaw.yaml").supplied().clone();
    let mut harness = value["spec"]["sandboxes"]["assistant"]["harness"].clone();
    harness["execution"] = json!({"timeoutSeconds":120});
    value["spec"]["harnesses"] = json!({"unused":harness});
    let path = "/spec/harnesses/unused/execution/timeoutSeconds";
    let state = JourneyDefinition::new(
        "inline",
        PartialDocument::from_yaml(value.to_string().as_bytes()).unwrap(),
    )
    .ask([JourneyScope::DeploymentFields])
    .start(&capabilities)
    .unwrap();
    assert!(
        state
            .resolve(&capabilities)
            .unwrap()
            .question(path)
            .is_none()
    );
    let mut state = state;
    assert!(state.answer(&capabilities, path, Some(json!(240))).is_err());

    value["spec"]["sandboxes"]["assistant"]
        .as_object_mut()
        .unwrap()
        .remove("harness");
    value["spec"]["sandboxes"]["assistant"]["harnessRef"] = json!("unused");
    let mut state = JourneyDefinition::new(
        "reference",
        PartialDocument::from_yaml(value.to_string().as_bytes()).unwrap(),
    )
    .ask([JourneyScope::DeploymentFields])
    .start(&capabilities)
    .unwrap();
    assert!(
        state
            .resolve(&capabilities)
            .unwrap()
            .question(path)
            .is_some()
    );
    state.answer(&capabilities, path, Some(json!(240))).unwrap();
    assert_eq!(state.values().pointer(path), Some(&json!(240)));
}

#[test]
fn deployment_questions_do_not_depend_on_sandbox_service_or_harness_names() {
    let capabilities = Capabilities::available();
    // Move each map entry to `to` and point the references at it.
    fn renamed(base: &Value, sandbox: &str, service: &str, harness: &str) -> Value {
        let mut value = base.clone();
        for (collection, from, to) in [
            ("sandboxes", "assistant", sandbox),
            ("services", "ollama-server", service),
            ("harnesses", "agent", harness),
        ] {
            let map = value["spec"][collection].as_object_mut().unwrap();
            let entry = map.remove(from).unwrap();
            map.insert(to.into(), entry);
        }
        value["spec"]["inferenceProviders"]["local"]["serviceRef"] = json!(service);
        value["spec"]["sandboxes"][sandbox]["harnessRef"] = json!(harness);
        value
    }
    // Question IDs with each key replaced by its collection's placeholder.
    let ids = |value: &Value, keys: [&str; 3]| {
        let state = JourneyDefinition::new(
            "names",
            PartialDocument::from_yaml(value.to_string().as_bytes()).unwrap(),
        )
        .ask([JourneyScope::DeploymentFields])
        .start(&capabilities)
        .unwrap();
        state
            .resolve(&capabilities)
            .unwrap()
            .questions()
            .iter()
            .map(|question| {
                let mut id = question.id().to_owned();
                for (collection, key) in ["sandboxes", "services", "harnesses"].iter().zip(keys) {
                    let prefix = format!("/spec/{collection}/{key}/");
                    if let Some(rest) = id.strip_prefix(&prefix) {
                        id = format!("/spec/{collection}/<key>/{rest}");
                    }
                }
                id
            })
            .collect::<BTreeSet<_>>()
    };
    let mut base = example("managed-ollama.yaml").supplied().clone();
    let sandbox = base["spec"]["sandboxes"]["assistant"]
        .as_object_mut()
        .unwrap();
    sandbox.insert(
        "image".into(),
        json!({"ref": nemoclaw_sdk::config::DEFAULT_AGENT_IMAGE}),
    );
    let mut harness = sandbox.remove("harness").unwrap();
    harness["execution"] = json!({"timeoutSeconds": 120});
    base["spec"]["harnesses"] = json!({"agent": harness});
    let base = renamed(&base, "assistant", "ollama-server", "agent");
    let expected = ids(&base, ["assistant", "ollama-server", "agent"]);
    for id in [
        "/spec/sandboxes/<key>/image/ref",
        "/spec/sandboxes/<key>/network/tier",
        "/spec/services/<key>/image",
        "/spec/harnesses/<key>/execution/timeoutSeconds",
    ] {
        assert!(expected.contains(id), "{id}: {expected:#?}");
    }
    // Each key is also a field name or contains one that the question filters
    // look for.
    for keys in [
        ["routes", "config-server", "settings"],
        ["configurator", "routes", "config"],
        ["execution", "settings", "routes"],
    ] {
        let [sandbox, service, harness] = keys;
        assert_eq!(
            ids(&renamed(&base, sandbox, service, harness), keys),
            expected,
            "{keys:?}"
        );
    }
}
