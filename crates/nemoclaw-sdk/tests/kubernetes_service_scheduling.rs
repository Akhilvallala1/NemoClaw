// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::{operations, spec};
use nemoclaw_sdk::kubernetes::services::{Operations, Spec};
use serde_json::{Value, json};

async fn running(
    backend: &str,
) -> (
    Spec,
    crate::kube_api::Objects,
    tempfile::TempDir,
    crate::transport::Fixture,
    Operations,
    String,
) {
    let spec = spec(backend, backend == "vllm");
    let objects = crate::kube_api::Objects::default();
    let directory = tempfile::tempdir().unwrap();
    let (fixture, operations) = operations(&objects, directory.path(), &spec).await;
    operations
        .ensure_storage(&spec.storage(), None)
        .await
        .unwrap();
    let bound = operations.ensure(&spec, None).await.unwrap();
    let mut pod = objects.get("v1", "Pod", "agents", &spec.name).unwrap();
    pod["spec"]["nodeName"] = json!("gpu-node");
    pod["status"] = json!({"phase":"Running"});
    objects.insert(pod);
    objects.insert(json!({"apiVersion":"v1", "kind":"Node", "metadata":{
        "name":"gpu-node", "labels":{"kubernetes.io/os":"linux", "kubernetes.io/arch":spec.architecture, "gpu-pool":"inference"}},
        "status":{"conditions":[{"type":"Ready", "status":"True"}], "allocatable":{"cpu":"8", "memory":"64Gi", "nvidia.com/gpu":"1"}}}));
    (
        spec,
        objects,
        directory,
        fixture,
        operations,
        bound.id.unwrap(),
    )
}

async fn refuses_before_stopping(
    operations: &Operations,
    objects: &crate::kube_api::Objects,
    directory: &std::path::Path,
    desired: &Spec,
    id: &str,
    reason: &str,
) {
    let before = objects.0.lock().unwrap().clone();
    let receipt = directory
        .join("services")
        .join(&desired.name)
        .join("receipt.json");
    let saved = std::fs::read(&receipt).unwrap();
    for apply in [false, true] {
        let error = if apply {
            operations.ensure(desired, Some(id)).await.map(|_| ())
        } else {
            operations.preflight_workload(desired).await
        }
        .expect_err("replacement must be refused before the running Pod is stopped");
        let message = error.to_string();
        assert!(message.contains(reason), "{message}");
        assert!(message.contains(&desired.name), "{message}");
        assert_eq!(*objects.0.lock().unwrap(), before);
        assert_eq!(std::fs::read(&receipt).unwrap(), saved);
    }
}

#[tokio::test]
async fn excessive_memory_requests_preserve_the_running_pod_and_saved_receipt() {
    for backend in ["vllm", "ollama"] {
        let (mut desired, objects, directory, _fixture, operations, id) = running(backend).await;
        desired.settings.memory_request_gib = 128;
        desired.settings.memory_limit_gib = 128;
        refuses_before_stopping(
            &operations,
            &objects,
            directory.path(),
            &desired,
            &id,
            "memory",
        )
        .await;
    }
}

#[tokio::test]
async fn an_untolerated_node_taint_preserves_the_running_pod_and_saved_receipt() {
    for backend in ["vllm", "ollama"] {
        let (mut desired, objects, directory, _fixture, operations, id) = running(backend).await;
        desired.settings.cpu_request_millis = 2000;
        let mut node = objects.get("v1", "Node", "", "gpu-node").unwrap();
        node["spec"] =
            json!({"taints":[{"key":"dedicated", "value":"inference", "effect":"NoSchedule"}]});
        objects.insert(node);
        refuses_before_stopping(
            &operations,
            &objects,
            directory.path(),
            &desired,
            &id,
            "taint",
        )
        .await;
    }
}

#[tokio::test]
async fn a_cordoned_node_preserves_the_running_pod_and_saved_receipt() {
    let (mut desired, objects, directory, _fixture, operations, id) = running("vllm").await;
    desired.settings.cpu_request_millis = 2000;
    let mut node = objects.get("v1", "Node", "", "gpu-node").unwrap();
    node["spec"] = json!({"unschedulable":true});
    objects.insert(node);
    refuses_before_stopping(
        &operations,
        &objects,
        directory.path(),
        &desired,
        &id,
        "cordoned",
    )
    .await;
}

#[tokio::test]
async fn runtime_class_overhead_from_admission_must_fit_before_the_running_pod_is_stopped() {
    let (mut desired, objects, directory, _fixture, operations, id) = running("vllm").await;
    desired.settings.cpu_request_millis = 2000;
    objects.admit_pod_dry_run_with(json!({"overhead":{"memory":"64Gi"}}));
    refuses_before_stopping(
        &operations,
        &objects,
        directory.path(),
        &desired,
        &id,
        "memory",
    )
    .await;
}

