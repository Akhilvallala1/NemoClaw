// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use nemoclaw_sdk::config::{ComputeDriver, Document, schema};
use serde_json::{Value, json};

fn external_document() -> Value {
    let document =
        Document::parse(include_bytes!("fixtures/config/local.yaml").as_slice()).unwrap();
    let mut input = serde_json::to_value(document).unwrap();
    input["spec"]["gateway"]["target"] = json!({"kubernetes": {}});
    input["spec"]["sandboxes"]["assistant"]["image"]["metadata"] =
        json!({"env":"TEST_IMAGE_METADATA"});
    input
}

fn managed_document() -> Value {
    let mut input = external_document();
    input["spec"]["gateway"] = json!({
        "management": "managed",
        "target": {"kubernetes": {
            "distribution": "kubernetes",
            "endpoint": "https://127.0.0.1:17671",
            "kubeconfig": {"env": "CLUSTER_KUBECONFIG"},
            "context": "explicit-context",
            "namespace": "owned-gateway",
            "authentication": {"profile": "development"}
        }}
    });
    input
}

#[test]
fn managed_kubernetes_preserves_explicit_target_and_has_no_local_engine_defaults() {
    {
        let input = managed_document();
        assert!(jsonschema::is_valid(&schema::input_schema(), &input));
        let document = Document::parse(input.to_string().as_bytes()).unwrap();
        assert!(document.has_runtime());
        assert_eq!(
            document.spec.gateway.compute_driver(),
            ComputeDriver::Kubernetes
        );
        assert!(document.spec.gateway.as_managed().is_some());
        assert!(document.spec.gateway.as_local_managed().is_none());
        assert_eq!(
            document.spec.gateway.as_kubernetes().unwrap().context,
            "explicit-context"
        );
        assert!(
            document
                .spec
                .gateway
                .as_managed()
                .unwrap()
                .bridge()
                .is_err()
        );
        assert_eq!(
            document.credential_names(),
            ["CLUSTER_KUBECONFIG", "TEST_IMAGE_METADATA"]
        );
        assert_eq!(serde_json::to_value(&document).unwrap(), input);
        assert_eq!(
            Document::parse(document.yaml().unwrap().as_bytes()).unwrap(),
            document
        );
    }
}

/// Editors and onboarding read a field's default from its own schema, so each
/// target states only the defaults that apply to it.
#[test]
fn each_target_schema_states_only_its_own_defaults() {
    let schema = schema::input_schema();
    let definitions = &schema["$defs"];
    let docker = &definitions["ManagedDocker"]["properties"];
    assert_eq!(docker["engine"]["default"], "unix:///var/run/docker.sock");
    assert_eq!(docker["endpoint"]["default"], "http://127.0.0.1:17681");
    let podman = &definitions["ManagedPodman"]["properties"];
    assert_eq!(podman["endpoint"]["default"], "http://127.0.0.1:17681");
    assert!(podman["engine"].get("default").is_none());
    let cluster = &definitions["ManagedKubernetes"]["properties"];
    assert!(cluster["endpoint"].get("default").is_none());
    assert_eq!(cluster["distribution"]["default"], "kubernetes");
    for target in [docker, podman, cluster] {
        assert!(target.get("image").is_none());
    }
    for policy in [&docker["imagePullPolicy"], &podman["imagePullPolicy"]] {
        assert_eq!(policy["default"], "IfNotPresent");
    }
    // Editors offer a Docker target only the two policies it accepts, each
    // with its description.
    assert!(docker["imagePullPolicy"].get("$ref").is_none());
    let choices = docker["imagePullPolicy"]["oneOf"]
        .as_array()
        .unwrap()
        .iter()
        .map(|choice| (choice["const"].clone(), choice["description"].is_string()))
        .collect::<Vec<_>>();
    assert_eq!(
        choices,
        [(json!("IfNotPresent"), true), (json!("Never"), true)]
    );
    // An omitted target selects Docker, managed or external.
    for gateway in definitions["Gateway"]["oneOf"].as_array().unwrap() {
        assert_eq!(
            gateway["properties"]["target"]["default"],
            json!({"docker": {}})
        );
    }
}

