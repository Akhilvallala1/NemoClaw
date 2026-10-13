// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use crate::examples;

use nemoclaw_sdk::config::{Document, schema::input_schema};
use serde_json::{Value, json};

fn input(name: &str) -> Value {
    crate::support::example(name)
}

fn agrees(validator: &jsonschema::Validator, value: &Value, accepted: bool) {
    assert_eq!(
        Document::parse(value.to_string().as_bytes()).is_ok(),
        accepted,
        "parser: {value}"
    );
    assert_eq!(
        validator.is_valid(value),
        accepted,
        "schema errors: {:?}",
        validator.iter_errors(value).collect::<Vec<_>>()
    );
}

fn agrees_at(
    validator: &jsonschema::Validator,
    value: &Value,
    accepted: bool,
    file: &str,
    path: &str,
) {
    assert_eq!(
        Document::parse(value.to_string().as_bytes()).is_ok(),
        accepted,
        "parser: {file} {path}: {value}"
    );
    assert_eq!(
        validator.is_valid(value),
        accepted,
        "schema: {file} {path}: {:?}",
        validator.iter_errors(value).collect::<Vec<_>>()
    );
}

#[test]
fn image_pull_policy_accepts_only_supported_values_on_managed_containers() {
    let validator = jsonschema::validator_for(&input_schema()).unwrap();
    for (file, path) in [
        ("spark/spark-inline.yaml", "/spec/gateway/target/docker"),
        ("spark/spark-inline.yaml", "/spec/services/qwen"),
        ("managed-ollama.yaml", "/spec/services/ollama-server"),
    ] {
        for policy in ["Always", "IfNotPresent", "Never", "always", ""] {
            let mut value = input(file);
            value.pointer_mut(path).unwrap()["imagePullPolicy"] = json!(policy);
            let accepted = matches!(policy, "IfNotPresent" | "Never");
            agrees(&validator, &value, accepted);
            if policy == "Always" {
                let error = Document::parse(value.to_string().as_bytes())
                    .unwrap_err()
                    .to_string();
                assert!(
                    error.contains("IfNotPresent") && error.contains("Never"),
                    "{error}"
                );
            }
            if accepted {
                let document = Document::parse(value.to_string().as_bytes()).unwrap();
                let exported = document.yaml().unwrap();
                assert_eq!(Document::parse(exported.as_bytes()).unwrap(), document);
                assert_eq!(
                    serde_json::to_value(document)
                        .unwrap()
                        .pointer(path)
                        .unwrap()["imagePullPolicy"],
                    policy
                );
            }
        }
    }
    let mut external = input("local.yaml");
    external["spec"]["gateway"]["imagePullPolicy"] = json!("Never");
    agrees(&validator, &external, false);
    let mut sandbox = input("local.yaml");
    sandbox["spec"]["sandboxes"]["assistant"]["imagePullPolicy"] = json!("Never");
    agrees(&validator, &sandbox, false);
}

#[test]
fn input_schema_rejects_missing_required_fields_and_structural_nulls() {
    let validator = jsonschema::validator_for(&input_schema()).unwrap();
    let original = input("local.yaml");
    agrees(&validator, &original, true);
    for path in [
        "/apiVersion",
        "/kind",
        "/metadata",
        "/metadata/name",
        "/metadata/uid",
        "/spec",
        "/spec/gateway",
        "/spec/gateway/management",
        "/spec/inferenceProviders/local/provider",
        "/spec/sandboxes",
        "/spec/sandboxes/assistant/agent",
        "/spec/sandboxes/assistant/harness",
        "/spec/sandboxes/assistant/agent/inference",
        "/spec/sandboxes/assistant/agent/inference/routes/0/overrides/model",
    ] {
        let mut value = original.clone();
        let (parent, key) = path.rsplit_once('/').unwrap();
        value
            .pointer_mut(parent)
            .unwrap()
            .as_object_mut()
            .unwrap()
            .remove(key);
        agrees(&validator, &value, false);
    }
    for (parent, key) in [
        ("/spec/gateway", "credential"),
        ("/spec/gateway", "tls"),
        ("/spec/gateway", "target"),
        ("/spec/gateway/target", "docker"),
        ("/spec/inferenceProviders/local", "serviceRef"),
        ("/spec", "services"),
    ] {
        let mut value = original.clone();
        value.pointer_mut(parent).unwrap()[key] = Value::Null;
        agrees(&validator, &value, false);
    }
}

#[test]
fn input_schema_preserves_defaults_strict_objects_and_opaque_pi_metadata() {
    let validator = jsonschema::validator_for(&input_schema()).unwrap();
    let mut value = input("spark/spark-inline.yaml");
    for key in ["endpoint", "engine", "networkCidr"] {
        value["spec"]["gateway"]["target"]["docker"]
            .as_object_mut()
            .unwrap()
            .remove(key);
    }
    for key in ["image", "network", "runtime"] {
        value["spec"]["sandboxes"]["assistant"]
            .as_object_mut()
            .unwrap()
            .remove(key);
    }
    for key in ["serving", "memory"] {
        value["spec"]["services"]["qwen"]
            .as_object_mut()
            .unwrap()
            .remove(key);
    }
    agrees(&validator, &value, true);
    value["spec"]["gateway"]["surprise"] = json!(true);
    agrees(&validator, &value, false);
    let mut value = input("fabric-pi.yaml");
    let path = "/spec/sandboxes/assistant/agent/inference/routes/0/overrides/settings";
    *value.pointer_mut(path).unwrap() = json!({"future": [null, {"value": null}]});
    agrees(&validator, &value, true);
    *value.pointer_mut(path).unwrap() = Value::Null;
    agrees(&validator, &value, false);
}

