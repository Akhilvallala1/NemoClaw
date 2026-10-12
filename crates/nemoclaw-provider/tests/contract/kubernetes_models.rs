// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Authored HCL drives both cluster model resources through OpenTofu. Only
//! the Kubernetes API, kubelet, and runtime status are simulated.

use crate::{kube_api::Objects, kubernetes_model_api::Api, tofu::TofuWorkspace};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, fs};

const NAME: &str = "nc-0123456789abcdef-model-0123456789abcdef";
const NAMESPACE: &str = "agents";
const STORAGE: &str = "nemoclaw_kubernetes_service_storage";
const SERVICE: &str = "nemoclaw_kubernetes_service";

struct Model {
    objects: Objects,
    _api: Api,
    workspace: TofuWorkspace,
    variables: Value,
}

/// An OCI manifest and config with the runtime's required image labels. This
/// derives from SDK image_metadata/tests.rs at 2c63aaa9; the contract fixture
/// uses one AMD64 image and does not build a deployment document.
fn image_metadata(backend: &str) -> (String, Value) {
    let mut blobs = BTreeMap::new();
    let mut add = |value: Value| {
        let text = value.to_string();
        let hex: String = Sha256::digest(text.as_bytes())
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        let digest = format!("sha256:{hex}");
        let size = text.len();
        blobs.insert(digest.clone(), text);
        (digest, size)
    };
    let (config, size) = add(
        json!({"os":"linux", "architecture":"amd64", "config":{"Labels":{
            "org.nemoclaw.runtime.spec":"v1", "org.nemoclaw.backend":backend,
            "org.nemoclaw.inference.authentication":"bearer-v1"
        }}}),
    );
    let (manifest, _) = add(
        json!({"schemaVersion":2, "mediaType":"application/vnd.oci.image.manifest.v1+json",
        "config":{"mediaType":"application/vnd.oci.image.config.v1+json", "digest":config, "size":size}, "layers":[]}),
    );
    (
        format!("registry.example/runtime@{manifest}"),
        json!({"schema_version":1, "manifest_digest":manifest, "blobs":blobs}),
    )
}

impl Model {
    async fn start(backend: &str) -> Self {
        let objects = Objects::default();
        for object in [
            json!({"apiVersion":"v1", "kind":"Namespace", "metadata":{"name":"kube-system", "uid":"system-1"}}),
            json!({"apiVersion":"storage.k8s.io/v1", "kind":"StorageClass", "metadata":{"name":"model-cache", "annotations":{"storageclass.kubernetes.io/is-default-class":"true"}}}),
            json!({"apiVersion":"apiextensions.k8s.io/v1", "kind":"CustomResourceDefinition", "metadata":{"name":"sandboxes.agents.x-k8s.io"}}),
            json!({"apiVersion":"apps/v1", "kind":"Deployment", "metadata":{"name":"agent-sandbox-controller", "namespace":"agent-sandbox-system"}, "status":{"availableReplicas":1}}),
            json!({"apiVersion":"v1", "kind":"Node", "metadata":{"name":"gpu-node", "labels":{"kubernetes.io/os":"linux", "kubernetes.io/arch":"amd64"}},
                "spec":{}, "status":{"conditions":[{"type":"Ready", "status":"True"}], "allocatable":{"cpu":"32", "memory":"256Gi", "nvidia.com/gpu":"2", "pods":"110"}}}),
        ] {
            objects.insert(object);
        }
        let api = Api::start(objects.clone()).await;
        let workspace = crate::workspace();
        let (image, metadata) = image_metadata(backend);
        for (file, value) in [
            (
                "cluster.kubeconfig",
                json!({"apiVersion":"v1", "kind":"Config",
                "clusters":[{"name":"fixture", "cluster":{"server":api.endpoint}}],
                "contexts":[{"name":"selected", "context":{"cluster":"fixture", "user":"fixture"}}],
                "users":[{"name":"fixture", "user":{}}]}),
            ),
            ("metadata.json", metadata),
        ] {
            fs::write(workspace.path().join(file), value.to_string()).unwrap();
        }
        fs::write(
            workspace.path().join("main.tf"),
            include_str!("kubernetes_models.tf"),
        )
        .unwrap();
        let mut runtime = json!({"kind":backend, "hardware":{"profile":"rtx-4090", "architecture":"amd64"},
            "serving":{"port":18888, "contextTokens":32768, "maxSequences":1, "startupTimeoutSeconds":1800},
            "memory":{"hostReserveGiB":32, "gpuMemoryGiB":16, "minAvailableGiB":8, "minFreeGiB":3, "freeGateGiB":12, "consecutiveSamples":5}});
        if backend == "vllm" {
            runtime["authentication"] = json!("bearer");
            runtime["model"] = json!({"repository":"fixture/model", "revision":"a".repeat(40)});
            runtime["serving"]["batchTokens"] = json!(1024);
            runtime["serving"]["speculativeTokens"] = json!(0);
            runtime["memory"]["kvCacheGiB"] = json!(6);
        } else {
            runtime["model"] = json!({"name":"qwen3:0.6b", "digest":"a".repeat(64)});
        }
        Self {
            objects,
            _api: api,
            workspace,
            variables: json!({"image":image, "runtime":runtime, "authenticated":backend == "vllm",
                "memory_limit":64, "keep_workload":true, "destroy":false}),
        }
    }

