// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use nemoclaw_sdk::{
    compile::{compile, compile_runtime, runtime_targets},
    config::{ComputeDriver, Document, schema},
};
use serde_json::{Value, json};

fn cluster(distribution: Option<&str>) -> Value {
    let original =
        Document::parse(include_bytes!("fixtures/config/local.yaml").as_slice()).unwrap();
    let mut input = serde_json::to_value(original).unwrap();
    let mut target = json!({
        "endpoint": "https://127.0.0.1:17671",
        "kubeconfig": {"env": "TEST_OPENSHIFT_CONFIG"},
        "context": "explicit-openshift",
        "namespace": "owned-agents",
        "authentication": {"profile": "development"}
    });
    if let Some(distribution) = distribution {
        target["distribution"] = json!(distribution);
    }
    input["spec"]["gateway"] = json!({"management": "managed", "target": {"kubernetes": target}});
    input["spec"]["sandboxes"]["assistant"]["image"]["metadata"] =
        json!({"env":"TEST_IMAGE_METADATA"});
    input
}

/// An OpenShift deployment: a managed gateway on the openshift distribution,
/// or an existing gateway, which reports the upstream Kubernetes driver.
fn input(managed: bool) -> Value {
    let mut input = cluster(Some("openshift"));
    if !managed {
        input["spec"]["gateway"] = json!({
            "management": "external",
            "endpoint": "http://127.0.0.1:17671",
            "target": {"kubernetes": {}}
        });
    }
    input
}

#[test]
fn openshift_preserves_authored_profile_and_uses_the_upstream_kubernetes_driver() {
    assert_eq!(
        ComputeDriver::OpenShift.openshell_driver(),
        ComputeDriver::Kubernetes
    );
    assert!(ComputeDriver::OpenShift.is_kubernetes());
    assert!(!ComputeDriver::Docker.is_kubernetes());
    for (managed, driver) in [
        (false, ComputeDriver::Kubernetes),
        (true, ComputeDriver::OpenShift),
    ] {
        let input = input(managed);
        assert!(jsonschema::is_valid(&schema::input_schema(), &input));
        let document = Document::parse(input.to_string().as_bytes()).unwrap();
        assert_eq!(document.spec.gateway.compute_driver(), driver);
        let exported = document.yaml().unwrap();
        let imported = Document::parse(exported.as_bytes()).unwrap();
        assert_eq!(imported, document);
        assert_eq!(imported.digest(), document.digest());
        assert_eq!(serde_json::to_value(imported).unwrap(), input);
        if managed {
            assert!(document.spec.gateway.as_kubernetes().is_some());
            assert!(document.spec.gateway.as_local_managed().is_none());
        }
    }
}

#[test]
fn openshift_never_defaults_an_image_or_uses_a_local_managed_gateway() {
    for managed in [false, true] {
        let mut value = input(managed);
        value["spec"]["sandboxes"]["assistant"]
            .as_object_mut()
            .unwrap()
            .remove("image");
        assert!(Document::parse(value.to_string().as_bytes()).is_err());
        let mut document = Document::parse(input(managed).to_string().as_bytes()).unwrap();
        document.spec.sandboxes.get_mut("assistant").unwrap().image = Default::default();
        document.defaults();
        assert!(document.spec.sandboxes["assistant"].image.ref_.is_empty());
        assert!(document.validate().is_err());
    }
    let mut value = input(false);
    value["spec"]["gateway"] = json!({"management":"managed"});
    assert!(Document::parse(value.to_string().as_bytes()).is_err());
}

#[test]
fn the_openshift_distribution_binds_its_driver_and_namespace_identity() {
    let generations = [
        "workspace",
        "provider",
        "sandbox",
        "kubernetes_gateway",
        "kubernetes_storage",
    ]
    .map(|kind| (kind.into(), "a".repeat(32)))
    .into();
    let identity = "${nemoclaw_kubernetes_auth.runtime.gateway_values}";
    for (distribution, driver) in [
        (None, "kubernetes"),
        (Some("kubernetes"), "kubernetes"),
        (Some("openshift"), "openshift"),
    ] {
        let input = cluster(distribution);
        assert!(jsonschema::is_valid(&schema::input_schema(), &input));
        let document = Document::parse(input.to_string().as_bytes()).unwrap();
        let targets = runtime_targets(&document, &generations).unwrap();
        for target in targets
            .iter()
            .filter(|target| target.kind != "helm_release")
        {
            assert_eq!(target.values["compute_driver"], driver, "{}", target.kind);
        }
        let platform = compile_runtime(&document, &generations, "0.1.0").unwrap();
        let values = platform["resource"]["helm_release"]["gateway"]["values"]
            .as_array()
            .unwrap();
        assert_eq!(
            values.iter().any(|value| value == identity),
            driver == "openshift",
            "{distribution:?}"
        );
        let exported = Document::parse(document.yaml().unwrap().as_bytes()).unwrap();
        assert_eq!(exported, document);
    }
}