#[tokio::test]
async fn equivalent_kubernetes_quantities_allow_a_sequential_update_on_one_gpu() {
    for (resource, quantity) in [
        ("cpu", "2.0"),
        ("cpu", "+2."),
        ("cpu", "2000000000n"),
        ("cpu", "2000000u"),
        ("cpu", "2e0"),
        ("cpu", "2000e-3"),
        ("memory", "16384Mi"),
        ("memory", "16Gi"),
        ("memory", "17179869184"),
        ("memory", "17179869.184k"),
        ("memory", "17.179869184G"),
        ("memory", "1.7179869184e10"),
        ("nvidia.com/gpu", "1e0"),
    ] {
        let (mut desired, objects, _directory, _fixture, operations, id) = running("vllm").await;
        desired.settings.cpu_request_millis = 2000;
        let old_pod = objects.get("v1", "Pod", "agents", &desired.name).unwrap();
        let storage = objects
            .get(
                "v1",
                "PersistentVolumeClaim",
                "agents",
                &format!("{}-data", desired.name),
            )
            .unwrap();
        let mut node = objects.get("v1", "Node", "", "gpu-node").unwrap();
        node["status"]["allocatable"][resource] = json!(quantity);
        objects.insert(node);
        operations
            .ensure(&desired, Some(&id))
            .await
            .unwrap_or_else(|error| panic!("{resource}={quantity}: {error}"));
        assert_ne!(
            objects.get("v1", "Pod", "agents", &desired.name).unwrap()["metadata"]["uid"],
            old_pod["metadata"]["uid"]
        );
        assert_eq!(
            objects.get(
                "v1",
                "PersistentVolumeClaim",
                "agents",
                &format!("{}-data", desired.name)
            ),
            Some(storage)
        );
    }
}

#[tokio::test]
async fn unsupported_admission_resource_shapes_preserve_the_running_pod() {
    for overlay in [
        json!({"initContainers":[{"name":"init", "image":"example/init", "resources":{"requests":{"memory":"128Gi"}}}]}),
        json!({"resources":{"requests":{"memory":"128Gi"}}}),
    ] {
        let (mut desired, objects, directory, _fixture, operations, id) = running("vllm").await;
        desired.settings.cpu_request_millis = 2000;
        objects.admit_pod_dry_run_with(overlay);
        refuses_before_stopping(
            &operations,
            &objects,
            directory.path(),
            &desired,
            &id,
            "cannot assess admitted Pod resource requests",
        )
        .await;
    }
}

#[tokio::test]
async fn requests_above_allocatable_capacity_and_unreadable_quantities_preserve_the_running_pod() {
    for (resource, available, reason) in [
        ("cpu", "1999m", "cpu"),
        ("memory", "16383Mi", "memory"),
        ("nvidia.com/gpu", "0", "nvidia.com/gpu"),
        ("memory", "-1Gi", "cannot assess Node allocatable quantity"),
        (
            "memory",
            "1e1000",
            "cannot assess Node allocatable quantity",
        ),
        ("memory", "0.1n", "cannot assess Node allocatable quantity"),
        (
            "memory",
            "invalid",
            "cannot assess Node allocatable quantity",
        ),
    ] {
        let (mut desired, objects, directory, _fixture, operations, id) = running("vllm").await;
        desired.settings.cpu_request_millis = 2000;
        let mut node = objects.get("v1", "Node", "", "gpu-node").unwrap();
        node["status"]["allocatable"][resource] = json!(available);
        objects.insert(node);
        refuses_before_stopping(
            &operations,
            &objects,
            directory.path(),
            &desired,
            &id,
            reason,
        )
        .await;
    }
}

#[tokio::test]
async fn losing_node_read_permission_preserves_the_running_pod_and_receipt() {
    for backend in ["vllm", "ollama"] {
        let (mut desired, objects, directory, _fixture, operations, id) = running(backend).await;
        desired.settings.cpu_request_millis = 2000;
        let before = objects.0.lock().unwrap().clone();
        let receipt = directory
            .path()
            .join("services")
            .join(&desired.name)
            .join("receipt.json");
        let saved = std::fs::read(&receipt).unwrap();
        for apply in [false, true] {
            objects.reject_request("GET", "/api/v1/nodes", false, 403);
            let error = if apply {
                operations.ensure(&desired, Some(&id)).await.map(|_| ())
            } else {
                operations.preflight_workload(&desired).await
            }
            .unwrap_err();
            assert_eq!(error, nemoclaw_sdk::ObservationError::Permission);
            assert_eq!(*objects.0.lock().unwrap(), before);
            assert_eq!(std::fs::read(&receipt).unwrap(), saved);
        }
    }
}

