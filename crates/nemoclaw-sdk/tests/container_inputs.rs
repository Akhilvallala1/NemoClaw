// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use nemoclaw_sdk::{
    compile::{Generations, compile},
    config::Document,
};
use serde_json::{Value, json};

#[test]
fn credential_files_order_startup_and_manual_connection_settings_remain_literals() {
    let document =
        Document::parse(include_bytes!("fixtures/config/container-credentials.yaml").as_slice())
            .unwrap();
    let generations: Generations = [
        "workspace",
        "provider",
        "sandbox",
        "managed_gateway",
        "container_service",
    ]
    .map(|kind| (kind.into(), "a".repeat(32)))
    .into();
    assert!(document.credential_names().contains(&"NVIDIA_API_KEY"));
    let graph = compile(&document, &generations, "0.1.0").unwrap();
    let inputs = &graph["resource"]["protected_files"]["voice"];
    assert_eq!(inputs["credentials"]["speech"], "NVIDIA_API_KEY");
    assert!(inputs.get("agent").is_none());
    assert!(inputs.get("agent_connection").is_none());
    assert!(!inputs.to_string().contains("VOICECLAW_GATEWAY_URL"));
    let app = &graph["resource"]["docker_container"]["container_service_voice"];
    assert!(app["mounts"].as_array().unwrap().contains(&json!({
        "type":"volume","source":"nc-f86a000d36028c5f-container-voice-inputs",
        "target":"/run/nemoclaw","read_only":true
    })));
    assert!(
        app["depends_on"]
            .as_array()
            .unwrap()
            .contains(&json!("protected_files.voice"))
    );
    assert_eq!(
        app["lifecycle"]["replace_triggered_by"],
        json!(["protected_files.voice"])
    );
    assert!(inputs["depends_on"].as_array().unwrap().iter().any(|edge| {
        edge.as_str()
            .is_some_and(|address| address.starts_with("docker_image."))
    }));
    assert!(!app["env"].to_string().contains("NVIDIA_API_KEY="));
    assert!(
        app["env"]
            .as_array()
            .unwrap()
            .contains(&json!("VOICECLAW_AUTH_MODE=none"))
    );
    assert_eq!(
        Document::parse(document.yaml().unwrap().as_bytes()).unwrap(),
        document
    );
    // Application connection choices do not affect protected-file custody.
    let mut changed = serde_json::to_value(&document).unwrap();
    changed["spec"]["services"]["voice"]["environment"]["VOICECLAW_AGENT_NAME"] =
        json!("other-agent");
    let changed = Document::parse(changed.to_string().as_bytes()).unwrap();
    assert_eq!(
        compile(&changed, &generations, "0.1.0").unwrap()["resource"]["protected_files"],
        graph["resource"]["protected_files"]
    );
    // Removed descriptor syntax fails rather than silently being ignored.
    let mut obsolete = serde_json::to_value(&document).unwrap();
    obsolete["spec"]["services"]["voice"]["agentConnection"] = json!({"sandboxRef":"assistant"});
    assert!(Document::parse(obsolete.to_string().as_bytes()).is_err());
    let mut empty = serde_json::to_value(&document).unwrap();
    empty["spec"]["services"]["voice"]["secrets"] = json!({});
    let empty = Document::parse(empty.to_string().as_bytes()).unwrap();
    let graph = compile(&empty, &generations, "0.1.0").unwrap();
    assert_eq!(
        graph["terraform"]["required_providers"]["protected"],
        Value::Null
    );
}
