// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use nemoclaw_sdk::config::Document;
use serde_json::{Value, json};

#[test]
fn anthropic_with_claude_should_work() {
    let desired = DesiredState::from_yaml(include_bytes!("../../../examples/fabric-claude.yaml"))
        .provider_endpoint("https://api.anthropic.com/v1")
        .provider_credential("ANTHROPIC_API_KEY");
    let document = Document::parse(desired.yaml().as_bytes()).unwrap();
    let desired = normalized(&document);
    assert_eq!(
        desired["spec"]["inferenceProviders"]["local"]["provider"],
        "anthropic"
    );
    assert_eq!(
        desired["spec"]["inferenceProviders"]["local"]["endpoint"],
        "https://api.anthropic.com/v1"
    );
    assert_eq!(
        desired["spec"]["sandboxes"]["assistant"]["harness"]["kind"],
        "nvidia.fabric.claude"
    );
    assert_eq!(document.credential_names(), ["ANTHROPIC_API_KEY"]);
}

#[test]
fn anthropic_compatible_endpoint_should_work() {
    let desired = DesiredState::from_yaml(include_bytes!("../../../examples/fabric-claude.yaml"))
        .provider_endpoint("https://anthropic.example.com/v1")
        .provider_credential("COMPATIBLE_ANTHROPIC_API_KEY");
    let document = Document::parse(desired.yaml().as_bytes()).unwrap();
    let desired = normalized(&document);
    assert_eq!(
        desired["spec"]["inferenceProviders"]["local"]["provider"],
        "anthropic"
    );
    assert_eq!(
        desired["spec"]["inferenceProviders"]["local"]["endpoint"],
        "https://anthropic.example.com/v1"
    );
    assert_eq!(
        document.credential_names(),
        ["COMPATIBLE_ANTHROPIC_API_KEY"]
    );
}

#[test]
fn openai_compatible_endpoint_with_tuning_should_work() {
    let desired =
        DesiredState::from_yaml(include_bytes!("../../../examples/inference-tuning.yaml"))
            .provider_credential("COMPATIBLE_API_KEY");
    let document = Document::parse(desired.yaml().as_bytes()).unwrap();
    let desired = normalized(&document);
    let overrides =
        &desired["spec"]["sandboxes"]["assistant"]["agent"]["inference"]["routes"][0]["overrides"];
    assert_eq!(
        desired["spec"]["inferenceProviders"]["local"]["api"],
        "openai-responses"
    );
    assert_eq!(
        desired["spec"]["inferenceProviders"]["local"]["endpoint"],
        "https://inference.example.com/v1"
    );
    assert_eq!(document.credential_names(), ["COMPATIBLE_API_KEY"]);
    assert_eq!(overrides["settings"]["reasoning_effort"], "high");
    assert_eq!(
        overrides["settings"]["model_metadata"]["contextWindow"],
        65536
    );
    assert_eq!(overrides["maxTokens"], 8192);
    assert_eq!(overrides["settings"]["model_metadata"]["reasoning"], true);
}

#[test]
fn openai_endpoint_should_work() {
    let desired =
        DesiredState::from_yaml(include_bytes!("../../../examples/inference-tuning.yaml"))
            .provider_endpoint("https://api.openai.com/v1")
            .provider_credential("OPENAI_API_KEY");
    let document = Document::parse(desired.yaml().as_bytes()).unwrap();
    let desired = normalized(&document);
    assert_eq!(
        desired["spec"]["inferenceProviders"]["local"]["endpoint"],
        "https://api.openai.com/v1"
    );
    assert_eq!(document.credential_names(), ["OPENAI_API_KEY"]);
}

#[test]
fn openrouter_endpoint_should_work() {
    let desired =
        DesiredState::from_yaml(include_bytes!("../../../examples/inference-tuning.yaml"))
            .provider_endpoint("https://openrouter.ai/api/v1")
            .provider_credential("OPENROUTER_API_KEY");
    let document = Document::parse(desired.yaml().as_bytes()).unwrap();
    let desired = normalized(&document);
    assert_eq!(
        desired["spec"]["inferenceProviders"]["local"]["endpoint"],
        "https://openrouter.ai/api/v1"
    );
    assert_eq!(document.credential_names(), ["OPENROUTER_API_KEY"]);
}

