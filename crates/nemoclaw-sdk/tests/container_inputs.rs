// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use nemoclaw_sdk::{
    compile::{Generations, compile},
    config::Document,
};
use serde_json::{Value, json};

fn authored() -> Value {
    let mut value: Value =
        serde_saphyr::from_str(include_str!("fixtures/config/managed-ollama.yaml")).unwrap();
    let sandbox = value["spec"]["sandboxes"][0]["name"]
        .as_str()
        .unwrap()
        .to_owned();
    let agent = value["spec"]["sandboxes"][0]["agent"]["name"]
        .as_str()
        .unwrap()
        .to_owned();
    value["spec"]["services"]["voice"] = json!({
        "kind":"container", "image":format!("voice@sha256:{}", "a".repeat(64)),
        "architecture":"arm64", "imagePullPolicy":"Never",
        "inputSetup":{"image":format!("inputs@sha256:{}", "b".repeat(64))},
        "data":{"mountPath":"/var/lib/application"},
        "secrets":{
            "speech":{"credential":{"env":"SPEECH_KEY"},"targetPath":"/var/lib/application/credentials/speech"},
            "openshell":{"credential":{"env":"SERVICE_TOKEN"},"targetPath":"/var/lib/application/credentials/openshell"}
        },
        "agentConnections":{"primary":{
            "sandboxRef":sandbox, "agent":agent,
            "targetPath":"/var/lib/application/config/agent-connection.json",
            "gatewayEndpoint":"https://gateway.example.test:8443",
            "authentication":{"mode":"oidcBearer","secretRef":"openshell","refreshMode":"none"},
            "tls":{"trust":"system"},
            "timeouts":{"healthSeconds":12,"invokeSeconds":120}
        }}
    });
    value
}
fn generations() -> Generations {
    [
        "workspace",
        "provider",
        "sandbox",
        "ollama_service",
        "managed_gateway",
        "container_service",
    ]
    .map(|kind| (kind.into(), "a".repeat(32)))
    .into()
}

fn local_development() -> Value {
    let mut value = authored();
    value["spec"]["services"]["voice"]["secrets"]
        .as_object_mut()
        .unwrap()
        .remove("openshell");
    let connection = &mut value["spec"]["services"]["voice"]["agentConnections"]["primary"];
    connection
        .as_object_mut()
        .unwrap()
        .remove("gatewayEndpoint");
    connection["authentication"] = json!({"mode":"none", "refreshMode":"none"});
    connection["tls"] = json!({"trust":"none"});
    value
}

#[test]
fn image_owned_launch_is_independent_of_service_kind_and_keeps_application_policy() {
    let document = Document::parse(authored().to_string().as_bytes()).unwrap();
    let targets = nemoclaw_sdk::compile::targets(&document, &generations()).unwrap();
    let target = targets
        .iter()
        .find(|t| t.kind == "container_service")
        .unwrap();
    let mut spec: nemoclaw_sdk::managed::Spec =
        serde_json::from_str(&target.values["spec"]).unwrap();
    let original = spec.container("/data").unwrap();
    spec.kind = "custom_service".into();
    let launch = spec.container("/data").unwrap();
    assert_eq!(launch.user, original.user);
    assert_eq!(launch.env, original.env);
    assert_eq!(launch.entrypoint, original.entrypoint);
    assert_eq!(launch.cmd, original.cmd);
    spec.kind = "container_service".into();
    spec.process.as_mut().unwrap().memory_bytes = 1;
    assert!(
        nemoclaw_sdk::services::validate_resource_spec(
            &spec.kind,
            &serde_json::to_string(&spec).unwrap()
        )
        .is_err()
    );
    spec.process.as_mut().unwrap().memory_bytes = 1 << 30;
    spec.process
        .as_mut()
        .unwrap()
        .image_owned
        .as_mut()
        .unwrap()
        .user = "0:0".into();
    spec.validate().unwrap();
    assert!(
        nemoclaw_sdk::services::validate_resource_spec(
            &spec.kind,
            &serde_json::to_string(&spec).unwrap()
        )
        .is_err()
    );
}