#[test]
fn every_example_is_accepted_and_round_trips_without_changing_intent() {
    let validator = jsonschema::validator_for(&input_schema()).unwrap();
    let directory = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../examples");
    let paths = examples::yaml_files(&directory);
    assert!(!paths.is_empty());
    for path in paths {
        let text = std::fs::read_to_string(&path).unwrap();
        let value: Value = serde_saphyr::from_str(&text).unwrap();
        agrees(&validator, &value, true);
        let document = Document::parse(text.as_bytes()).unwrap();
        let restored = Document::parse(document.yaml().unwrap().as_bytes()).unwrap();
        assert_eq!(restored, document, "{}", path.display());
        assert_eq!(restored.workspace(), document.workspace());
        assert_eq!(restored.digest(), document.digest());
    }
}

#[test]
fn schema_and_parser_enforce_choices_bounds_and_conditional_forms() {
    let validator = jsonschema::validator_for(&input_schema()).unwrap();
    for (file, path, replacement, accepted) in [
        ("local.yaml", "/apiVersion", json!("future"), false),
        ("local.yaml", "/metadata/name", json!("UPPER"), false),
        (
            "local.yaml",
            "/spec/gateway/management",
            json!("future"),
            false,
        ),
        (
            "local.yaml",
            "/spec/gateway/target/docker/engine",
            json!("unix:///var/run/docker.sock"),
            true,
        ),
        (
            "local.yaml",
            "/spec/gateway/credential",
            json!({"env": "TOKEN"}),
            false,
        ),
        (
            "local.yaml",
            "/spec/gateway/target",
            json!({"podman": {}}),
            true,
        ),
        (
            "local.yaml",
            "/spec/gateway/target",
            json!({"future": {}}),
            false,
        ),
        (
            "local.yaml",
            "/spec/gateway/target",
            json!({"docker": {}, "podman": {}}),
            false,
        ),
        (
            "managed-ollama.yaml",
            "/spec/services/ollama-server/image",
            json!("ollama/ollama:latest"),
            false,
        ),
        (
            "spark/vllm.yaml",
            "/spec/inferenceProviders/qwen/endpoint",
            json!("https://api.example.com/v1"),
            false,
        ),
        (
            "spark/vllm.yaml",
            "/spec/inferenceProviders/qwen/credential",
            json!({"env": "TOKEN"}),
            false,
        ),
        (
            "spark/vllm.yaml",
            "/spec/services/qwen/kind",
            json!("removed-backend"),
            false,
        ),
        (
            "spark/vllm.yaml",
            "/spec/services/qwen/serving/speculativeTokens",
            json!(1),
            false,
        ),
        (
            "spark/vllm.yaml",
            "/spec/services/qwen/serving/startupTimeoutSeconds",
            json!(0),
            true,
        ),
        (
            "spark/vllm.yaml",
            "/spec/services/qwen/serving/startupTimeoutSeconds",
            json!(59),
            false,
        ),
        (
            "spark/vllm.yaml",
            "/spec/services/qwen/serving/startupTimeoutSeconds",
            json!(60),
            true,
        ),
        (
            "spark/vllm.yaml",
            "/spec/services/qwen/serving/startupTimeoutSeconds",
            json!(3600),
            true,
        ),
        (
            "spark/vllm.yaml",
            "/spec/services/qwen/serving/startupTimeoutSeconds",
            json!(3601),
            false,
        ),
        (
            "spark/vllm.yaml",
            "/spec/services/qwen/memory/hostReserveGiB",
            json!(27),
            false,
        ),
        (
            "spark/vllm.yaml",
            "/spec/services/qwen/memory/hostReserveGiB",
            json!(0),
            true,
        ),
        (
            "spark/vllm.yaml",
            "/spec/sandboxes/assistant/harness/kind",
            json!("deepagents"),
            true,
        ),
        (
            "spark/spark-inline.yaml",
            "/spec/services/qwen/recipe/apiVersion",
            json!("future"),
            false,
        ),
        (
            "spark/spark-inline.yaml",
            "/spec/services/qwen/memory/gpuMemoryGiB",
            json!(16),
            false,
        ),
        (
            "spark/spark-inline.yaml",
            "/spec/services/qwen/recipe/resources/preparedBytes",
            json!(0),
            false,
        ),
    ] {
        let mut value = input(file);
        let (parent, key) = path.rsplit_once('/').unwrap();
        value.pointer_mut(parent).unwrap()[key] = replacement;
        agrees_at(&validator, &value, accepted, file, path);
    }
    for field in ["placement", "publication"] {
        let mut value = input("spark/remote-vllm.yaml");
        value["spec"]["services"]["qwen"]
            .as_object_mut()
            .unwrap()
            .remove(field);
        agrees(&validator, &value, false);
    }
}

