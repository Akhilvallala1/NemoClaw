// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use nemoclaw_sdk::{
    compile::{Generations, compile},
    config::Document,
    services::installers::container::inputs::{FILES_KIND, Files},
};
use serde_json::{Value, json};

fn authored() -> Value {
    serde_saphyr::from_str(include_str!(
        "fixtures/config/container-agent-connection.yaml"
    ))
    .unwrap()
}
fn generations() -> Generations {
    [
        "workspace",
        "provider",
        "sandbox",
        "managed_gateway",
        "container_service",
    ]
    .map(|kind| (kind.into(), "a".repeat(32)))
    .into()
}
/// The development-only profile: plaintext to the managed gateway, no credential.
fn local() -> Value {
    let mut value = authored();
    let voice = &mut value["spec"]["services"]["voice"];
    voice["secrets"]
        .as_object_mut()
        .unwrap()
        .remove("openshell");
    voice["agentConnection"] = json!({"sandboxRef":"assistant","authentication":{"mode":"none"}});
    value
}
/// The compiled inputs, with the agent's sandbox resolved.
fn files(document: &Document) -> Files {
    let target = nemoclaw_sdk::compile::targets(document, &generations())
        .unwrap()
        .into_iter()
        .find(|target| target.kind == FILES_KIND)
        .unwrap();
    let mut files = Files::from_row(&target.values).unwrap();
    files.agent.as_mut().unwrap().sandbox_id = "11111111-2222-3333-4444-555555555555".into();
    files
}

#[test]
fn protected_inputs_reach_the_application_as_read_only_files_after_its_agent() {
    for (value, endpoint, credential) in [
        (
            authored(),
            "https://openshell.example.invalid:8443",
            json!("/run/nemoclaw/secrets/openshell"),
        ),
        (local(), "http://172.29.230.2:17681", Value::Null),
    ] {
        let document = Document::parse(value.to_string().as_bytes()).unwrap();
        assert!(document.credential_names().contains(&"NVIDIA_API_KEY"));
        let graph = compile(&document, &generations(), "0.1.0").unwrap();
        assert_eq!(
            graph["terraform"]["required_providers"]["protected"]["source"],
            nemoclaw_sdk::compile::PROTECTED_PROVIDER_ADDRESS
        );
        let inputs = &graph["resource"]["protected_files"]["voice"];
        assert_eq!(inputs["agent"], "${fabric_agent.assistant.ref}");
        assert_eq!(inputs["credentials"]["speech"], "NVIDIA_API_KEY");
        let app = &graph["resource"]["docker_container"]["container_service_voice"];
        assert!(app["mounts"].as_array().unwrap().contains(&json!({
            "type":"volume","source":"nc-f86a000d36028c5f-container-voice-inputs",
            "target":"/run/nemoclaw","read_only":true
        })));
        for dependency in [
            "protected_files.voice",
            "data.fabric_agent_readiness.assistant",
        ] {
            assert!(
                app["depends_on"]
                    .as_array()
                    .unwrap()
                    .contains(&json!(dependency))
            );
        }
        assert_eq!(
            app["lifecycle"]["replace_triggered_by"],
            json!(["protected_files.voice"])
        );
        assert!(!app["env"].to_string().contains("NVIDIA_API_KEY="));
        let descriptor = files(&document).descriptor().unwrap().unwrap();
        assert_eq!(descriptor["gateway"]["endpoint"], endpoint);
        assert_eq!(descriptor["authentication"]["credentialFile"], credential);
        assert_eq!(descriptor["target"]["agent"], "main");
    }
    // Without protected inputs, the graph does not load their provider.
    let document =
        Document::parse(include_bytes!("fixtures/config/container.yaml").as_slice()).unwrap();
    let graph = compile(&document, &generations(), "0.1.0").unwrap();
    assert!(graph["terraform"]["required_providers"]["protected"].is_null());
}

#[test]
fn agent_connections_reject_implicit_or_mismatched_profiles() {
    for (pointer, bad) in [
        ("/authentication", json!({"mode":"oidcBearer"})),
        (
            "/authentication",
            json!({"mode":"oidcBearer","secretRef":"missing"}),
        ),
        (
            "/authentication",
            json!({"mode":"none","secretRef":"speech"}),
        ),
        ("/authentication", json!({})),
        (
            "/gatewayEndpoint",
            json!("http://openshell.example.invalid:8443"),
        ),
        ("/sandboxRef", json!("missing")),
    ] {
        let mut value = authored();
        let connection = &mut value["spec"]["services"]["voice"]["agentConnection"];
        *connection.pointer_mut(pointer).unwrap() = bad;
        assert!(
            Document::parse(value.to_string().as_bytes()).is_err(),
            "{pointer}"
        );
    }
    let mut value = local();
    value["spec"]["services"]["voice"]["agentConnection"]["gatewayEndpoint"] =
        json!("http://192.168.77.2:8443");
    assert!(Document::parse(value.to_string().as_bytes()).is_err());
}