#[test]
fn application_identity_uses_launch_settings_without_unrelated_gateway_settings() {
    let application = |value: &Value| {
        let document = Document::parse(value.to_string().as_bytes()).unwrap();
        compile(&document, &generations(), "0.1.0").unwrap()["resource"]["docker_container"]
            ["container_service_voice"]
            .clone()
    };
    let mut value = authored();
    let original = application(&value);
    value["spec"]["gateway"]["endpoint"] = json!("http://127.0.0.1:18892");
    assert_eq!(application(&value), original);
    value["spec"]["services"]["voice"]["environment"] = json!({"LOG_LEVEL":"debug"});
    assert_ne!(application(&value)["labels"], original["labels"]);
    assert_eq!(application(&value)["mounts"], original["mounts"]);
}

#[test]
fn launch_changes_preserve_preparation_and_input_references_replace_disposable_data() {
    let input = |value: &Value| {
        let document = Document::parse(value.to_string().as_bytes()).unwrap();
        let graph = compile(&document, &generations(), "0.1.0").unwrap();
        (
            graph["resource"]["nemoclaw_container_inputs"]["voice"].clone(),
            graph["resource"]["docker_volume"]["container_storage_voice"]["name"].clone(),
        )
    };
    let mut value = authored();
    let original = input(&value);
    value["spec"]["services"]["voice"]["image"] = json!(format!("voice@sha256:{}", "c".repeat(64)));
    value["spec"]["services"]["voice"]["environment"] = json!({"LOG_LEVEL":"debug"});
    value["spec"]["services"]["voice"]["publication"] =
        json!({"bindAddress":"127.0.0.1", "port":18080});
    assert_eq!(input(&value), original);
    value["spec"]["services"]["voice"]["secrets"]["speech"]["credential"]["env"] =
        json!("OTHER_SPEECH_KEY");
    let changed = input(&value);
    assert_ne!(changed.0, original.0);
    assert_ne!(changed.1, original.1);
}

#[test]
fn local_container_connection_rejects_forged_managed_gateway_bindings() {
    let value = local_development();
    let document = Document::parse(value.to_string().as_bytes()).unwrap();
    let targets = nemoclaw_sdk::compile::targets(&document, &generations()).unwrap();
    let input = targets
        .iter()
        .find(|target| target.kind == "container_inputs")
        .unwrap();
    let spec: nemoclaw_sdk::services::installers::container::inputs::InputsSpec =
        serde_json::from_str(&input.values["spec"]).unwrap();
    let nemoclaw_sdk::config::Gateway::Managed(gateway) = &document.spec.gateway else {
        panic!("expected managed gateway")
    };
    let port = url::Url::parse(&gateway.endpoint).unwrap().port().unwrap();
    let address = gateway
        .network_cidr
        .parse::<ipnet::Ipv4Net>()
        .unwrap()
        .hosts()
        .nth(1)
        .unwrap();
    let expected = format!("http://{address}:{port}");
    let mut explicit = value.clone();
    explicit["spec"]["services"]["voice"]["agentConnections"]["primary"]["gatewayEndpoint"] =
        json!(expected);
    Document::parse(explicit.to_string().as_bytes()).unwrap();

    // Provider specifications are untrusted too; a substituted private endpoint,
    // engine or network must not bypass the compiler's managed-gateway binding.
    for path in [
        "/connections/primary/gatewayEndpoint",
        "/storage/Engine",
        "/local_gateway/network_cidr",
    ] {
        let mut forged = serde_json::to_value(&spec).unwrap();
        *forged.pointer_mut(path).unwrap() = match path {
            "/connections/primary/gatewayEndpoint" => json!("http://192.168.77.2:8443"),
            "/storage/Engine" => json!("unix:///other/docker.sock"),
            _ => json!("192.168.77.0/24"),
        };
        let mut forged: nemoclaw_sdk::services::installers::container::inputs::InputsSpec =
            serde_json::from_value(forged).unwrap();
        forged.revision = nemoclaw_sdk::services::installers::container::inputs::input_revision(
            &forged.user,
            &forged.root,
            &forged.secrets,
            &forged.connections,
        );
        forged.storage.name =
            nemoclaw_sdk::managed::data_volume(&forged.application_name(), &forged.revision);
        assert!(forged.validate().is_err(), "accepted {path}");
    }
}