#[test]
fn deep_agents_should_work() {
    let yaml = include_bytes!("../../../examples/fabric.yaml");
    let document = Document::parse(yaml.as_slice()).unwrap();
    let desired = normalized(&document);
    assert_eq!(
        desired["spec"]["sandboxes"]["assistant"]["harness"]["kind"],
        "nvidia.fabric.langchain.deepagents"
    );
}

#[test]
fn multiple_openclaw_sandboxes_with_policy_tools_and_observability_should_work() {
    let yaml = include_bytes!("../../../examples/full-featured-openclaw.yaml");
    let document = Document::parse(yaml.as_slice()).unwrap();
    let desired = normalized(&document);
    let sandboxes = desired["spec"]["sandboxes"].as_object().unwrap();
    assert_eq!(sandboxes.len(), 3);
    for name in ["researcher", "writer", "reader"] {
        assert_eq!(sandboxes[name]["agent"]["name"], name);
    }
    assert_eq!(
        sandboxes["reader"]["agent"]["tools"]["allow"],
        json!(["read"])
    );
    assert_eq!(
        desired["spec"]["harnesses"]["assistant"]["settings"]["native_config"]["tools"]["toolSearch"]
            ["mode"],
        "tools"
    );
    assert_eq!(
        desired["spec"]["harnesses"]["assistant"]["settings"]["native_config"]["diagnostics"]["otel"]
            ["enabled"],
        true
    );
    assert_eq!(
        desired["spec"]["harnesses"]["assistant"]["execution"]["timeoutSeconds"],
        900
    );
}

#[test]
fn pi_with_native_model_metadata_should_work() {
    let yaml = include_bytes!("../../../examples/fabric-pi.yaml");
    let document = Document::parse(yaml.as_slice()).unwrap();
    let desired = normalized(&document);
    assert_eq!(
        desired["spec"]["sandboxes"]["assistant"]["harness"]["kind"],
        "nvidia.fabric.pi"
    );
    assert_eq!(
        desired["spec"]["sandboxes"]["assistant"]["agent"]["inference"]["routes"][0]["overrides"]["settings"]
            ["model_metadata"]["api"],
        "openai-completions"
    );
}

#[test]
fn managed_ollama_should_work() {
    let yaml = include_bytes!("../../../examples/managed-ollama.yaml");
    let document = Document::parse(yaml.as_slice()).unwrap();
    let desired = normalized(&document);
    let service = desired["spec"]["inferenceProviders"]["local"]["serviceRef"]
        .as_str()
        .unwrap();
    assert_eq!(desired["spec"]["services"][service]["kind"], "ollama");
}

#[test]
fn managed_vllm_should_work() {
    let yaml = include_bytes!("../../../examples/nemotron-amd64.yaml");
    let document = Document::parse(yaml.as_slice()).unwrap();
    let desired = normalized(&document);
    let service = desired["spec"]["inferenceProviders"]["nemotron"]["serviceRef"]
        .as_str()
        .unwrap();
    assert_eq!(desired["spec"]["services"][service]["kind"], "vllm");
    assert_eq!(
        desired["spec"]["services"][service]["hardware"]["minComputeCapability"],
        90
    );
}

#[test]
fn external_ollama_proxy_should_work() {
    let desired = DesiredState::from_yaml(include_bytes!("../../../examples/managed-ollama.yaml"))
        .external_ollama_proxy();
    let document = Document::parse(desired.yaml().as_bytes()).unwrap();
    let desired = normalized(&document);
    let service = desired["spec"]["inferenceProviders"]["local"]["serviceRef"]
        .as_str()
        .unwrap();
    assert_eq!(
        desired["spec"]["services"][service]["upstream"]["endpoint"],
        "http://127.0.0.1:11434/v1"
    );
    assert_eq!(
        desired["spec"]["services"][service]["endpoint"],
        "http://172.20.0.1:11435/v1"
    );
}