/// A kubeconfig's exec plugin, such as a cloud CLI, may need the caller's
/// variables. OpenTofu passes only platform variables, so the author names
/// these, and they count as credentials.
#[test]
fn a_managed_target_names_the_variables_its_kubeconfig_needs() {
    let mut input = managed_document();
    input["spec"]["gateway"]["target"]["kubernetes"]["environment"] =
        json!(["AWS_PROFILE", "AWS_REGION"]);
    assert!(jsonschema::is_valid(&schema::input_schema(), &input));
    let document = Document::parse(input.to_string().as_bytes()).unwrap();
    assert_eq!(
        document.spec.gateway.as_kubernetes().unwrap().environment,
        ["AWS_PROFILE", "AWS_REGION"]
    );
    assert_eq!(
        document.credential_names(),
        [
            "AWS_PROFILE",
            "AWS_REGION",
            "CLUSTER_KUBECONFIG",
            "TEST_IMAGE_METADATA"
        ]
    );
    assert_eq!(serde_json::to_value(&document).unwrap(), input);
}

#[test]
fn listed_variables_cannot_shadow_process_or_runtime_controls() {
    let validator = jsonschema::validator_for(&schema::input_schema()).unwrap();
    for name in [
        "PATH",
        "KUBECONFIG",
        "HTTPS_PROXY",
        "TF_LOG",
        "HELM_DRIVER",
        "LD_PRELOAD",
        "lowercase",
        "AWS_PROFILE AWS_REGION",
    ] {
        let mut input = managed_document();
        input["spec"]["gateway"]["target"]["kubernetes"]["environment"] = json!([name]);
        assert!(!validator.is_valid(&input), "{name}");
    }
    let mut repeated = managed_document();
    repeated["spec"]["gateway"]["target"]["kubernetes"]["environment"] =
        json!(["AWS_PROFILE", "AWS_PROFILE"]);
    assert!(!validator.is_valid(&repeated));
}

#[test]
fn kubernetes_sandboxes_must_name_their_image_metadata() {
    // No local engine can be inspected, so each image's metadata bundle is
    // required up front.
    let mut input = external_document();
    input["spec"]["sandboxes"]["assistant"]["image"]
        .as_object_mut()
        .unwrap()
        .remove("metadata");
    assert!(!jsonschema::is_valid(&schema::input_schema(), &input));
    assert!(Document::parse(input.to_string().as_bytes()).is_err());
}

#[test]
fn agent_sandbox_is_a_platform_prerequisite_not_a_setting() {
    // Agent Sandbox must already be installed; the deployment never
    // installs it, so there is nothing to choose.
    let mut input = managed_document();
    input["spec"]["gateway"]["target"]["kubernetes"]["prerequisites"] =
        json!({"agentSandbox": {"management": "existing"}});
    assert!(!jsonschema::is_valid(&schema::input_schema(), &input));
    assert!(Document::parse(input.to_string().as_bytes()).is_err());
}

#[test]
fn managed_kubernetes_requires_explicit_target_and_authentication_choices() {
    let validator = jsonschema::validator_for(&schema::input_schema()).unwrap();
    for (parent, field) in [
        ("/spec/gateway/target/kubernetes", "endpoint"),
        ("/spec/gateway/target/kubernetes", "kubeconfig"),
        ("/spec/gateway/target/kubernetes/kubeconfig", "env"),
        ("/spec/gateway/target/kubernetes", "context"),
        ("/spec/gateway/target/kubernetes", "namespace"),
        ("/spec/gateway/target/kubernetes", "authentication"),
        ("/spec/gateway/target/kubernetes/authentication", "profile"),
    ] {
        let mut input = managed_document();
        input
            .pointer_mut(parent)
            .unwrap()
            .as_object_mut()
            .unwrap()
            .remove(field);
        assert!(
            !validator.is_valid(&input),
            "accepted omitted {parent}/{field}"
        );
        assert!(Document::parse(input.to_string().as_bytes()).is_err());
    }
}