#[test]
fn local_container_connection_rejects_authentication_transport_and_placement_mismatches() {
    for (path, bad) in [
        (
            "/spec/services/voice/agentConnections/primary/authentication/secretRef",
            json!("speech"),
        ),
        (
            "/spec/services/voice/agentConnections/primary/authentication/refreshMode",
            json!("automatic"),
        ),
        (
            "/spec/services/voice/agentConnections/primary/tls/trust",
            json!("system"),
        ),
        (
            "/spec/services/voice/agentConnections/primary/gatewayEndpoint",
            json!("http://8.8.8.8:8443"),
        ),
        (
            "/spec/services/voice/agentConnections/primary/gatewayEndpoint",
            json!("http://127.0.0.1:8443"),
        ),
        (
            "/spec/services/voice/agentConnections/primary/gatewayEndpoint",
            json!("http://gateway.example.test:8443"),
        ),
        (
            "/spec/services/voice/agentConnections/primary/gatewayEndpoint",
            json!("http://192.168.77.2:8443"),
        ),
        (
            "/spec/services/voice/agentConnections/primary/gatewayEndpoint",
            json!("https://192.168.77.2:8443"),
        ),
        (
            "/spec/services/voice/agentConnections/primary/gatewayEndpoint",
            json!("http://token@192.168.77.2:8443"),
        ),
        (
            "/spec/services/voice/agentConnections/primary/gatewayEndpoint",
            json!("http://192.168.77.2:8443/path"),
        ),
        (
            "/spec/services/voice/agentConnections/primary/gatewayEndpoint",
            json!("http://[::ffff:127.0.0.1]:8443"),
        ),
        (
            "/spec/services/voice/placement",
            json!({"engine":"unix:///other/docker.sock", "networkCIDR":"192.168.77.0/24"}),
        ),
        (
            "/spec/gateway",
            json!({"management":"external", "runtime":{"provider":"docker"}, "engine":"unix:///var/run/docker.sock", "endpoint":"http://127.0.0.1:17681"}),
        ),
    ] {
        let mut value = local_development();
        // Insert optional fields as well as replacing existing ones.
        let (parent, field) = path.rsplit_once('/').unwrap();
        value.pointer_mut(parent).unwrap()[field] = bad;
        assert!(
            Document::parse(value.to_string().as_bytes()).is_err(),
            "accepted {path}"
        );
    }
    let mut bearer = authored();
    bearer["spec"]["services"]["voice"]["agentConnections"]["primary"]["authentication"]
        .as_object_mut()
        .unwrap()
        .remove("secretRef");
    assert!(Document::parse(bearer.to_string().as_bytes()).is_err());
}

#[test]
fn container_authentication_schema_rejects_implicit_or_mixed_profiles() {
    let validator =
        jsonschema::validator_for(&nemoclaw_sdk::config::schema::input_schema()).unwrap();
    for mut value in [authored(), local_development()] {
        assert!(validator.is_valid(&value));
        let auth = &mut value["spec"]["services"]["voice"]["agentConnections"]["primary"]["authentication"];
        auth.as_object_mut().unwrap().remove("mode");
        assert!(!validator.is_valid(&value));
        assert!(Document::parse(value.to_string().as_bytes()).is_err());
    }
    let mut local = local_development();
    local["spec"]["services"]["voice"]["agentConnections"]["primary"]["authentication"]["secretRef"] =
        json!(null);
    assert!(validator.is_valid(&local));
    Document::parse(local.to_string().as_bytes()).unwrap();
    local["spec"]["services"]["voice"]["agentConnections"]["primary"]["authentication"]["secretRef"] =
        json!("speech");
    assert!(!validator.is_valid(&local));
    let mut bearer = authored();
    bearer["spec"]["services"]["voice"]["agentConnections"]["primary"]["authentication"]["secretRef"] =
        json!(null);
    assert!(!validator.is_valid(&bearer));
}