#[tokio::test]
async fn image_and_runtime_only_updates_do_not_require_node_read_permission() {
    for backend in ["vllm", "ollama"] {
        for change_image in [false, true] {
            let (mut desired, objects, _directory, _fixture, operations, id) =
                running(backend).await;
            if change_image {
                desired.image = format!("registry.example/runtime@sha256:{}", "b".repeat(64));
            } else {
                let mut runtime = serde_json::to_value(&desired.runtime).unwrap();
                let timeout = runtime["serving"]["startupTimeoutSeconds"]
                    .as_u64()
                    .unwrap();
                runtime["serving"]["startupTimeoutSeconds"] = json!(timeout + 1);
                desired.runtime = serde_json::from_value(runtime).unwrap();
            }
            let old_pod = objects.get("v1", "Pod", "agents", &desired.name).unwrap();
            objects.reject_request("GET", "/api/v1/nodes", false, 403);
            operations.preflight_workload(&desired).await.unwrap();
            operations.ensure(&desired, Some(&id)).await.unwrap();
            assert_ne!(
                objects.get("v1", "Pod", "agents", &desired.name).unwrap()["metadata"]["uid"],
                old_pod["metadata"]["uid"]
            );
            assert!(objects.rejected_requests().is_empty());
        }
    }
}

#[tokio::test]
async fn admitted_runtime_class_node_constraints_and_sidecar_requests_are_checked() {
    for (overlay, reason) in [
        (
            json!({"nodeSelector":{"kubernetes.io/os":"linux", "gpu-pool":"missing-pool"}}),
            "nodeSelector",
        ),
        (
            json!({"containers":[{"name":"runtime", "resources":{"requests":{"memory":"16Gi"}}},
            {"name":"admitted-sidecar", "resources":{"requests":{"memory":"49Gi"}}}]}),
            "memory",
        ),
    ] {
        let (mut desired, objects, directory, _fixture, operations, id) = running("vllm").await;
        desired.settings.runtime_class_name = Some("other-nvidia".into());
        objects.insert(json!({"apiVersion":"node.k8s.io/v1", "kind":"RuntimeClass", "metadata":{"name":"other-nvidia"}, "handler":"nvidia"}));
        objects.admit_pod_dry_run_with(overlay);
        refuses_before_stopping(
            &operations,
            &objects,
            directory.path(),
            &desired,
            &id,
            reason,
        )
        .await;
    }
}

#[tokio::test]
async fn matching_tolerations_and_preferred_taints_allow_sequential_updates() {
    for (effect, toleration, cordoned) in [
        (
            "NoSchedule",
            json!({"key":"dedicated", "operator":"Equal", "value":"inference", "effect":"NoSchedule"}),
            false,
        ),
        (
            "NoExecute",
            json!({"key":"dedicated", "operator":"Exists"}),
            false,
        ),
        ("NoSchedule", json!({"operator":"Exists"}), false),
        ("PreferNoSchedule", Value::Null, false),
        (
            "PreferNoSchedule",
            json!({"key":"node.kubernetes.io/unschedulable", "operator":"Exists", "effect":"NoSchedule"}),
            true,
        ),
    ] {
        let (mut desired, objects, _directory, _fixture, operations, id) = running("vllm").await;
        desired.settings.cpu_request_millis = 2000;
        let mut node = objects.get("v1", "Node", "", "gpu-node").unwrap();
        node["spec"] = json!({"unschedulable":cordoned, "taints":[{"key":"dedicated", "value":"inference", "effect":effect}]});
        objects.insert(node);
        objects.admit_pod_dry_run_with(
            json!({"tolerations": if toleration.is_null() { vec![] } else { vec![toleration] }}),
        );
        operations.ensure(&desired, Some(&id)).await.unwrap();
    }
}

#[tokio::test]
async fn an_unassessable_node_does_not_hide_another_node_that_fits_the_replacement() {
    for unknown_capacity in [
        Value::Null,
        json!({"allocatable":{"cpu":"8", "memory":"invalid", "nvidia.com/gpu":"1"}}),
    ] {
        let (mut desired, objects, _directory, _fixture, operations, id) = running("vllm").await;
        desired.settings.cpu_request_millis = 2000;
        let old_pod = objects.get("v1", "Pod", "agents", &desired.name).unwrap();
        let mut joining = objects.get("v1", "Node", "", "gpu-node").unwrap();
        joining["metadata"]["name"] = json!("0-joining-node");
        joining["status"] = unknown_capacity;
        objects.insert(joining);
        operations.ensure(&desired, Some(&id)).await.expect("the existing GPU Node has sufficient capacity even when an earlier Node cannot be assessed");
        assert_ne!(
            objects.get("v1", "Pod", "agents", &desired.name).unwrap()["metadata"]["uid"],
            old_pod["metadata"]["uid"]
        );
    }
}