#[test]
fn managed_kubernetes_rejects_other_transports_targets_and_implicit_authentication() {
    let validator = jsonschema::validator_for(&schema::input_schema()).unwrap();
    for (path, value) in [
        ("/spec/gateway/target/kubernetes/endpoint", json!("")),
        (
            "/spec/gateway/target/kubernetes/endpoint",
            json!("http://127.0.0.1:17671"),
        ),
        (
            "/spec/gateway/target/kubernetes/endpoint",
            json!("https://localhost:17671"),
        ),
        (
            "/spec/gateway/target/kubernetes/endpoint",
            json!("https://127.0.0.2:17671"),
        ),
        (
            "/spec/gateway/target/kubernetes/endpoint",
            json!("https://gateway.example:17671"),
        ),
        (
            "/spec/gateway/target/kubernetes/endpoint",
            json!("https://127.0.0.1"),
        ),
        (
            "/spec/gateway/target/kubernetes/endpoint",
            json!("https://127.0.0.1:0"),
        ),
        (
            "/spec/gateway/target/kubernetes/endpoint",
            json!("https://127.0.0.1:65536"),
        ),
        (
            "/spec/gateway/target/kubernetes/endpoint",
            json!("https://127.0.0.1:17671/"),
        ),
        (
            "/spec/gateway/target/kubernetes/endpoint",
            json!("https://127.0.0.1:17671?token=value"),
        ),
        (
            "/spec/gateway/target/kubernetes/endpoint",
            json!("https://user:password@127.0.0.1:17671"),
        ),
        ("/spec/gateway/target/kubernetes/context", json!("")),
        ("/spec/gateway/target/kubernetes/namespace", json!("")),
        (
            "/spec/gateway/target/kubernetes/namespace",
            json!("Invalid_Namespace"),
        ),
        ("/spec/gateway/target/kubernetes/kubeconfig/env", json!("")),
        (
            "/spec/gateway/target/kubernetes/kubeconfig/env",
            json!("/private/kubeconfig"),
        ),
        (
            "/spec/gateway/target/kubernetes/authentication/profile",
            json!("none"),
        ),
        (
            "/spec/gateway/target/kubernetes/authentication/profile",
            json!("production"),
        ),
        (
            "/spec/gateway/target/kubernetes/distribution",
            json!("docker"),
        ),
    ] {
        let mut input = managed_document();
        *input.pointer_mut(path).unwrap() = value;
        assert!(!validator.is_valid(&input), "accepted invalid {path}");
        assert!(Document::parse(input.to_string().as_bytes()).is_err());
        if let Ok(document) = serde_json::from_value::<Document>(input) {
            assert!(
                document.validate().is_err(),
                "accepted direct Rust value at {path}"
            );
        }
    }
    for (field, value) in [
        ("credential", json!({"env":"GATEWAY_TOKEN"})),
        (
            "tls",
            json!({"ca":{"env":"CA"},"certificate":{"env":"CERT"},"key":{"env":"KEY"}}),
        ),
    ] {
        let mut input = managed_document();
        input["spec"]["gateway"][field] = value;
        assert!(!validator.is_valid(&input), "accepted {field}");
        assert!(Document::parse(input.to_string().as_bytes()).is_err());
        assert!(serde_json::from_value::<Document>(input).is_err());
    }
}

#[test]
fn managed_kubernetes_accepts_explicit_port_boundaries() {
    for port in [1, 443, 65535] {
        let mut input = managed_document();
        input["spec"]["gateway"]["target"]["kubernetes"]["endpoint"] =
            json!(format!("https://127.0.0.1:{port}"));
        Document::parse(input.to_string().as_bytes()).unwrap();
    }
}