#[test]
fn defaulted_numeric_bounds_match_the_parser_at_each_boundary() {
    let validator = jsonschema::validator_for(&input_schema()).unwrap();
    for (section, field, min, max) in [
        ("serving", "port", 1024, 65535),
        ("serving", "contextTokens", 8192, 65536),
        ("serving", "maxSequences", 1, 2),
        ("serving", "batchTokens", 512, 4096),
        ("serving", "startupTimeoutSeconds", 60, 3600),
        ("memory", "hostReserveGiB", 28, 64),
        ("memory", "kvCacheGiB", 4, 12),
        ("memory", "minAvailableGiB", 6, 16),
        ("memory", "minFreeGiB", 2, 8),
        ("memory", "freeGateGiB", 6, 24),
        ("memory", "consecutiveSamples", 1, 5),
    ] {
        for (number, accepted) in [
            (-1, false),
            (0, true),
            (min, true),
            (max, true),
            (max + 1, false),
        ] {
            let mut value = input("spark/vllm.yaml");
            let service = &mut value["spec"]["services"]["qwen"];
            service["memory"]["minAvailableGiB"] = json!(6);
            service["memory"]["freeGateGiB"] = json!(24);
            service[section][field] = json!(number);
            agrees(&validator, &value, accepted);
        }
    }
}

#[test]
fn documented_parser_checks_remain_required_after_schema_validation() {
    let schema = input_schema();
    assert!(schema["x-nemoclaw-parser-checks"].as_array().unwrap().len() >= 4);
    let validator = jsonschema::validator_for(&schema).unwrap();
    for (file, path, replacement) in [
        ("local.yaml", "/spec/inferenceProviders", json!({})),
        (
            "local.yaml",
            "/spec/sandboxes/assistant/agent/inference/routes/0/providerRef",
            json!("foreign"),
        ),
        (
            "local.yaml",
            "/spec/gateway/endpoint",
            json!("http://remote.example.com"),
        ),
        (
            "spark/remote-vllm.yaml",
            "/spec/services/qwen/publication/endpoint",
            json!("http://10.0.0.8:9999/v1"),
        ),
        (
            "spark/vllm.yaml",
            "/spec/services/qwen/memory/freeGateGiB",
            json!(6),
        ),
        (
            "managed-ollama.yaml",
            "/spec/sandboxes/assistant/agent/inference/routes/0/overrides/model",
            json!("untagged"),
        ),
        (
            "spark/vllm.yaml",
            "/spec/gateway/target",
            json!({"podman": {"engine": "unix:///run/user/1000/podman/podman.sock"}}),
        ),
    ] {
        let mut value = input(file);
        *value.pointer_mut(path).unwrap() = replacement;
        assert!(validator.is_valid(&value), "{path}");
        assert!(
            Document::parse(value.to_string().as_bytes()).is_err(),
            "{path}"
        );
    }
}

#[test]
fn example_discovery_includes_nested_yaml_and_excludes_other_files() {
    let root = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(root.path().join("nested/deeper")).unwrap();
    let expected: std::collections::BTreeSet<_> =
        ["top.yaml", "nested/child.yaml", "nested/deeper/leaf.yaml"]
            .map(|name| root.path().join(name))
            .into();
    for path in &expected {
        std::fs::write(path, "name: fixture\n").unwrap();
    }
    std::fs::write(root.path().join("nested/readme.md"), "not a deployment").unwrap();
    std::fs::write(root.path().join("nested/deeper/data.json"), "{}").unwrap();
    assert_eq!(
        examples::yaml_files(root.path())
            .into_iter()
            .collect::<std::collections::BTreeSet<_>>(),
        expected
    );
}

#[test]
fn every_sandbox_requires_one_agent() {
    let validator = jsonschema::validator_for(&input_schema()).unwrap();
    let value = input("local.yaml");
    agrees(&validator, &value, true);
    let mut missing = value.clone();
    missing["spec"]["sandboxes"]["assistant"]
        .as_object_mut()
        .unwrap()
        .remove("agent");
    agrees(&validator, &missing, false);
}

#[test]
fn gateway_variants_reject_fields_owned_by_the_other_mode() {
    let validator = jsonschema::validator_for(&input_schema()).unwrap();
    for (field, value) in [
        ("image", json!("")),
        ("networkCidr", json!("")),
        ("imagePullPolicy", json!("Never")),
    ] {
        let mut external = input("local.yaml");
        external["spec"]["gateway"][field] = value;
        agrees(&validator, &external, false);
    }
    for (field, value) in [
        ("credential", json!({"env": "TOKEN"})),
        (
            "tls",
            json!({"ca": {"env": "CA"}, "certificate": {"env": "CERT"}, "key": {"env": "KEY"}}),
        ),
    ] {
        let mut managed = input("spark/spark-inline.yaml");
        managed["spec"]["gateway"][field] = value;
        agrees(&validator, &managed, false);
    }
}

#[test]
fn a_sandbox_cannot_choose_a_runtime_apart_from_its_gateway() {
    let validator = jsonschema::validator_for(&input_schema()).unwrap();
    let mut value = input("managed-podman.yaml");
    value["spec"]["sandboxes"]["assistant"]["runtime"] = json!({"provider": "docker"});
    agrees(&validator, &value, false);
}

#[test]
fn schema_errors_identify_the_contract_without_echoing_input_values_or_map_keys() {
    let mut value = input("fabric-openclaw.yaml");
    value["spec"]["harnesses"] = json!({"SECRET-MAP-KEY": {
        "kind": "openclaw", "execution": {"timeoutSeconds": 0}
    }});
    let error = Document::parse(value.to_string().as_bytes())
        .unwrap_err()
        .to_string();
    assert!(error.contains("schema"), "{error}");
    assert!(!error.contains("SECRET-MAP-KEY"), "{error}");
}

