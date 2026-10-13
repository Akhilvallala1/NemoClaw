// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use nemoclaw_sdk::config::{
    ExternalTarget, Harness, InferenceProvider, KubernetesDistribution, ManagedTarget,
};
use serde_json::json;

#[test]
fn closed_selectors_reject_unknown_values_and_harnesses_reject_malformed_identifiers() {
    assert!(serde_json::from_value::<Harness>(json!({"kind":" \t"})).is_err());
    assert!(serde_json::from_value::<ManagedTarget>(json!({"unknown": {}})).is_err());
    assert!(serde_json::from_value::<ExternalTarget>(json!({"unknown": {}})).is_err());
    assert!(serde_json::from_value::<KubernetesDistribution>(json!("unknown")).is_err());
    assert!(
        serde_json::from_value::<InferenceProvider>(json!({"name":"model", "provider":"unknown"}))
            .is_err()
    );
}

#[test]
fn required_selectors_are_not_silently_defaulted() {
    assert!(serde_json::from_value::<Harness>(json!({})).is_err());
    assert!(serde_json::from_value::<InferenceProvider>(json!({"name":"model"})).is_err());
}

#[test]
fn selector_names_round_trip_without_changing_wire_values() {
    use nemoclaw_sdk::config::{ComputeDriver, HarnessKind, InferenceProviderKind};
    fn round_trip<T>(cases: &[(T, &str)])
    where
        T: std::fmt::Debug
            + PartialEq
            + std::fmt::Display
            + std::str::FromStr
            + serde::Serialize
            + serde::de::DeserializeOwned,
        T::Err: std::fmt::Debug,
    {
        for (kind, name) in cases {
            assert_eq!(serde_json::to_value(kind).unwrap(), json!(name));
            assert_eq!(&serde_json::from_value::<T>(json!(name)).unwrap(), kind);
            assert_eq!(&name.parse::<T>().unwrap(), kind);
            assert_eq!(kind.to_string(), *name);
        }
        for name in ["", " "] {
            assert!(name.parse::<T>().is_err());
            assert!(serde_json::from_value::<T>(json!(name)).is_err());
        }
    }
    for name in [
        "nvidia.fabric.pi",
        "org.fabric.fixture.discoverable",
        "../opaque-id",
    ] {
        round_trip(&[(name.parse::<HarnessKind>().unwrap(), name)]);
    }
    round_trip(&[
        (ComputeDriver::Docker, "docker"),
        (ComputeDriver::Podman, "podman"),
        (ComputeDriver::Kubernetes, "kubernetes"),
        (ComputeDriver::OpenShift, "openshift"),
    ]);
    round_trip(&[
        (InferenceProviderKind::Openai, "openai"),
        (InferenceProviderKind::Anthropic, "anthropic"),
    ]);
}

#[test]
fn an_omitted_target_selects_docker_without_changing_intent_digest() {
    use nemoclaw_sdk::config::{ComputeDriver, Document};
    let document =
        Document::parse(include_bytes!("fixtures/config/local.yaml").as_slice()).unwrap();
    for target in [None, Some(json!({"docker": {}}))] {
        let mut input = serde_json::to_value(&document).unwrap();
        let gateway = input["spec"]["gateway"].as_object_mut().unwrap();
        gateway.remove("target");
        if let Some(target) = target {
            gateway.insert("target".into(), target);
        }
        let parsed = Document::parse(input.to_string().as_bytes()).unwrap();
        assert_eq!(parsed.spec.gateway.compute_driver(), ComputeDriver::Docker);
        assert_eq!(parsed.digest(), document.digest());
        assert_eq!(parsed.yaml().unwrap(), document.yaml().unwrap());
    }
}

#[test]
fn the_target_is_chosen_once_on_the_gateway() {
    use nemoclaw_sdk::config::{ComputeDriver, Document, schema::input_schema};
    let validator = jsonschema::validator_for(&input_schema()).unwrap();
    let base: serde_json::Value =
        serde_saphyr::from_str(include_str!("fixtures/config/local.yaml")).unwrap();
    // Both gateway kinds name the compute driver by their target key.
    for gateway in [
        json!({
            "management": "managed",
            "target": {"podman": {"engine": "unix:///run/user/1000/podman/podman.sock"}}
        }),
        json!({
            "management": "external",
            "endpoint": "https://gateway.example:8080",
            "target": {"podman": {}}
        }),
    ] {
        let mut input = base.clone();
        input["spec"]["gateway"] = gateway;
        assert!(validator.is_valid(&input), "{input}");
        let document = Document::parse(input.to_string().as_bytes()).unwrap();
        assert_eq!(
            document.spec.gateway.compute_driver(),
            ComputeDriver::Podman
        );
    }
    // A sandbox does not select its own runtime.
    let mut input = base;
    input["spec"]["sandboxes"][0]["runtime"] = json!({"provider": "docker"});
    assert!(!validator.is_valid(&input));
    assert!(Document::parse(input.to_string().as_bytes()).is_err());
}