#[test]
fn managed_podman_with_an_explicit_gateway_port_should_work() {
    let desired = DesiredState::from_yaml(include_bytes!("../../../examples/managed-podman.yaml"))
        .gateway_endpoint("http://127.0.0.1:17891");
    let document = Document::parse(desired.yaml().as_bytes()).unwrap();
    let desired = normalized(&document);
    assert_eq!(desired["spec"]["gateway"]["management"], "managed");
    assert_eq!(
        desired["spec"]["gateway"]["target"]["podman"]["engine"],
        "unix:///run/user/1000/podman/podman.sock"
    );
    assert_eq!(
        desired["spec"]["gateway"]["target"]["podman"]["endpoint"],
        "http://127.0.0.1:17891"
    );
    assert_eq!(
        document.spec.gateway.compute_driver(),
        nemoclaw_sdk::config::ComputeDriver::Podman
    );
}

#[test]
fn openclaw_dashboard_should_work() {
    let yaml = include_bytes!("../../../examples/openclaw-dashboard.yaml");
    let document = Document::parse(yaml.as_slice()).unwrap();
    let desired = normalized(&document);
    assert_eq!(
        desired["spec"]["sandboxes"]["assistant"]["harness"]["settings"]["native_config"]["gateway"]
            ["port"],
        18800
    );
}

#[test]
fn hermes_api_dashboard_and_tui_should_work() {
    let yaml = include_bytes!("../../../examples/hermes-interfaces.yaml");
    let document = Document::parse(yaml.as_slice()).unwrap();
    let desired = normalized(&document);
    let interfaces =
        &desired["spec"]["sandboxes"]["assistant"]["harness"]["settings"]["interfaces"];
    assert_eq!(
        desired["spec"]["sandboxes"]["assistant"]["harness"]["kind"],
        "nvidia.fabric.hermes"
    );
    assert_eq!(interfaces["api"]["port"], 8643);
    assert_eq!(interfaces["dashboard"]["enabled"], true);
    assert_eq!(interfaces["dashboard"]["port"], 18800);
    assert_eq!(interfaces["dashboard"]["internalPort"], 19120);
    assert_eq!(interfaces["dashboard"]["tui"]["enabled"], true);
}

#[test]
fn brave_web_search_should_work() {
    let yaml = include_bytes!("../../../examples/openclaw-web-search.yaml");
    let document = Document::parse(yaml.as_slice()).unwrap();
    let desired = normalized(&document);
    assert_eq!(
        desired["spec"]["integrations"]["search"]["kind"],
        "webSearch"
    );
    assert_eq!(
        desired["spec"]["integrations"]["search"]["credential"]["env"],
        "BRAVE_API_KEY"
    );
    assert_eq!(document.credential_names(), ["BRAVE_API_KEY"]);
}

#[test]
fn invalid_sandbox_names_are_rejected() {
    let desired = DesiredState::openclaw().sandbox_name("Not A DNS Label");
    let result = Document::parse(desired.yaml().as_bytes());
    assert!(
        result.is_err(),
        "sandbox names must remain valid DNS labels"
    );
}

#[test]
fn image_input_modalities_are_not_supported_yet() {
    let desired = DesiredState::openclaw().inference_inputs(&["text", "image"]);
    let result = Document::parse(desired.yaml().as_bytes());
    assert!(
        result.is_err(),
        "configuration must reject unsupported model input modalities"
    );
}

#[test]
fn gemini_is_not_supported_yet() {
    let desired = DesiredState::openclaw().provider_kind("google", "gemini-generate");
    let result = Document::parse(desired.yaml().as_bytes());
    assert!(
        result.is_err(),
        "configuration must reject unsupported Gemini providers"
    );
}

#[test]
fn llama_cpp_is_not_supported_yet() {
    let desired = DesiredState::from_yaml(include_bytes!("../../../examples/nemotron-amd64.yaml"))
        .service_backend("llamacpp");
    let result = Document::parse(desired.yaml().as_bytes());
    assert!(
        result.is_err(),
        "configuration must reject unsupported llama.cpp services"
    );
}

#[test]
fn model_routing_is_not_supported_yet() {
    let desired = DesiredState::openclaw().model_router();
    let result = Document::parse(desired.yaml().as_bytes());
    assert!(
        result.is_err(),
        "configuration must reject unsupported model-routing intent"
    );
}