#[test]
fn canonical_connection_profiles_bind_descriptors_and_order_protected_delivery() {
    let validator =
        jsonschema::validator_for(&nemoclaw_sdk::config::schema::input_schema()).unwrap();
    for (yaml, credentials, gateway, authentication) in [
        (
            include_str!("fixtures/config/container-managed-local.yaml"),
            &["AGENT_INFERENCE_API_KEY", "NVIDIA_API_KEY"][..],
            json!({"endpoint":"http://172.29.230.2:17681","tls":{"trust":"none","caFile":null}}),
            json!({"mode":"none","credentialFile":null,"refreshMode":"none"}),
        ),
        (
            include_str!("fixtures/config/container-agent-connection.yaml"),
            &[
                "AGENT_INFERENCE_API_KEY",
                "APP_OPENSHELL_SERVICE_TOKEN",
                "NVIDIA_API_KEY",
                "OPENSHELL_OPERATOR_TOKEN",
            ][..],
            json!({"endpoint":"https://openshell.example.invalid:8443","tls":{"trust":"system","caFile":null}}),
            json!({"mode":"oidcBearer","credentialFile":"/var/lib/application/credentials/openshell","refreshMode":"none"}),
        ),
    ] {
        let value: Value = serde_saphyr::from_str(yaml).unwrap();
        assert!(validator.is_valid(&value));
        let document = Document::parse(yaml.as_bytes()).unwrap();
        assert_eq!(document.credential_names(), credentials);
        let graph = compile(&document, &generations(), "0.1.0").unwrap();
        let restored = Document::parse(document.yaml().unwrap().as_bytes()).unwrap();
        assert_eq!(restored, document);
        assert_eq!(compile(&restored, &generations(), "0.1.0").unwrap(), graph);
        let inputs = &graph["resource"]["nemoclaw_container_inputs"]["voice"];
        assert_eq!(inputs["sandbox_id"], "${openshell_sandbox.assistant.id}");
        assert!(
            inputs["depends_on"]
                .as_array()
                .unwrap()
                .contains(&json!("docker_volume.container_storage_voice"))
        );
        assert!(!inputs.to_string().contains("OPENSHELL_OPERATOR_TOKEN"));
        assert!(!inputs.to_string().contains("AGENT_INFERENCE_API_KEY"));
        assert_eq!(
            inputs.to_string().contains("APP_OPENSHELL_SERVICE_TOKEN"),
            authentication["mode"] == "oidcBearer"
        );
        let spec: nemoclaw_sdk::services::installers::container::inputs::InputsSpec =
            serde_json::from_str(inputs["spec"].as_str().unwrap()).unwrap();
        let sandbox_id = "11111111-2222-3333-4444-555555555555";
        let (path, descriptor) = spec.descriptor(sandbox_id).unwrap().unwrap();
        assert_eq!(path, "/var/lib/application/config/agent-connection.json");
        assert_eq!(descriptor["schemaVersion"], "nemoclaw.agent-connection.v1");
        assert_eq!(descriptor["target"]["workspace"], document.workspace());
        assert_eq!(descriptor["target"]["sandboxId"], sandbox_id);
        assert_eq!(
            descriptor["target"]["agent"],
            document.spec.sandboxes[0].agent.name
        );
        assert_eq!(descriptor["gateway"], gateway);
        assert_eq!(descriptor["authentication"], authentication);
        assert!(descriptor.get("credentialValue").is_none());
        assert!(
            !descriptor
                .to_string()
                .contains("APP_OPENSHELL_SERVICE_TOKEN")
        );
        let app = &graph["resource"]["docker_container"]["container_service_voice"];
        assert_eq!(app["user"], "65532:65532");
        for dependency in [
            "nemoclaw_container_inputs.voice",
            "data.fabric_sandbox_readiness.assistant",
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
            json!(["nemoclaw_container_inputs.voice"])
        );
        assert_eq!(
            graph["data"]["fabric_sandbox_readiness"]["assistant"]["lifecycle"]["postcondition"][0]
                ["condition"],
            "${self.ready}"
        );
        let environment = app["env"].as_array().unwrap();
        assert!(environment.contains(&json!("APP_MODE=qualification")));
        assert!(environment.contains(&json!(
            "APP_AGENT_CONNECTION_FILE=/var/lib/application/config/agent-connection.json"
        )));
        for name in credentials {
            assert!(
                !environment
                    .iter()
                    .any(|entry| entry.as_str().unwrap().starts_with(&format!("{name}=")))
            );
        }
        if authentication["mode"] == "none" {
            assert!(
                graph["resource"]["docker_network"].is_null(),
                "application must not own a second gateway network"
            );
            assert_eq!(spec.secrets.len(), 1);
            assert!(!graph.to_string().contains("OPENSHELL_OPERATOR_TOKEN"));
            assert!(!graph.to_string().contains("APP_OPENSHELL_SERVICE_TOKEN"));
        }
    }
}