#[test]
fn only_a_managed_kubernetes_target_names_a_distribution() {
    // An existing gateway reports only the upstream Kubernetes driver, so a
    // distribution could not be checked against it.
    let mut input = cluster(None);
    input["spec"]["gateway"] = json!({
        "management": "external",
        "endpoint": "https://openshell.example.com",
        "target": {"kubernetes": {}}
    });
    assert!(jsonschema::is_valid(&schema::input_schema(), &input));
    Document::parse(input.to_string().as_bytes()).unwrap();
    input["spec"]["gateway"]["target"]["kubernetes"]["distribution"] = json!("openshift");
    assert!(!jsonschema::is_valid(&schema::input_schema(), &input));
    let error = Document::parse(input.to_string().as_bytes())
        .unwrap_err()
        .to_string();
    assert!(
        error.starts_with("configuration violates schema at spec.gateway.target.kubernetes (line")
            && error.ends_with(
                "): distribution applies only to a managed gateway's spec.gateway.target.kubernetes; an existing gateway reports only the kubernetes driver"
            ),
        "{error}"
    );
    // Any other field is unknown there.
    input["spec"]["gateway"]["target"]["kubernetes"] = json!({"namespace": "agents"});
    let error = Document::parse(input.to_string().as_bytes())
        .unwrap_err()
        .to_string();
    assert!(
        error.starts_with("configuration violates schema at spec.gateway.target.kubernetes (line")
            && error.ends_with("): unknown fields are not allowed"),
        "{error}"
    );
    for distribution in ["", "OpenShift", "eks"] {
        let input = cluster(Some(distribution));
        assert!(!jsonschema::is_valid(&schema::input_schema(), &input));
        assert!(Document::parse(input.to_string().as_bytes()).is_err());
    }
}

#[test]
fn openshift_compiles_platform_identity_and_wire_driver_without_docker() {
    let generations = [
        "workspace",
        "provider",
        "sandbox",
        "kubernetes_gateway",
        "kubernetes_storage",
    ]
    .map(|kind| (kind.into(), "a".repeat(32)))
    .into();
    for managed in [false, true] {
        let document = Document::parse(input(managed).to_string().as_bytes()).unwrap();
        let graph = compile(&document, &generations, "0.1.0").unwrap();
        assert!(graph["provider"].get("docker").is_none());
        for phase in ["current", "apply"] {
            assert_eq!(
                graph["data"]["openshell_gateway"][phase]["required_compute_drivers"],
                json!(["kubernetes"])
            );
        }
        assert!(graph["data"].get("nemoclaw_engine_capabilities").is_none());
        assert!(graph["data"].get("nemoclaw_target_hardware").is_none());
        let targets = runtime_targets(&document, &generations).unwrap();
        if managed {
            assert_eq!(targets.len(), 4);
            for target in targets
                .iter()
                .filter(|target| target.kind != "helm_release")
            {
                assert_eq!(target.values["compute_driver"], "openshift");
            }
            let platform = compile_runtime(&document, &generations, "0.1.0").unwrap();
            // The platform stage has no gateway, so it omits the gateway providers.
            assert_eq!(platform["provider"]["nemoclaw"], json!({}));
            for provider in ["openshell", "fabric"] {
                assert!(platform["provider"].get(provider).is_none(), "{provider}");
                assert!(
                    platform["terraform"]["required_providers"]
                        .get(provider)
                        .is_none(),
                    "{provider}"
                );
            }
            assert!(platform.get("data").is_none());
            assert_eq!(
                platform["resource"]["nemoclaw_kubernetes_storage"]["runtime"]["lifecycle"]["prevent_destroy"],
                true
            );
        } else {
            assert!(targets.is_empty());
        }
    }
}