/// The minimal external example with `gateway` in place of its own.
fn with_gateway(gateway: Value) -> Value {
    let mut value = input("local.yaml");
    value["spec"]["gateway"] = gateway;
    value
}

fn managed(target: Value) -> Value {
    with_gateway(json!({"management": "managed", "target": target}))
}

fn cluster_target() -> Value {
    json!({
        "endpoint": "https://127.0.0.1:17671",
        "kubeconfig": {"env": "CLUSTER_KUBECONFIG"},
        "context": "explicit-context",
        "namespace": "owned-gateway",
        "authentication": {"profile": "development"}
    })
}

/// A managed Kubernetes document; cluster sandboxes name an explicit image
/// and its metadata bundle.
fn cluster_document() -> Value {
    let mut value = managed(json!({"kubernetes": cluster_target()}));
    value["spec"]["sandboxes"]["assistant"]["image"] = json!({
        "ref": format!("registry.example/agent@sha256:{}", "a".repeat(64)),
        "metadata": {"env": "TEST_IMAGE_METADATA"}
    });
    value
}

#[test]
fn each_managed_target_validates_and_receives_only_its_own_defaults() {
    use sha2::Digest;
    let validator = jsonschema::validator_for(&input_schema()).unwrap();
    let uid = input("local.yaml")["metadata"]["uid"].clone();
    let network = format!(
        "172.30.{}.0/24",
        sha2::Sha256::digest(uid.as_str().unwrap().as_bytes())[0]
    );
    let podman = "unix:///run/user/1000/podman/podman.sock";
    let docker = json!({"docker": {
        "endpoint": "http://127.0.0.1:17681",
        "engine": "unix:///var/run/docker.sock",
        "networkCidr": network
    }});
    for (value, expected) in [
        (
            with_gateway(json!({"management": "managed"})),
            docker.clone(),
        ),
        (managed(json!({"docker": {}})), docker),
        (
            managed(json!({"podman": {"engine": podman}})),
            json!({"podman": {
                "endpoint": "http://127.0.0.1:17681",
                "engine": podman,
                "networkCidr": network
            }}),
        ),
    ] {
        agrees(&validator, &value, true);
        let document = Document::parse(value.to_string().as_bytes()).unwrap();
        assert_eq!(
            serde_json::to_value(&document).unwrap()["spec"]["gateway"],
            json!({"management": "managed", "target": expected})
        );
    }
    // A cluster target names everything itself; only its distribution has a default.
    let value = cluster_document();
    agrees(&validator, &value, true);
    let document = Document::parse(value.to_string().as_bytes()).unwrap();
    let mut expected = cluster_target();
    expected["distribution"] = json!("kubernetes");
    assert_eq!(
        serde_json::to_value(&document).unwrap()["spec"]["gateway"],
        json!({"management": "managed", "target": {"kubernetes": expected}})
    );
}

#[test]
fn gateway_fields_at_their_earlier_locations_are_rejected() {
    let validator = jsonschema::validator_for(&input_schema()).unwrap();
    let docker = managed(json!({"docker": {}}));
    agrees(&validator, &docker, true);
    for (field, value) in [
        ("runtime", json!({"provider": "docker"})),
        ("endpoint", json!("http://127.0.0.1:17681")),
        ("engine", json!("unix:///var/run/docker.sock")),
        ("image", json!(nemoclaw_sdk::config::DEFAULT_GATEWAY_IMAGE)),
        ("imagePullPolicy", json!("Never")),
        ("networkCIDR", json!("172.30.1.0/24")),
        ("kubernetes", cluster_target()),
    ] {
        let mut moved = docker.clone();
        moved["spec"]["gateway"][field] = value;
        agrees_at(&validator, &moved, false, "managed", field);
    }
    for (field, value) in [
        ("networkCIDR", json!("172.30.1.0/24")),
        ("image", json!(nemoclaw_sdk::config::DEFAULT_GATEWAY_IMAGE)),
        ("runtime", json!({"provider": "docker"})),
    ] {
        let mut moved = docker.clone();
        moved["spec"]["gateway"]["target"]["docker"][field] = value;
        agrees_at(&validator, &moved, false, "target", field);
    }
    let external = with_gateway(json!({
        "management": "external",
        "endpoint": "http://127.0.0.1:17671",
        "target": {"docker": {"engine": "unix:///var/run/docker.sock"}}
    }));
    agrees(&validator, &external, true);
    for (field, value) in [
        ("runtime", json!({"provider": "docker"})),
        ("engine", json!("unix:///var/run/docker.sock")),
    ] {
        let mut moved = external.clone();
        moved["spec"]["gateway"][field] = value;
        agrees_at(&validator, &moved, false, "external", field);
    }
}

/// The parser's schema diagnostic for `value` as `path: constraint`, without
/// its source position.
fn schema_diagnostic(value: &Value) -> String {
    let error = Document::parse(value.to_string().as_bytes())
        .unwrap_err()
        .to_string();
    let (path, constraint) = error
        .strip_prefix("configuration violates schema at ")
        .and_then(|rest| rest.split_once(" (line "))
        .and_then(|(path, rest)| Some((path, rest.split_once("): ")?.1)))
        .unwrap_or_else(|| panic!("not a positioned schema diagnostic: {error}"));
    format!("{path}: {constraint}")
}