#[test]
fn protected_input_volume_labels_match_the_bound_process_generation() {
    for value in [authored(), local_development()] {
        let document = Document::parse(value.to_string().as_bytes()).unwrap();
        let mut generations = generations();
        generations.insert("container_service".into(), "b".repeat(32));
        let graph = compile(&document, &generations, "0.1.0").unwrap();
        let spec: nemoclaw_sdk::services::installers::container::inputs::InputsSpec =
            serde_json::from_str(
                graph["resource"]["nemoclaw_container_inputs"]["voice"]["spec"]
                    .as_str()
                    .unwrap(),
            )
            .unwrap();
        let volume = &graph["resource"]["docker_volume"]["container_storage_voice"];
        assert_eq!(volume["name"], spec.storage.name);
        assert_eq!(
            volume["labels"],
            json!([
                {"label":nemoclaw_sdk::managed::OWNER_LABEL,"value":spec.storage.owner},
                {"label":nemoclaw_sdk::managed::GENERATION_LABEL,"value":spec.storage.generation}
            ])
        );
        assert_eq!(spec.storage.generation, "b".repeat(32));
        assert!(volume.get("lifecycle").is_none());
        let runtime =
            nemoclaw_sdk::compile::compile_runtime(&document, &generations, "0.1.0").unwrap();
        let cache = &runtime["resource"]["docker_volume"]["ollama_service_storage_ollama-server"];
        assert_eq!(
            cache["labels"],
            json!([{"label":nemoclaw_sdk::managed::OWNER_LABEL,"value":document.metadata.uid}])
        );
        assert_eq!(cache["lifecycle"]["prevent_destroy"], true);
    }
}