#[test]
fn sandbox_resource_sizing_is_not_supported_yet() {
    let desired = DesiredState::openclaw().sandbox_resources();
    let result = Document::parse(desired.yaml().as_bytes());
    assert!(
        result.is_err(),
        "configuration must reject unsupported sandbox resource sizing"
    );
}

#[test]
fn serving_profile_provenance_is_not_supported_yet() {
    let desired = DesiredState::openclaw().serving_profile();
    let result = Document::parse(desired.yaml().as_bytes());
    assert!(
        result.is_err(),
        "configuration must reject unsupported serving-profile provenance"
    );
}

#[test]
fn sandbox_gpu_selection_is_not_supported_yet() {
    let desired = DesiredState::openclaw().sandbox_gpu();
    let result = Document::parse(desired.yaml().as_bytes());
    assert!(
        result.is_err(),
        "configuration must reject unsupported sandbox GPU selection"
    );
}

#[test]
fn host_mounts_are_not_supported_yet() {
    let desired = DesiredState::openclaw().host_mount();
    let result = Document::parse(desired.yaml().as_bytes());
    assert!(
        result.is_err(),
        "configuration must reject unsupported read-only host mounts"
    );
}

#[test]
fn hermes_provider_tools_are_not_supported_yet() {
    let desired = DesiredState::openclaw().hermes_provider_tools();
    let result = Document::parse(desired.yaml().as_bytes());
    assert!(
        result.is_err(),
        "configuration must reject unsupported Hermes provider tools"
    );
}

#[test]
fn trusted_private_hosts_are_not_supported_yet() {
    let desired = DesiredState::openclaw().trusted_private_hosts();
    let result = Document::parse(desired.yaml().as_bytes());
    assert!(
        result.is_err(),
        "configuration must reject unsupported trusted private hosts"
    );
}

#[test]
fn tavily_search_preserves_the_selected_provider_and_credential_reference() {
    let desired =
        DesiredState::from_yaml(include_bytes!("../../../examples/openclaw-web-search.yaml"))
            .search_provider("tavily", "TAVILY_API_KEY");
    let document = Document::parse(desired.yaml().as_bytes()).expect("Tavily intent must parse");
    assert!(document.credential_names().contains(&"TAVILY_API_KEY"));
    let normalized = serde_json::to_value(&document).unwrap();
    assert_eq!(
        normalized["spec"]["integrations"]["search"]["provider"],
        "tavily"
    );
    assert_eq!(
        Document::parse(document.yaml().unwrap().as_bytes()).unwrap(),
        document
    );
}

#[test]
fn messaging_channels_are_not_supported_yet() {
    let desired = DesiredState::openclaw().messaging_channel();
    let result = Document::parse(desired.yaml().as_bytes());
    assert!(
        result.is_err(),
        "configuration must reject unsupported messaging channels"
    );
}

fn normalized(document: &Document) -> Value {
    serde_json::to_value(document).unwrap()
}

/// The single entry of a sandbox or provider map.
fn only(map: &mut Value) -> &mut Value {
    let map = map.as_object_mut().unwrap();
    assert_eq!(map.len(), 1);
    map.values_mut().next().unwrap()
}

struct DesiredState {
    value: Value,
}

impl DesiredState {
    fn openclaw() -> Self {
        Self::from_yaml(include_bytes!("../../../examples/fabric-openclaw.yaml"))
    }

    fn from_yaml(yaml: &[u8]) -> Self {
        Self {
            value: serde_saphyr::from_slice(yaml).unwrap(),
        }
    }

    /// The example's only sandbox.
    fn sandbox(&mut self) -> &mut Value {
        only(&mut self.value["spec"]["sandboxes"])
    }

    /// The example's only deployment provider.
    fn provider(&mut self) -> &mut Value {
        only(&mut self.value["spec"]["inferenceProviders"])
    }

    fn provider_endpoint(mut self, endpoint: &str) -> Self {
        self.provider()["endpoint"] = json!(endpoint);
        self
    }

    fn provider_credential(mut self, environment_variable: &str) -> Self {
        self.provider()["credential"] = json!({"env": environment_variable});
        self
    }