#[test]
fn a_document_for_the_earlier_api_version_fails_before_schema_validation() {
    let earlier = "configuration uses nemoclaw.nvidia.com/v1alpha1; this NemoClaw reads nemoclaw.nvidia.com/v1alpha2; re-author it as described in docs/migration.md";
    // An earlier document reports its version rather than its first moved field.
    let written = br#"
apiVersion: nemoclaw.nvidia.com/v1alpha1
kind: NemoClawConfig
metadata:
  name: local-agent
  uid: 87d485ad-fba7-4197-9eaa-aa97cc97446b
spec:
  gateway:
    management: managed
    runtime:
      provider: docker
    networkCIDR: 172.20.0.0/24
  inferenceProviders:
    - name: local
      provider: openai
      endpoint: http://172.20.0.1:11434/v1
  sandboxes:
    - name: assistant
      harness:
        kind: nvidia.fabric.openclaw
"#;
    assert_eq!(
        Document::parse(&written[..]).unwrap_err().to_string(),
        earlier
    );
    let mut current = input("local.yaml");
    current["apiVersion"] = json!("nemoclaw.nvidia.com/v1alpha1");
    assert_eq!(
        Document::parse(current.to_string().as_bytes())
            .unwrap_err()
            .to_string(),
        earlier
    );
    // Any other version keeps the schema's own constraint.
    let mut later = input("local.yaml");
    later["apiVersion"] = json!("nemoclaw.nvidia.com/v1alpha3");
    assert_eq!(
        schema_diagnostic(&later),
        r#"apiVersion: must be "nemoclaw.nvidia.com/v1alpha2""#
    );
}

#[test]
fn an_earlier_gateway_shape_names_the_field_that_moved() {
    let runtime = "spec.gateway.runtime is replaced by the key under spec.gateway.target: docker, podman, or kubernetes";
    let engine = "spec.gateway.engine moved to spec.gateway.target.docker.engine or spec.gateway.target.podman.engine";
    let image = "spec.gateway.image is removed because the SDK pins the gateway image";
    let network = "spec.gateway.networkCIDR moved to networkCidr under spec.gateway.target.docker or spec.gateway.target.podman";
    let external = |field: &str, value: Value| {
        let mut gateway = json!({"management": "external", "endpoint": "http://127.0.0.1:17671"});
        gateway[field] = value;
        with_gateway(gateway)
    };
    let managed =
        |field: &str, value: Value| with_gateway(json!({"management": "managed", field: value}));
    for (value, message) in [
        (managed("runtime", json!({"provider": "podman"})), runtime),
        (
            managed("endpoint", json!("http://127.0.0.1:17681")),
            "spec.gateway.endpoint of a managed gateway moved to the endpoint of its spec.gateway.target key",
        ),
        (
            managed("engine", json!("unix:///var/run/docker.sock")),
            engine,
        ),
        (
            managed("imagePullPolicy", json!("Never")),
            "spec.gateway.imagePullPolicy moved to spec.gateway.target.docker or spec.gateway.target.podman",
        ),
        (managed("networkCIDR", json!("172.30.1.0/24")), network),
        (
            managed("kubernetes", cluster_target()),
            "spec.gateway.kubernetes moved to spec.gateway.target.kubernetes",
        ),
        (
            managed("image", json!(nemoclaw_sdk::config::DEFAULT_GATEWAY_IMAGE)),
            image,
        ),
        (external("runtime", json!({"provider": "docker"})), runtime),
        (
            external("engine", json!("unix:///var/run/docker.sock")),
            engine,
        ),
    ] {
        assert_eq!(
            schema_diagnostic(&value),
            format!("spec.gateway: {message}")
        );
    }
    // An earlier document gets every hint at once, starting with the runtime
    // that chose where the other fields now live.
    let earlier = with_gateway(json!({
        "management": "managed",
        "networkCIDR": "172.30.1.0/24",
        "image": nemoclaw_sdk::config::DEFAULT_GATEWAY_IMAGE,
        "engine": "unix:///var/run/docker.sock",
        "runtime": {"provider": "docker"}
    }));
    assert_eq!(
        schema_diagnostic(&earlier),
        format!("spec.gateway: {runtime}; {engine}; {image}; {network}")
    );
    // The same earlier fields moved into a target name their replacement there.
    for target in ["docker", "podman"] {
        let value = managed(
            "target",
            json!({target: {
                "engine": "unix:///run/user/1000/podman/podman.sock",
                "networkCIDR": "172.30.1.0/24",
                "image": nemoclaw_sdk::config::DEFAULT_GATEWAY_IMAGE
            }}),
        );
        assert_eq!(
            schema_diagnostic(&value),
            format!(
                "spec.gateway.target.{target}: spec.gateway.target.{target} takes no image because the SDK pins the gateway image; spec.gateway.target.{target} spells networkCIDR as networkCidr"
            )
        );
    }
}