#[test]
fn container_inputs_reject_unsafe_paths_bindings_credentials_and_transports() {
    for (path, bad) in [
        ("/spec/services/voice/inputSetup", Value::Null),
        (
            "/spec/services/voice/inputSetup/image",
            json!("inputs:latest"),
        ),
        (
            "/spec/services/voice/inputSetup/image",
            json!(format!("sha256:{}", "b".repeat(64))),
        ),
        (
            "/spec/services/voice/secrets/speech/targetPath",
            json!("/etc/key"),
        ),
        (
            "/spec/services/voice/secrets/speech/targetPath",
            json!("/var/lib/application/../key"),
        ),
        (
            "/spec/services/voice/secrets/speech/targetPath",
            json!("/var/lib/application/config"),
        ),
        (
            "/spec/services/voice/secrets/speech/credential/env",
            json!("TF_VAR_KEY"),
        ),
        (
            "/spec/services/voice/agentConnections/primary/sandboxRef",
            json!("missing"),
        ),
        (
            "/spec/services/voice/agentConnections/primary/agent",
            json!("wrong"),
        ),
        (
            "/spec/services/voice/agentConnections/primary/authentication/secretRef",
            json!("missing"),
        ),
        (
            "/spec/services/voice/agentConnections/primary/authentication/mode",
            json!("operatorLogin"),
        ),
        (
            "/spec/services/voice/agentConnections/primary/gatewayEndpoint",
            json!("http://gateway.example.test"),
        ),
        (
            "/spec/services/voice/agentConnections/primary/gatewayEndpoint",
            json!("https://token@gateway.example.test"),
        ),
        (
            "/spec/services/voice/agentConnections/primary/gatewayEndpoint",
            json!("https://127.0.0.1:8443"),
        ),
        (
            "/spec/services/voice/agentConnections/primary/tls/trust",
            json!("insecure"),
        ),
        (
            "/spec/services/voice/agentConnections/primary/timeouts/healthSeconds",
            json!(0),
        ),
    ] {
        let mut value = authored();
        *value.pointer_mut(path).unwrap() = bad;
        assert!(
            Document::parse(value.to_string().as_bytes()).is_err(),
            "accepted {path}"
        );
    }
}

#[test]
fn setup_image_is_not_allowed_without_any_protected_inputs() {
    let mut value = authored();
    value["spec"]["services"]["voice"]["secrets"] = json!({});
    value["spec"]["services"]["voice"]["agentConnections"] = json!({});
    assert!(Document::parse(value.to_string().as_bytes()).is_err());
    value["spec"]["services"]["voice"]
        .as_object_mut()
        .unwrap()
        .remove("inputSetup");
    Document::parse(value.to_string().as_bytes()).unwrap();
}

#[test]
fn application_descriptor_rejects_unresolved_binding_and_unknown_fields() {
    let document = Document::parse(authored().to_string().as_bytes()).unwrap();
    let target = nemoclaw_sdk::compile::targets(&document, &generations())
        .unwrap()
        .into_iter()
        .find(|t| t.kind == "container_inputs")
        .unwrap();
    let spec: nemoclaw_sdk::services::installers::container::inputs::InputsSpec =
        serde_json::from_str(&target.values["spec"]).unwrap();
    assert!(spec.descriptor("unresolved").is_err());
    assert!(serde_json::from_value::<nemoclaw_sdk::services::installers::container::inputs::InputsSpec>({
        let mut value=serde_json::to_value(&spec).unwrap(); value["unexpected"]=json!("field"); value
    }).is_err());
}

#[tokio::test]
async fn missing_protected_credentials_fail_before_bundle_access_or_deployment_changes() {
    struct Missing;
    impl nemoclaw_sdk::Secrets for Missing {
        fn resolve(&self, _: &str) -> Result<String, nemoclaw_sdk::ObservationError> {
            Err(nemoclaw_sdk::ObservationError::Authentication)
        }
    }
    let document = Document::parse(authored().to_string().as_bytes()).unwrap();
    let directory = tempfile::tempdir().unwrap();
    let deployment = nemoclaw_sdk::Deployment::new(
        &directory.path().join("state"),
        &directory.path().join("missing-bundle"),
    )
    .with_secrets(std::sync::Arc::new(Missing));
    let error = deployment
        .apply(&document, &nemoclaw_sdk::CancellationToken::new())
        .await
        .unwrap_err();
    assert!(matches!(
        error,
        nemoclaw_sdk::Error::Observation(nemoclaw_sdk::ObservationError::Authentication)
    ));
    assert!(!directory.path().join("state").exists());
}