    fn tofu(&self, args: &[&str], success: bool) -> String {
        fs::write(
            self.workspace.path().join("terraform.tfvars.json"),
            self.variables.to_string(),
        )
        .unwrap();
        let output = self
            .workspace
            .command()
            .args(args)
            .env(
                "TEST_MODEL_KUBECONFIG",
                self.workspace.path().join("cluster.kubeconfig"),
            )
            .env(
                "TEST_MODEL_IMAGE_METADATA",
                self.workspace.path().join("metadata.json"),
            )
            .env(
                nemoclaw_sdk::kubernetes::STATE_ENV,
                self.workspace.path().join("kubernetes"),
            )
            .output()
            .unwrap();
        let text = format!(
            "{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(output.status.success(), success, "{args:?}: {text}");
        text
    }

    fn apply(&self, success: bool) -> String {
        self.tofu(
            &["apply", "-auto-approve", "-input=false", "-no-color"],
            success,
        )
    }

    fn snapshot(&self) -> BTreeMap<String, Value> {
        self.objects.0.lock().unwrap().clone()
    }

    fn state(&self) -> Value {
        serde_json::from_slice(&fs::read(self.workspace.path().join("terraform.tfstate")).unwrap())
            .unwrap()
    }

    fn resource(&self, kind: &str) -> Value {
        self.state()["resources"]
            .as_array()
            .unwrap()
            .iter()
            .find(|resource| resource["type"] == kind)
            .unwrap()["instances"][0]["attributes"]
            .clone()
    }

    fn object(&self, kind: &str) -> Value {
        self.objects
            .get(
                if kind == "NetworkPolicy" {
                    "networking.k8s.io/v1"
                } else {
                    "v1"
                },
                kind,
                NAMESPACE,
                NAME,
            )
            .unwrap()
    }

    fn claims(&self) -> Vec<Value> {
        self.snapshot()
            .into_values()
            .filter(|object| object["kind"] == "PersistentVolumeClaim")
            .collect()
    }
}

async fn lifecycle(backend: &str) {
    let mut model = Model::start(backend).await;
    let empty = model.snapshot();
    model.tofu(
        &["plan", "-input=false", "-no-color", "-out=create.plan"],
        true,
    );
    assert_eq!(model.snapshot(), empty, "planning must not create objects");
    model.tofu(&["apply", "-input=false", "-no-color", "create.plan"], true);
    let storage = model.resource(STORAGE);
    let service = model.resource(SERVICE);
    assert_eq!(storage["running"], "true");
    assert_eq!(service["running"], "true");
    assert!(storage["id"].as_str().is_some_and(|id| !id.is_empty()));
    assert!(service["id"].as_str().is_some_and(|id| !id.is_empty()));
    let claims = model.claims();
    assert_eq!(claims.len(), if backend == "vllm" { 2 } else { 1 });
    assert!(
        claims
            .iter()
            .any(|claim| claim["metadata"]["name"] == format!("{NAME}-data"))
    );
    if backend == "vllm" {
        assert!(
            claims
                .iter()
                .any(|claim| claim["metadata"]["name"] == format!("{NAME}-auth"))
        );
    }
    let deployed = model.snapshot();
    // Upgrade the fixture's pre-projection state through OpenTofu itself.
    // Existing deployments recorded both identities only in the serialized spec.
    let mut legacy = model.state();
    for resource in legacy["resources"].as_array_mut().unwrap() {
        if [STORAGE, SERVICE]
            .iter()
            .any(|kind| resource["type"] == *kind)
        {
            for instance in resource["instances"].as_array_mut().unwrap() {
                let attributes = instance["attributes"].as_object_mut().unwrap();
                attributes.remove("owner");
                attributes.remove("generation");
            }
        }
    }
    fs::write(
        model.workspace.path().join("terraform.tfstate"),
        legacy.to_string(),
    )
    .unwrap();
    let plan = model.tofu(
        &["plan", "-input=false", "-no-color", "-detailed-exitcode"],
        true,
    );
    assert!(plan.contains("No changes"), "{plan}");
    model.apply(true);
    assert_eq!(model.resource(STORAGE), storage);
    assert_eq!(model.resource(SERVICE), service);
    assert_eq!(
        model.snapshot(),
        deployed,
        "unchanged apply preserves object identities"
    );

    let pod = model.object("Pod");
    let network = [model.object("Service"), model.object("NetworkPolicy")];
    model.variables["memory_limit"] = json!(80);
    model.apply(true);
    let updated = model.object("Pod");
    assert_ne!(updated["metadata"]["uid"], pod["metadata"]["uid"]);
    assert_eq!(
        updated["spec"]["containers"][0]["resources"]["limits"]["memory"],
        "80Gi"
    );
    assert_eq!(
        [model.object("Service"), model.object("NetworkPolicy")],
        network
    );
    assert_eq!(model.claims(), claims);
    assert_eq!(model.resource(STORAGE), storage);
    assert_eq!(model.resource(SERVICE)["id"], service["id"]);

    // Explicit teardown removes compute while both durable bindings remain.
    model.variables["destroy"] = json!(true);
    model.variables["keep_workload"] = json!(false);
    model.apply(true);
    for (api, kind) in [
        ("v1", "Pod"),
        ("v1", "ConfigMap"),
        ("v1", "Service"),
        ("networking.k8s.io/v1", "NetworkPolicy"),
    ] {
        assert!(
            model.objects.get(api, kind, NAMESPACE, NAME).is_none(),
            "{kind}"
        );
    }
    assert_eq!(model.claims(), claims);
    assert_eq!(model.resource(STORAGE), storage);
    assert!(
        !model.state()["resources"]
            .as_array()
            .unwrap()
            .iter()
            .any(|resource| resource["type"] == SERVICE)
    );
    let retained = model.snapshot();
    let state = fs::read(model.workspace.path().join("terraform.tfstate")).unwrap();
    let refused = model.tofu(
        &["destroy", "-auto-approve", "-input=false", "-no-color"],
        false,
    );
    assert!(
        refused.contains("nemoclaw_kubernetes_service_storage.model"),
        "{refused}"
    );
    assert_eq!(model.snapshot(), retained);
    crate::assert_same_managed_resources(
        &fs::read(model.workspace.path().join("terraform.tfstate")).unwrap(),
        &state,
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires NEMOCLAW_TEST_BUNDLE; in-memory Kubernetes API and Pod exec"]
async fn vllm_resources_apply_refresh_update_and_destroy_keeping_model_and_credential_claims() {
    lifecycle("vllm").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires NEMOCLAW_TEST_BUNDLE; in-memory Kubernetes API and Pod exec"]
async fn ollama_resources_apply_refresh_update_and_destroy_keeping_model_claim() {
    lifecycle("ollama").await;
}