#[test]
fn a_string_choice_error_lists_its_allowed_values() {
    let pull = managed(json!({"podman": {
        "engine": "unix:///run/user/1000/podman/podman.sock",
        "imagePullPolicy": "Bogus"
    }}));
    let mut distribution = cluster_document();
    distribution["spec"]["gateway"]["target"]["kubernetes"]["distribution"] = json!("OpenShift");
    let mut profile = cluster_document();
    profile["spec"]["gateway"]["target"]["kubernetes"]["authentication"]["profile"] =
        json!("production");
    for (value, expected) in [
        (
            pull,
            r#"spec.gateway.target.podman.imagePullPolicy: must be "Always" or "IfNotPresent" or "Never""#,
        ),
        (
            distribution,
            r#"spec.gateway.target.kubernetes.distribution: must be "kubernetes" or "openshift""#,
        ),
        (
            profile,
            r#"spec.gateway.target.kubernetes.authentication.profile: must be "development""#,
        ),
    ] {
        assert_eq!(schema_diagnostic(&value), expected);
    }
}

#[test]
fn a_local_target_endpoint_or_network_error_states_its_rule() {
    let endpoint =
        "a Docker or Podman gateway endpoint is http://127.0.0.1:PORT with an unprivileged port";
    let network = "networkCidr must be a canonical private IPv4 /24";
    for target in ["docker", "podman"] {
        for (field, value, rule) in [
            ("endpoint", "https://127.0.0.1:17681", endpoint),
            ("endpoint", "http://localhost:17681", endpoint),
            ("networkCidr", "10.0.0.0/16", network),
        ] {
            let mut settings = json!({field: value});
            if target == "podman" {
                settings["engine"] = json!("unix:///run/user/1000/podman/podman.sock");
            }
            assert_eq!(
                schema_diagnostic(&managed(json!({target: settings}))),
                format!("spec.gateway.target.{target}.{field}: {rule}")
            );
        }
    }
}

#[test]
fn an_external_image_engine_error_names_its_target_field() {
    for target in ["docker", "podman"] {
        for engine in ["tcp://127.0.0.1:2375", "ssh://user:secret@host"] {
            let value = with_gateway(json!({
                "management": "external",
                "endpoint": "http://127.0.0.1:17671",
                "target": {target: {"engine": engine}}
            }));
            let error = Document::parse(value.to_string().as_bytes())
                .unwrap_err()
                .to_string();
            assert_eq!(
                error,
                format!(
                    "spec.gateway.target.{target}.engine must be a unix:/// socket or ssh://[user@]host[:port] without a password, path, or options"
                )
            );
        }
    }
}

#[test]
fn a_podman_target_requires_its_engine() {
    let validator = jsonschema::validator_for(&input_schema()).unwrap();
    let podman = |settings: Value| managed(json!({"podman": settings}));
    agrees(
        &validator,
        &podman(json!({"engine": "unix:///run/user/1000/podman/podman.sock"})),
        true,
    );
    let rule =
        "Podman requires spec.gateway.target.podman.engine to name its local API service socket";
    for (settings, path) in [
        (json!({}), "spec.gateway.target.podman"),
        (json!({"engine": ""}), "spec.gateway.target.podman.engine"),
    ] {
        let value = podman(settings);
        agrees(&validator, &value, false);
        let error = Document::parse(value.to_string().as_bytes())
            .unwrap_err()
            .to_string();
        assert!(
            error.contains(&format!("schema at {path} (line")) && error.contains(rule),
            "{error}"
        );
    }
    // The socket depends on the host user, so defaults never choose one.
    let mut document: Document = serde_json::from_value(podman(json!({"engine": ""}))).unwrap();
    document.defaults();
    assert_eq!(
        serde_json::to_value(&document).unwrap()["spec"]["gateway"]["target"]["podman"]["engine"],
        ""
    );
    assert!(document.validate().is_err());
}

#[test]
fn image_pull_policy_follows_the_target_engine() {
    let validator = jsonschema::validator_for(&input_schema()).unwrap();
    for (target, supported) in [
        ("docker", &["IfNotPresent", "Never"][..]),
        ("podman", &["Always", "IfNotPresent", "Never"][..]),
    ] {
        for policy in ["Always", "IfNotPresent", "Never", "always", ""] {
            let mut settings = json!({"imagePullPolicy": policy});
            if target == "podman" {
                settings["engine"] = json!("unix:///run/user/1000/podman/podman.sock");
            }
            let value = managed(json!({target: settings}));
            let accepted = supported.contains(&policy);
            agrees_at(&validator, &value, accepted, target, policy);
            if !accepted {
                continue;
            }
            let document = Document::parse(value.to_string().as_bytes()).unwrap();
            assert_eq!(
                Document::parse(document.yaml().unwrap().as_bytes()).unwrap(),
                document
            );
            assert_eq!(
                serde_json::to_value(&document).unwrap()["spec"]["gateway"]["target"][target]["imagePullPolicy"],
                policy
            );
        }
    }
    assert_eq!(
        schema_diagnostic(&managed(json!({"docker": {"imagePullPolicy": "Always"}}))),
        r#"spec.gateway.target.docker.imagePullPolicy: must be "IfNotPresent" or "Never""#
    );
    let mut cluster = cluster_document();
    agrees(&validator, &cluster, true);
    cluster["spec"]["gateway"]["target"]["kubernetes"]["imagePullPolicy"] = json!("Never");
    agrees(&validator, &cluster, false);
}