    fn provider_kind(mut self, provider: &str, api: &str) -> Self {
        self.provider()["provider"] = json!(provider);
        self.provider()["api"] = json!(api);
        self
    }

    fn inference_inputs(mut self, inputs: &[&str]) -> Self {
        self.sandbox()["agent"]["inference"]["routes"][0]["overrides"]["input"] = json!(inputs);
        self
    }

    fn sandbox_name(mut self, name: &str) -> Self {
        let sandboxes = self.value["spec"]["sandboxes"].as_object_mut().unwrap();
        let sandbox = sandboxes.values().next().unwrap().clone();
        sandboxes.clear();
        sandboxes.insert(name.into(), sandbox);
        self
    }

    fn service_backend(mut self, backend: &str) -> Self {
        let service = self.provider()["serviceRef"].as_str().unwrap().to_owned();
        self.value["spec"]["services"][service]["kind"] = json!(backend);
        self
    }

    fn model_router(mut self) -> Self {
        self.value["spec"]["modelRouter"] =
            json!({"profile": "balanced", "routes": ["hosted", "local"]});
        self
    }

    fn sandbox_resources(mut self) -> Self {
        self.sandbox()["resources"] = json!({"cpu": "4", "memory": "16Gi"});
        self
    }

    fn serving_profile(mut self) -> Self {
        self.value["spec"]["servingProfile"] =
            json!({"id": "vllm.dgx-spark.example", "catalogDigest": "sha256:proposal"});
        self
    }

    fn sandbox_gpu(mut self) -> Self {
        self.value["spec"]["gateway"]["target"]["docker"]["gpu"] =
            json!({"required": true, "device": "nvidia.com/gpu=0"});
        self
    }

    fn host_mount(mut self) -> Self {
        self.value["spec"]["gateway"]["target"]["docker"]["hostMounts"] = json!([{
            "source": "/home/user/project",
            "target": "/sandbox/project",
            "readOnly": true
        }]);
        self
    }

    fn hermes_provider_tools(mut self) -> Self {
        self.sandbox()["harness"]["providerAuthentication"] = json!({"method": "oauth"});
        self.sandbox()["harness"]["toolGateways"] = json!(["nous-web"]);
        self.sandbox()["credentialPlaceholderExtensions"] = json!(["TELEGRAM_BOT_TOKEN_AGENT_A"]);
        self
    }

    fn trusted_private_hosts(mut self) -> Self {
        self.sandbox()["network"]["trustedPrivateHosts"] =
            json!(["10.10.0.12", "inference.corp.example"]);
        self
    }

    fn search_provider(mut self, provider: &str, credential: &str) -> Self {
        self.value["spec"]["integrations"]["search"]["provider"] = json!(provider);
        self.value["spec"]["integrations"]["search"]["credential"]["env"] = json!(credential);
        self
    }

    fn messaging_channel(mut self) -> Self {
        self.sandbox()["channels"] =
            json!([{"kind": "slack", "credential": {"env": "SLACK_BOT_TOKEN"}}]);
        self
    }

    fn external_ollama_proxy(mut self) -> Self {
        let service = &mut self.value["spec"]["services"]["ollama-server"];
        let model = service["model"]["name"].clone();
        *service = json!({
            "kind": "ollamaProxy",
            "image": format!("nc-ollama-proxy@sha256:{}", "a".repeat(64)),
            "endpoint": "http://172.20.0.1:11435/v1",
            "upstream": {
                "endpoint": "http://127.0.0.1:11434/v1",
                "model": {"name": model, "digest": "a".repeat(64)},
            }
        });
        self
    }

    fn gateway_endpoint(mut self, endpoint: &str) -> Self {
        let target = self.value["spec"]["gateway"]["target"]
            .as_object_mut()
            .unwrap();
        target.values_mut().next().unwrap()["endpoint"] = json!(endpoint);
        self
    }

    fn yaml(&self) -> String {
        serde_saphyr::to_string(&self.value).unwrap()
    }
}

