// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use nemoclaw_authoring::{
    Capabilities, DecisionStatus, JourneyDefinition, JourneyScope, PartialDocument,
};
use serde_json::{Value, json};

fn base_values() -> Value {
    serde_saphyr::from_slice(include_bytes!("../../../examples/onboarding/openclaw.yaml")).unwrap()
}

fn partial(values: &Value) -> PartialDocument {
    PartialDocument::from_yaml(values.to_string().as_bytes()).unwrap()
}

#[test]
fn preset_keeps_shared_provider_identity_and_reopens_every_dependent_route() {
    let capabilities = Capabilities::available();
    let mut values = base_values();
    let routes = values["spec"]["sandboxes"][0]["agent"]["inference"]["routes"]
        .as_array_mut()
        .unwrap();
    let mut second = routes[0].clone();
    second["name"] = json!("second");
    routes.push(second);
    values["spec"]["sandboxes"][0]["agent"]["inference"]["default"] =
        values["spec"]["sandboxes"][0]["agent"]["inference"]["routes"][0]["name"].clone();
    let provider_name = values["spec"]["inferenceProviders"][0]["name"].clone();
    let first_name =
        values["spec"]["sandboxes"][0]["agent"]["inference"]["routes"][0]["name"].clone();
    let mut state = JourneyDefinition::new("shared-provider", partial(&values))
        .ask([JourneyScope::RouteModels])
        .ask(["inference:preset"])
        .start()
        .unwrap();
    state
        .answer(&capabilities, "route:selection", Some(first_name))
        .unwrap();
    state
        .answer(
            &capabilities,
            "inference:preset",
            Some(json!("nvidia-endpoints")),
        )
        .unwrap();
    let first_model = "/spec/sandboxes/0/agent/inference/routes/0/overrides/model";
    state
        .answer(&capabilities, first_model, Some(json!("first-model")))
        .unwrap();
    state
        .answer(&capabilities, "route:selection", Some(json!("second")))
        .unwrap();
    state
        .answer(
            &capabilities,
            "inference:preset",
            Some(json!("nvidia-endpoints")),
        )
        .unwrap();
    let second_model = "/spec/sandboxes/0/agent/inference/routes/1/overrides/model";
    state
        .answer(&capabilities, second_model, Some(json!("second-model")))
        .unwrap();
    state
        .answer(&capabilities, "inference:preset", Some(json!("openai")))
        .unwrap();

    assert_eq!(
        state.values()["spec"]["inferenceProviders"][0]["name"],
        provider_name
    );
    assert!(
        state
            .resolve(&capabilities)
            .unwrap()
            .assessment()
            .document()
            .is_some()
    );
    assert!(matches!(
        state.decision_status(first_model),
        DecisionStatus::Reopened { .. }
    ));
    assert!(matches!(
        state.decision_status(second_model),
        DecisionStatus::Reopened { .. }
    ));
    state
        .answer(
            &capabilities,
            second_model,
            Some(json!("updated-second-model")),
        )
        .unwrap();
    assert!(
        state
            .resolve(&capabilities)
            .unwrap()
            .question("route:selection")
            .is_some()
    );
}

#[test]
fn exact_and_scope_api_guidance_use_the_same_selected_provider_policy() {
    let capabilities = Capabilities::available();
    let values: Value = serde_saphyr::from_slice(include_bytes!(
        "../../../examples/spark/local-and-hosted.yaml"
    ))
    .unwrap();
    let api = "/spec/inferenceProviders/1/api";
    for scopes in [
        vec![JourneyScope::RouteModels],
        vec![JourneyScope::RouteModels, JourneyScope::InferenceApi],
    ] {
        let mut state = JourneyDefinition::new("provider-api-policy", partial(&values))
            .ask([api, "inference:preset"])
            .ask(scopes)
            .start()
            .unwrap();
        state
            .answer(&capabilities, "route:selection", Some(json!("hosted")))
            .unwrap();
        assert!(
            state
                .resolve(&capabilities)
                .unwrap()
                .question(api)
                .is_none()
        );
        state
            .answer(&capabilities, "inference:preset", Some(json!("anthropic")))
            .unwrap();
        let resolution = state.resolve(&capabilities).unwrap();
        let questions = resolution.questions();
        let api_index = questions.iter().position(|q| q.id() == api).unwrap();
        assert_eq!(
            questions[api_index].choices(),
            &[json!("anthropic-messages")]
        );
        let model_index = questions
            .iter()
            .position(|q| q.id() == "/spec/sandboxes/0/agent/inference/routes/1/overrides/model")
            .unwrap();
        assert!(api_index < model_index);
        assert!(
            state
                .answer(&capabilities, api, Some(json!("openai-completions")))
                .is_err()
        );
    }
}