#[test]
fn defaulted_and_exported_documents_carry_no_gateway_image() {
    use nemoclaw_sdk::config::DEFAULT_GATEWAY_IMAGE;
    assert!(!input_schema().to_string().contains(DEFAULT_GATEWAY_IMAGE));
    let directory = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../examples");
    for path in examples::yaml_files(&directory) {
        let document = Document::parse(std::fs::read(&path).unwrap().as_slice()).unwrap();
        for text in [
            serde_json::to_string(&document).unwrap(),
            document.yaml().unwrap(),
        ] {
            assert!(
                !text.contains(DEFAULT_GATEWAY_IMAGE) && !text.contains("openshell/gateway@"),
                "{}",
                path.display()
            );
        }
    }
}

#[test]
fn schema_patterns_reject_trailing_newlines_in_identifiers_and_pins() {
    let validator = jsonschema::validator_for(&input_schema()).unwrap();
    for (file, path) in [
        ("local.yaml", "/metadata/name"),
        ("local.yaml", "/metadata/uid"),
        ("local.yaml", "/spec/sandboxes/assistant/agent/name"),
        (
            "local.yaml",
            "/spec/sandboxes/assistant/agent/inference/routes/0/overrides/model",
        ),
        ("spark/vllm.yaml", "/spec/services/qwen/image"),
        (
            "managed-ollama.yaml",
            "/spec/services/ollama-server/model/digest",
        ),
    ] {
        let mut value = input(file);
        let target = value.pointer_mut(path).unwrap();
        *target = json!(format!("{}\n", target.as_str().unwrap()));
        agrees_at(&validator, &value, false, file, path);
    }
}

/// The keys of the object at `pointer`, sorted, since `serde_json::Map`
/// keeps no insertion order.
fn keys(value: &Value, pointer: &str) -> Vec<String> {
    value
        .pointer(pointer)
        .and_then(Value::as_object)
        .unwrap_or_else(|| panic!("{pointer} is not an object"))
        .keys()
        .cloned()
        .collect()
}

#[test]
fn sandboxes_and_inference_providers_are_keyed_by_name() {
    let validator = jsonschema::validator_for(&input_schema()).unwrap();
    let mut value = input("multiple-providers.yaml");
    let writer = &mut value["spec"]["sandboxes"]["writer"];
    writer["inferenceProviders"] = json!({"own": {
        "provider": "openai",
        "endpoint": "http://172.20.0.1:11447/v1"
    }});
    writer["agent"]["inference"]["routes"][0]["providerRef"] = json!("own");
    agrees(&validator, &value, true);
    let document =
        serde_json::to_value(Document::parse(value.to_string().as_bytes()).unwrap()).unwrap();
    assert_eq!(keys(&document, "/spec/sandboxes"), ["researcher", "writer"]);
    assert_eq!(
        keys(&document, "/spec/inferenceProviders"),
        ["hosted", "local"]
    );
    assert_eq!(
        keys(&document, "/spec/sandboxes/writer/inferenceProviders"),
        ["own"]
    );
    // The key is the name, so a keyed definition takes no name field.
    let sandbox = "a sandbox's name is its key under spec.sandboxes";
    let provider = "a provider's name is its key under inferenceProviders; only an inline route provider states name";
    for (pointer, message) in [
        ("/spec/sandboxes/writer", sandbox),
        ("/spec/inferenceProviders/local", provider),
        ("/spec/sandboxes/writer/inferenceProviders/own", provider),
    ] {
        let mut named = value.clone();
        let key = pointer.rsplit('/').next().unwrap();
        named.pointer_mut(pointer).unwrap()["name"] = json!(key);
        agrees_at(
            &validator,
            &named,
            false,
            "multiple-providers.yaml",
            pointer,
        );
        assert_eq!(
            schema_diagnostic(&named),
            format!("{}: {message}", pointer[1..].replace('/', "."))
        );
    }
    // The earlier list of named entries is rejected.
    let mut listed = input("local.yaml");
    let mut sandbox = listed["spec"]["sandboxes"]["assistant"].clone();
    sandbox["name"] = json!("assistant");
    listed["spec"]["sandboxes"] = json!([sandbox]);
    agrees(&validator, &listed, false);
    assert_eq!(
        schema_diagnostic(&listed),
        format!("spec.sandboxes: {SANDBOXES}")
    );
    let mut listed = input("local.yaml");
    let mut provider = listed["spec"]["inferenceProviders"]["local"].clone();
    provider["name"] = json!("local");
    listed["spec"]["inferenceProviders"] = json!([provider]);
    agrees(&validator, &listed, false);
    assert_eq!(
        schema_diagnostic(&listed),
        format!("spec.inferenceProviders: {PROVIDERS}")
    );
}

const SANDBOXES: &str = "spec.sandboxes must map 1 to 32 lowercase names (^[a-z][a-z0-9-]{0,39}$) to sandbox definitions";
const PROVIDERS: &str =
    "inferenceProviders must map lowercase names (^[a-z][a-z0-9-]{0,39}$) to provider definitions";