#[test]
fn authored_credentials_cannot_shadow_managed_kubernetes_runtime_controls() {
    let validator = jsonschema::validator_for(&schema::input_schema()).unwrap();
    for name in [
        "HELM_DRIVER",
        "HELM_REGISTRY_CONFIG",
        "HELM_PLUGINS",
        "KUBE_HOST",
        "KUBE_TOKEN",
        "KUBE_CONFIG_PATH",
        "KUBE_CONFIG_PATHS",
        "KUBE_INSECURE",
        "NEMOCLAW_KUBERNETES_STATE",
        "NEMOCLAW_MANAGED_K8S_TOKEN",
        "NEMOCLAW_MANAGED_K8S_CA",
    ] {
        for path in [
            "/spec/gateway/target/kubernetes/kubeconfig",
            "/spec/inferenceProviders/local/credential",
        ] {
            let mut input = managed_document();
            input["spec"]["inferenceProviders"]["local"]["endpoint"] =
                json!("https://inference.example/v1");
            input["spec"]["inferenceProviders"]["local"]["credential"] =
                json!({"env":"HOSTED_API_KEY"});
            *input.pointer_mut(path).unwrap() = json!({"env":name});
            assert!(!validator.is_valid(&input));
            assert!(Document::parse(input.to_string().as_bytes()).is_err());
            assert!(
                serde_json::from_value::<Document>(input)
                    .unwrap()
                    .validate()
                    .is_err()
            );
        }
    }
}

#[test]
fn managed_kubeconfig_reference_cannot_override_process_controls() {
    let validator = jsonschema::validator_for(&schema::input_schema()).unwrap();
    for name in [
        "PATH",
        "HOME",
        "USERPROFILE",
        "KUBECONFIG",
        "TMPDIR",
        "TMP",
        "TEMP",
        "SYSTEMROOT",
        "COMSPEC",
        "PATHEXT",
        "SHELL",
        "ENV",
        "BASH_ENV",
        "IFS",
        "CDPATH",
        "SSL_CERT_FILE",
        "SSL_CERT_DIR",
        "REQUESTS_CA_BUNDLE",
        "CURL_CA_BUNDLE",
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "NO_PROXY",
        "PYTHONPATH",
        "PYTHONHOME",
        "HELM_PLUGINS",
        "HELM_KUBECONTEXT",
        "LD_PRELOAD",
        "DYLD_INSERT_LIBRARIES",
        "TF_CLI_CONFIG_FILE",
        "TOFU_DATA_DIR",
        "PLUGIN_PROTOCOL_VERSIONS",
        "NEMOCLAW_INTERNAL_HELPER",
        "NEMOCLAW_KUBERNETES_STATE",
        "NEMOCLAW_MANAGED_K8S_TOKEN",
        "KUBERNETES_MASTER",
        "KUBERNETES_SERVICE_HOST",
        "KUBERNETES_SERVICE_PORT",
        "KUBERNETES_SERVICE_PORT_HTTPS",
    ] {
        let mut input = managed_document();
        input["spec"]["gateway"]["target"]["kubernetes"]["kubeconfig"]["env"] = json!(name);
        assert!(
            !validator.is_valid(&input),
            "accepted kubeconfig reference {name}"
        );
        assert!(Document::parse(input.to_string().as_bytes()).is_err());
        let direct = serde_json::from_value::<Document>(input).unwrap();
        assert!(direct.validate().is_err());
        assert!(
            direct
                .spec
                .gateway
                .as_managed()
                .unwrap()
                .validate_managed()
                .is_err()
        );
    }
    for name in [
        "CLUSTER_KUBECONFIG",
        "DEVELOPMENT_CLUSTER",
        "KUBECONFIG_PATH",
    ] {
        let mut input = managed_document();
        input["spec"]["gateway"]["target"]["kubernetes"]["kubeconfig"]["env"] = json!(name);
        Document::parse(input.to_string().as_bytes()).unwrap();
    }
}

#[test]
fn managed_kubeconfig_controls_do_not_restrict_other_credential_references() {
    for name in [
        "PATH",
        "HOME",
        "AWS_ACCESS_KEY_ID",
        "GOOGLE_APPLICATION_CREDENTIALS",
    ] {
        let mut input = external_document();
        input["spec"]["gateway"]["target"] = json!({"docker": {}});
        input["spec"]["sandboxes"]["assistant"]["image"]
            .as_object_mut()
            .unwrap()
            .remove("metadata");
        input["spec"]["inferenceProviders"]["local"]["endpoint"] =
            json!("https://inference.example/v1");
        input["spec"]["inferenceProviders"]["local"]["credential"] = json!({"env": name});
        Document::parse(input.to_string().as_bytes()).unwrap();
    }
}