/// Five sandboxes, declared out of name order, select deployment, sandbox,
/// inline sandbox, and inline deployment providers. Two sandboxes declare a
/// provider with the same name.
fn keyed_scopes() -> Value {
    let mut value: Value =
        serde_saphyr::from_str(include_str!("../../../examples/multiple-sandboxes.yaml")).unwrap();
    value["spec"]["inferences"]["inline-chat"] = json!({"routes": [{
        "name": "primary",
        "provider": {"name": "shared-inline", "provider": "openai", "endpoint": "http://172.20.0.1:11449/v1"},
        "overrides": {"model": "qwen3:4b"}
    }]});
    let sandboxes = &mut value["spec"]["sandboxes"];
    sandboxes["alice"]["agent"] = json!({"name": "alice", "inference": {"routes": [{
        "name": "primary",
        "provider": {"name": "alice-local", "provider": "openai", "endpoint": "http://172.20.0.1:11448/v1"},
        "overrides": {"model": "qwen3:4b"}
    }]}});
    for (sandbox, agent) in [("bob", "bob"), ("coding", "coder")] {
        sandboxes[sandbox]["inferenceProviders"] = json!({"own": {
            "provider": "openai",
            "endpoint": "http://172.20.0.1:11447/v1"
        }});
        sandboxes[sandbox]["agent"] = json!({"name": agent, "inference": {"routes": [{
            "name": "primary", "providerRef": "own", "overrides": {"model": "qwen3:4b"}
        }]}});
    }
    sandboxes["review"]["agent"]["inferenceRef"] = json!("inline-chat");
    value
}

#[test]
fn keyed_sandboxes_and_providers_keep_the_resource_identities_of_named_entries() {
    use nemoclaw_sdk::compile::{Generations, compile, targets};
    let document = Document::parse(keyed_scopes().to_string().as_bytes()).unwrap();
    let generations: Generations = [
        "workspace",
        "provider",
        "sandbox",
        "managed_gateway",
        "inference_service",
        "ollama",
        "ollama_proxy",
    ]
    .map(|key| (key.into(), "a".repeat(32)))
    .into();
    let rows = targets(&document, &generations).unwrap();
    let graph = compile(&document, &generations, "0.1.0").unwrap();
    // Recorded from the same deployment authored as lists of named entries.
    let registrations = [
        "alice-local-f11c16aa4f659d8e6299464a",
        "local-3d36801b67957c3bcfa1093b",
        "own-85a913ad5423a77eb0892729",
        "own-8b0d99bb9c608112cc047ea2",
        "shared-inlin-f02e6745609dc72d5e7de733",
    ];
    let sandboxes = [
        ("alice", "alice-local-f11c16aa4f659d8e6299464a"),
        ("bob", "own-85a913ad5423a77eb0892729"),
        ("coding", "own-8b0d99bb9c608112cc047ea2"),
        ("research", "local-3d36801b67957c3bcfa1093b"),
        ("review", "shared-inlin-f02e6745609dc72d5e7de733"),
    ];
    let mut expected: Vec<String> = registrations
        .iter()
        .flat_map(|key| {
            [
                format!("openshell_provider_profile.inference_{key}"),
                format!("openshell_provider_registration.inference_{key}"),
            ]
        })
        .chain(sandboxes.iter().flat_map(|(name, _)| {
            [
                format!("fabric_agent_configuration.{name}"),
                format!("openshell_sandbox.{name}"),
            ]
        }))
        .chain(["openshell_workspace.deployment".into()])
        .collect();
    expected.sort();
    let mut addresses: Vec<_> = rows.iter().map(|row| row.address.clone()).collect();
    addresses.sort();
    assert_eq!(addresses, expected);
    for (index, (name, registration)) in sandboxes.into_iter().enumerate() {
        let row = rows
            .iter()
            .find(|row| row.address == format!("openshell_sandbox.{name}"))
            .unwrap();
        assert_eq!(row.values["name"], name);
        assert_eq!(
            row.values["provider_names_json"],
            format!(r#"["{registration}"]"#)
        );
        // Fabric reads are numbered in name order.
        assert_eq!(
            graph["resource"]["openshell_sandbox"][name]["runtime_json"],
            format!("${{data.fabric_capabilities.sandbox_{index}.runtime_json}}")
        );
    }
}