#[test]
fn sandbox_images_are_inspected_on_the_engine_the_target_names() {
    use nemoclaw_sdk::config::{Document, GATEWAY_ENGINE};
    let base: serde_json::Value =
        serde_saphyr::from_str(include_str!("fixtures/config/local.yaml")).unwrap();
    let podman = "unix:///run/user/1000/podman/podman.sock";
    for (gateway, engine) in [
        (json!({"management": "managed"}), GATEWAY_ENGINE),
        (
            json!({"management": "managed", "target": {"podman": {"engine": podman}}}),
            podman,
        ),
        (
            json!({"management": "external", "endpoint": "http://127.0.0.1:17671",
                "target": {"podman": {"engine": podman}}}),
            podman,
        ),
        (
            json!({"management": "external", "endpoint": "http://127.0.0.1:17671"}),
            "",
        ),
    ] {
        let mut input = base.clone();
        input["spec"]["gateway"] = gateway;
        let document = Document::parse(input.to_string().as_bytes()).unwrap();
        assert_eq!(document.spec.gateway.image_engine(), engine, "{input}");
    }
}

#[test]
fn an_empty_target_is_rejected_without_defaulting() {
    use nemoclaw_sdk::config::{Document, schema::input_schema};
    assert!(serde_json::from_value::<ManagedTarget>(json!({})).is_err());
    assert!(serde_json::from_value::<ExternalTarget>(json!("")).is_err());
    let validator = jsonschema::validator_for(&input_schema()).unwrap();
    for target in [json!({}), json!(""), json!(null)] {
        let mut input: serde_json::Value =
            serde_saphyr::from_str(include_str!("fixtures/config/local.yaml")).unwrap();
        input["spec"]["gateway"]["target"] = target;
        assert!(!validator.is_valid(&input), "{input}");
        assert!(Document::parse(input.to_string().as_bytes()).is_err());
    }
}

#[test]
fn opaque_adapter_identity_has_no_native_alias_or_default_image() {
    let harness: Harness =
        serde_json::from_value(json!({"kind":"org.fabric.fixture.discoverable"})).unwrap();
    assert_eq!(harness.kind.as_str(), "org.fabric.fixture.discoverable");
    assert_eq!(harness.runtime(), "fabric");
}

#[test]
fn native_schema_fields_are_owned_only_by_fabric_settings() {
    for field in ["interfaces", "observability"] {
        assert!(
            serde_json::from_value::<Harness>(json!({"kind":"org.fixture.adapter",field:{}}))
                .is_err()
        );
    }
    let harness: Harness=serde_json::from_value(json!({"kind":"org.fixture.adapter","settings":{"interfaces":{"future":null},"observability":{"future":true}}})).unwrap();
    assert!(harness.settings.unwrap()["interfaces"]["future"].is_null());
}

#[test]
fn opaque_fabric_identifiers_preserve_owner_valid_long_and_control_values() {
    use nemoclaw_sdk::{
        config::{Document, schema::input_schema},
        fabric_catalog::FabricCatalog,
    };
    let validator = jsonschema::validator_for(&input_schema()).unwrap();
    for id in [
        format!("org.fabric.{}", "x".repeat(300)),
        "org.fabric.\nfixture\u{1b}".into(),
    ] {
        let mut catalog = FabricCatalog::bundled();
        catalog.adapters[0].descriptor["adapter_id"] = json!(id);
        let catalog = FabricCatalog::from_json(&serde_json::to_string(&catalog).unwrap()).unwrap();
        assert_eq!(catalog.adapters[0].adapter_id(), id);
        let mut input: serde_json::Value =
            serde_saphyr::from_str(include_str!("fixtures/config/local.yaml")).unwrap();
        input["spec"]["sandboxes"][0]["harness"]["kind"] = json!(catalog.adapters[0].adapter_id());
        assert!(
            validator.is_valid(&input),
            "schema rejected Fabric identifier"
        );
        let document = Document::parse(input.to_string().as_bytes()).unwrap();
        let encoded = document.yaml().unwrap();
        let restored = Document::parse(encoded.as_bytes()).unwrap();
        assert_eq!(
            restored
                .sandbox_harness(&restored.spec.sandboxes[0])
                .unwrap()
                .kind
                .as_str(),
            id
        );
    }
}