#[test]
fn a_kubernetes_target_cannot_enter_a_local_engine_spec() {
    let fixtures: Vec<Value> = serde_json::from_str(include_str!(
        "../../nemoclaw-provider/src/managed/reference.json"
    ))
    .unwrap();
    for fixture in fixtures {
        let mut raw: Value = serde_json::from_str(fixture["spec"].as_str().unwrap()).unwrap();
        // Runtime specifications keep the settings layout that retained resources bind.
        raw["gateway"] = json!({
            "runtime": {"provider": "kubernetes"},
            "endpoint": "https://127.0.0.1:17671",
            "kubernetes": {
                "kubeconfig": {"env": "CLUSTER_KUBECONFIG"},
                "context": "explicit-context",
                "namespace": "owned-gateway",
                "authentication": {"profile": "development"}
            }
        });
        let spec: nemoclaw_sdk::managed::Spec = serde_json::from_value(raw).unwrap();
        // A forged Docker driver must not route an otherwise valid Kubernetes target to an engine.
        assert!(spec.gateway.validate_managed().is_ok());
        assert!(spec.validate().is_err());
        assert!(spec.json().is_err());
        assert!(spec.container("/owned-data").is_err());
    }
}

#[test]
fn kubernetes_selects_the_gateway_driver_and_preserves_it_on_export() {
    let input = external_document();
    let document = Document::parse(input.to_string().as_bytes()).unwrap();
    assert_eq!(
        document.spec.gateway.compute_driver().as_str(),
        "kubernetes"
    );
    assert!(jsonschema::is_valid(&schema::input_schema(), &input));
    let exported = document.yaml().unwrap();
    let imported = Document::parse(exported.as_bytes()).unwrap();
    assert_eq!(imported.digest(), document.digest());
    assert_eq!(
        imported.spec.gateway.compute_driver(),
        ComputeDriver::Kubernetes
    );
}

#[test]
fn kubernetes_requires_an_explicit_nonempty_image_before_defaults() {
    let validator = jsonschema::validator_for(&schema::input_schema()).unwrap();
    for image in [None, Some(json!({})), Some(json!({"ref": ""}))] {
        let mut input = external_document();
        let sandbox = input["spec"]["sandboxes"]["assistant"]
            .as_object_mut()
            .unwrap();
        match image {
            Some(image) => {
                sandbox.insert("image".into(), image);
            }
            None => {
                sandbox.remove("image");
            }
        }
        assert!(!validator.is_valid(&input), "{input}");
        assert!(Document::parse(input.to_string().as_bytes()).is_err());
    }
}

#[test]
fn directly_constructed_kubernetes_sandboxes_never_default_their_image() {
    let mut document = Document::parse(external_document().to_string().as_bytes()).unwrap();
    document.spec.sandboxes.get_mut("assistant").unwrap().image = Default::default();
    assert!(document.validate().is_err());
    document.defaults();
    assert!(document.spec.sandboxes["assistant"].image.ref_.is_empty());
    assert!(document.validate().is_err());
}

#[test]
fn a_managed_gateway_without_a_cluster_target_rejects_image_metadata() {
    let mut input = external_document();
    input["spec"]["gateway"] = json!({"management": "managed"});
    assert!(!jsonschema::is_valid(&schema::input_schema(), &input));
    let error = schema_error(&input);
    assert!(
        error.contains("schema at spec.sandboxes.assistant.image (line")
            && error.ends_with(
                "): image.metadata is available only for a spec.gateway.target.kubernetes gateway; Docker and Podman use engine image inspection"
            ),
        "{error}"
    );
}

#[test]
fn kubernetes_rejects_managed_services_even_when_no_route_selects_them() {
    let managed =
        Document::parse(include_bytes!("fixtures/config/managed-ollama.yaml").as_slice()).unwrap();
    for mut input in [external_document(), managed_document()] {
        let mut document = Document::parse(input.to_string().as_bytes()).unwrap();
        input["spec"]["services"] = serde_json::to_value(managed.spec.services.clone()).unwrap();
        assert!(Document::parse(input.to_string().as_bytes()).is_err());
        assert!(!jsonschema::is_valid(&schema::input_schema(), &input));
        document.spec.services = managed.spec.services.clone();
        assert!(document.validate().is_err());
    }
}