#[test]
fn a_name_key_outside_the_name_pattern_is_rejected_without_echoing_it() {
    let validator = jsonschema::validator_for(&input_schema()).unwrap();
    let mut scoped = input("local.yaml");
    scoped["spec"]["sandboxes"]["assistant"]["inferenceProviders"] = json!({"own": {
        "provider": "openai",
        "endpoint": "http://172.20.0.1:11447/v1"
    }});
    agrees(&validator, &scoped, true);
    for (collection, key, rule) in [
        ("/spec/sandboxes", "assistant", SANDBOXES),
        ("/spec/inferenceProviders", "local", PROVIDERS),
        (
            "/spec/sandboxes/assistant/inferenceProviders",
            "own",
            PROVIDERS,
        ),
    ] {
        for invalid in ["Private-Sentinel", "9private-sentinel", "private_sentinel"] {
            let mut value = scoped.clone();
            let map = value
                .pointer_mut(collection)
                .unwrap()
                .as_object_mut()
                .unwrap();
            let entry = map.remove(key).unwrap();
            map.insert(invalid.into(), entry);
            agrees_at(&validator, &value, false, invalid, collection);
            let error = schema_diagnostic(&value);
            let path = collection[1..].replace('/', ".");
            assert_eq!(error, format!("{path}: {rule}"));
            assert!(!error.contains(invalid), "{error}");
        }
    }
}

#[test]
fn a_deployment_declares_one_to_32_sandboxes() {
    let validator = jsonschema::validator_for(&input_schema()).unwrap();
    let value = input("local.yaml");
    let sandbox = value["spec"]["sandboxes"]["assistant"].clone();
    for (count, accepted) in [(0, false), (1, true), (32, true), (33, false)] {
        let mut sized = value.clone();
        sized["spec"]["sandboxes"] = Value::Object(
            (0..count)
                .map(|index| (format!("sandbox-{index}"), sandbox.clone()))
                .collect(),
        );
        agrees_at(
            &validator,
            &sized,
            accepted,
            "local.yaml",
            &count.to_string(),
        );
        if !accepted {
            assert_eq!(
                schema_diagnostic(&sized),
                format!("spec.sandboxes: {SANDBOXES}")
            );
        }
    }
}

#[test]
fn an_inline_route_provider_names_itself_and_keeps_the_provider_rules() {
    let validator = jsonschema::validator_for(&input_schema()).unwrap();
    let original = input("inline-inference.yaml");
    agrees(&validator, &original, true);
    let pointer = "/spec/sandboxes/assistant/agent/inference/routes/0/provider";
    let mut unnamed = original.clone();
    unnamed
        .pointer_mut(pointer)
        .unwrap()
        .as_object_mut()
        .unwrap()
        .remove("name");
    agrees(&validator, &unnamed, false);
    assert_eq!(
        schema_diagnostic(&unnamed),
        r#"spec.sandboxes.assistant.agent.inference.routes[0].provider: required field: "name""#
    );
    for (field, replacement) in [
        ("name", json!("Upper")),
        ("credential", json!({"env": "MODEL_TOKEN"})),
        ("api", json!("anthropic-messages")),
        ("serviceRef", json!("qwen")),
        ("endpoint", json!("")),
    ] {
        let mut value = original.clone();
        value.pointer_mut(pointer).unwrap()[field] = replacement;
        agrees_at(&validator, &value, false, "inline-inference.yaml", field);
    }
}

#[test]
fn a_provider_exclusion_rule_states_what_it_excludes() {
    let service = "serviceRef excludes endpoint and credential and selects provider openai";
    let plain = "an http:// endpoint takes no credential";
    let credential = json!({"env": "MODEL_TOKEN"});
    for (file, pointer, path) in [
        (
            "local.yaml",
            "/spec/inferenceProviders/local",
            "spec.inferenceProviders.local",
        ),
        (
            "inline-inference.yaml",
            "/spec/sandboxes/assistant/agent/inference/routes/0/provider",
            "spec.sandboxes.assistant.agent.inference.routes[0].provider",
        ),
    ] {
        for (fields, at, message) in [
            (json!({"serviceRef": "qwen"}), ".endpoint", service),
            (
                json!({"serviceRef": "qwen", "endpoint": null, "credential": credential}),
                "",
                service,
            ),
            (
                json!({"serviceRef": "qwen", "endpoint": null, "provider": "anthropic"}),
                ".provider",
                service,
            ),
            (json!({"credential": credential}), "", plain),
        ] {
            let mut value = input(file);
            let provider = value.pointer_mut(pointer).unwrap().as_object_mut().unwrap();
            for (field, replacement) in fields.as_object().unwrap() {
                match replacement {
                    Value::Null => provider.remove(field),
                    _ => provider.insert(field.clone(), replacement.clone()),
                };
            }
            assert_eq!(
                schema_diagnostic(&value),
                format!("{path}{at}: {message}"),
                "{file}: {fields}"
            );
        }
    }
}

#[test]
fn duplicate_sandbox_or_provider_names_are_rejected_as_duplicate_yaml_keys() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../examples");
    for (file, key, duplicate) in [
        ("multiple-sandboxes.yaml", "\n    bob:\n", "\n    alice:\n"),
        (
            "multiple-providers.yaml",
            "\n    hosted:\n",
            "\n    local:\n",
        ),
    ] {
        let text = std::fs::read_to_string(root.join(file)).unwrap();
        assert!(text.contains(key), "{file}");
        let error = Document::parse(text.replacen(key, duplicate, 1).as_bytes())
            .unwrap_err()
            .to_string();
        assert!(error.contains("duplicate mapping key"), "{file}: {error}");
    }
    // JSON input is read as YAML, so it gets the same check.
    let text = input("multiple-sandboxes.yaml").to_string();
    let error = Document::parse(text.replacen(r#""bob":"#, r#""alice":"#, 1).as_bytes())
        .unwrap_err()
        .to_string();
    assert!(error.contains("duplicate mapping key"), "{error}");
}