#[test]
fn kubernetes_does_not_relax_gateway_transport_or_credential_validation() {
    for endpoint in [
        "http://gateway.example.test:8080",
        "https://user:password@gateway.example.test",
        "https://gateway.example.test?token=secret",
    ] {
        let mut input = external_document();
        input["spec"]["gateway"]["endpoint"] = json!(endpoint);
        assert!(Document::parse(input.to_string().as_bytes()).is_err());
    }
}

fn schema_error(input: &Value) -> String {
    Document::parse(input.to_string().as_bytes())
        .unwrap_err()
        .to_string()
}

#[test]
fn a_kubernetes_target_requires_an_explicit_https_loopback_endpoint() {
    let rule = "managed Kubernetes requires an explicit HTTPS 127.0.0.1 endpoint with a nonzero port and no path";
    Document::parse(managed_document().to_string().as_bytes()).unwrap();
    let mut missing = managed_document();
    missing["spec"]["gateway"]["target"]["kubernetes"]
        .as_object_mut()
        .unwrap()
        .remove("endpoint");
    let mut http = managed_document();
    http["spec"]["gateway"]["target"]["kubernetes"]["endpoint"] = json!("http://127.0.0.1:17671");
    for (input, path) in [
        (missing, "spec.gateway.target.kubernetes"),
        (http, "spec.gateway.target.kubernetes.endpoint"),
    ] {
        assert!(!jsonschema::is_valid(&schema::input_schema(), &input));
        let error = schema_error(&input);
        assert!(
            error.contains(&format!("schema at {path} (line")) && error.contains(rule),
            "{error}"
        );
    }
}

#[test]
fn a_kubernetes_target_excludes_local_engine_settings() {
    let validator = jsonschema::validator_for(&schema::input_schema()).unwrap();
    assert!(validator.is_valid(&managed_document()));
    for (field, value) in [
        ("engine", json!("unix:///var/run/docker.sock")),
        ("networkCidr", json!("172.30.1.0/24")),
        ("imagePullPolicy", json!("Never")),
        ("image", json!(nemoclaw_sdk::config::DEFAULT_GATEWAY_IMAGE)),
    ] {
        let mut input = managed_document();
        input["spec"]["gateway"]["target"]["kubernetes"][field] = value;
        assert!(!validator.is_valid(&input), "accepted {field}");
        let error = schema_error(&input);
        assert!(
            error.contains("schema at spec.gateway.target.kubernetes (line"),
            "{error}"
        );
    }
}

#[test]
fn an_external_kubernetes_target_requires_image_metadata_and_rejects_services() {
    let validator = jsonschema::validator_for(&schema::input_schema()).unwrap();
    let input = external_document();
    assert!(validator.is_valid(&input));
    Document::parse(input.to_string().as_bytes()).unwrap();
    for field in ["ref", "metadata"] {
        let mut input = external_document();
        input["spec"]["sandboxes"]["assistant"]["image"]
            .as_object_mut()
            .unwrap()
            .remove(field);
        assert!(!validator.is_valid(&input), "{field}");
        let error = schema_error(&input);
        assert!(
            error.contains("schema at spec.sandboxes.assistant.image (line")
                && error.ends_with(
                    "): a Kubernetes target requires each sandbox image.ref pinned by digest and image.metadata"
                ),
            "{error}"
        );
    }
    let managed =
        Document::parse(include_bytes!("fixtures/config/managed-ollama.yaml").as_slice()).unwrap();
    for mut input in [external_document(), managed_document()] {
        input["spec"]["services"] = serde_json::to_value(&managed.spec.services).unwrap();
        assert!(!validator.is_valid(&input));
        let error = schema_error(&input);
        assert!(
            error.contains("schema at spec.services (line")
                && error.contains("managed services are not supported"),
            "{error}"
        );
    }
    // Docker and Podman inspect their engine instead.
    let mut docker = external_document();
    docker["spec"]["gateway"]["target"] = json!({"docker": {}});
    assert!(!validator.is_valid(&docker));
    assert!(Document::parse(docker.to_string().as_bytes()).is_err());
}

#[test]
fn a_reserved_kubernetes_environment_name_states_the_naming_rule() {
    let mut input = managed_document();
    input["spec"]["gateway"]["target"]["kubernetes"]["environment"] =
        json!(["AWS_PROFILE", "KUBECONFIG"]);
    let error = schema_error(&input);
    assert!(
        error.contains("schema at spec.gateway.target.kubernetes.environment[1] (line")
            && error.contains(
                "Kubernetes environment names must be unique variable names that do not shadow process, trust, proxy, or cluster controls"
            ),
        "{error}"
    );
    assert!(!error.contains("KUBECONFIG"), "{error}");
}

#[test]
fn a_reserved_reference_name_states_whether_the_reference_holds_a_secret_or_a_file_path() {
    let secret = "secret reference must name a valid environment variable that does not shadow managed Kubernetes runtime controls";
    let file = "file reference must name a valid environment variable that does not shadow managed Kubernetes runtime controls";
    let mut external = external_document();
    external["spec"]["gateway"]["endpoint"] = json!("https://openshell.example.com");
    external["spec"]["gateway"]["credential"] = json!({"env": "GATEWAY_TOKEN"});
    external["spec"]["gateway"]["tls"] = json!({
        "ca": {"env": "GATEWAY_CA"},
        "certificate": {"env": "GATEWAY_CERT"},
        "key": {"env": "GATEWAY_KEY"}
    });
    external["spec"]["inferenceProviders"]["local"]["endpoint"] =
        json!("https://inference.example/v1");
    external["spec"]["inferenceProviders"]["local"]["credential"] =
        json!({"env": "HOSTED_API_KEY"});
    external["spec"]["sandboxes"]["assistant"]["integrations"] = json!({
        "search": {"kind": "webSearch", "provider": "brave", "credential": {"env": "SEARCH_KEY"}}
    });
    external["spec"]["sandboxes"]["assistant"]["agent"]["integrationRefs"] = json!(["search"]);
    Document::parse(external.to_string().as_bytes()).unwrap();
    for (mut input, pointer, path, rule) in [
        (
            external.clone(),
            "/spec/gateway/credential",
            "spec.gateway.credential.env",
            secret,
        ),
        (
            external.clone(),
            "/spec/inferenceProviders/local/credential",
            "spec.inferenceProviders.local.credential.env",
            secret,
        ),
        (
            external.clone(),
            "/spec/sandboxes/assistant/integrations/search/credential",
            "spec.sandboxes.assistant.integrations.search.credential.env",
            secret,
        ),
        (
            external.clone(),
            "/spec/gateway/tls/ca",
            "spec.gateway.tls.ca.env",
            file,
        ),
        (
            external.clone(),
            "/spec/gateway/tls/certificate",
            "spec.gateway.tls.certificate.env",
            file,
        ),
        (
            external.clone(),
            "/spec/gateway/tls/key",
            "spec.gateway.tls.key.env",
            file,
        ),
        (
            external,
            "/spec/sandboxes/assistant/image/metadata",
            "spec.sandboxes.assistant.image.metadata.env",
            file,
        ),
        (
            managed_document(),
            "/spec/gateway/target/kubernetes/kubeconfig",
            "spec.gateway.target.kubernetes.kubeconfig.env",
            file,
        ),
    ] {
        *input.pointer_mut(pointer).unwrap() = json!({"env": "KUBE_TOKEN"});
        let error = schema_error(&input);
        assert!(
            error.contains(&format!("schema at {path} (line")) && error.contains(rule),
            "{error}"
        );
        assert!(!error.contains("KUBE_TOKEN"), "{error}");
        let error = serde_json::from_value::<Document>(input)
            .unwrap()
            .validate()
            .unwrap_err()
            .to_string();
        assert!(error.contains(rule), "{error}");
    }
}
