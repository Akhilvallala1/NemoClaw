// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::{operations, spec};
use nemoclaw_sdk::services::ServiceUpdatePolicy;
use serde_json::{Value, json};

#[tokio::test]
async fn default_update_policy_preserves_nonterminal_pods_configuration_and_saved_receipts() {
    for backend in ["vllm", "ollama"] {
        for phase in [json!("Running"), json!("Pending"), Value::Null] {
            let original = spec(backend, backend == "vllm");
            let objects = crate::kube_api::Objects::default();
            let directory = tempfile::tempdir().unwrap();
            let (_fixture, operations) = operations(&objects, directory.path(), &original).await;
            operations
                .ensure_storage(&original.storage(), None)
                .await
                .unwrap();
            let bound = operations.ensure(&original, None).await.unwrap();
            let mut pod = objects.get("v1", "Pod", "agents", &original.name).unwrap();
            pod["status"] = json!({"phase":phase});
            objects.insert(pod);
            let mut desired = original.clone();
            desired.image = format!("registry.example/runtime@sha256:{}", "b".repeat(64));
            let before = objects.0.lock().unwrap().clone();
            let receipt = directory
                .path()
                .join("services")
                .join(&original.name)
                .join("receipt.json");
            let saved = std::fs::read(&receipt).unwrap();
            for apply in [false, true] {
                let error = if apply {
                    operations
                        .ensure(&desired, bound.id.as_deref())
                        .await
                        .map(|_| ())
                } else {
                    operations.preflight_workload(&desired).await
                }
                .expect_err("changing a nonterminal Pod requires an explicit downtime policy");
                let message = error.to_string();
                for expected in ["updatePolicy", "Recreate", &original.name] {
                    assert!(message.contains(expected), "{message}");
                }
                assert_eq!(*objects.0.lock().unwrap(), before);
                assert_eq!(std::fs::read(&receipt).unwrap(), saved);
            }
        }
    }
}

#[tokio::test]
async fn explicit_recreate_replaces_a_running_pod_and_keeps_retained_storage() {
    for backend in ["vllm", "ollama"] {
        let original = spec(backend, backend == "vllm");
        let objects = crate::kube_api::Objects::default();
        let directory = tempfile::tempdir().unwrap();
        let (_fixture, operations) = operations(&objects, directory.path(), &original).await;
        operations
            .ensure_storage(&original.storage(), None)
            .await
            .unwrap();
        let bound = operations.ensure(&original, None).await.unwrap();
        let mut pod = objects.get("v1", "Pod", "agents", &original.name).unwrap();
        pod["status"] = json!({"phase":"Running"});
        objects.insert(pod.clone());
        let storage = objects.get(
            "v1",
            "PersistentVolumeClaim",
            "agents",
            &format!("{}-data", original.name),
        );
        let mut desired = original.clone();
        desired.settings.update_policy = ServiceUpdatePolicy::Recreate;
        desired.image = format!("registry.example/runtime@sha256:{}", "b".repeat(64));
        operations.preflight_workload(&desired).await.unwrap();
        assert_eq!(
            objects.get("v1", "Pod", "agents", &original.name),
            Some(pod.clone())
        );
        operations
            .ensure(&desired, bound.id.as_deref())
            .await
            .unwrap();
        let replacement = objects.get("v1", "Pod", "agents", &original.name).unwrap();
        assert_ne!(replacement["metadata"]["uid"], pod["metadata"]["uid"]);
        assert_eq!(replacement["spec"]["containers"][0]["image"], desired.image);
        assert_eq!(
            objects.get(
                "v1",
                "PersistentVolumeClaim",
                "agents",
                &format!("{}-data", original.name)
            ),
            storage
        );
    }
}

#[tokio::test]
async fn changing_only_update_policy_keeps_compute_and_removing_it_restores_protection() {
    for backend in ["vllm", "ollama"] {
        let mut desired = spec(backend, backend == "vllm");
        let objects = crate::kube_api::Objects::default();
        let directory = tempfile::tempdir().unwrap();
        let (_fixture, operations) = operations(&objects, directory.path(), &desired).await;
        operations
            .ensure_storage(&desired.storage(), None)
            .await
            .unwrap();
        let bound = operations.ensure(&desired, None).await.unwrap();
        let before = objects.0.lock().unwrap().clone();
        let receipt = directory
            .path()
            .join("services")
            .join(&desired.name)
            .join("receipt.json");
        // Older receipts omit updatePolicy; decoding and unchanged apply must keep that shape.
        let legacy: Value = serde_json::from_slice(&std::fs::read(&receipt).unwrap()).unwrap();
        assert!(
            legacy["specification"]["settings"]
                .get("updatePolicy")
                .is_none()
        );
        operations
            .ensure(&desired, bound.id.as_deref())
            .await
            .unwrap();
        for policy in [ServiceUpdatePolicy::Recreate, ServiceUpdatePolicy::Preserve] {
            desired.settings.update_policy = policy;
            operations
                .ensure(&desired, bound.id.as_deref())
                .await
                .unwrap();
            assert_eq!(*objects.0.lock().unwrap(), before);
            let saved: Value = serde_json::from_slice(&std::fs::read(&receipt).unwrap()).unwrap();
            assert_eq!(
                saved["specification"],
                serde_json::to_value(&desired).unwrap()
            );
        }
        desired.image = format!("registry.example/runtime@sha256:{}", "b".repeat(64));
        assert!(matches!(
            operations.ensure(&desired, bound.id.as_deref()).await,
            Err(nemoclaw_sdk::ObservationError::ModelUpdateRefused { .. })
        ));
        assert_eq!(*objects.0.lock().unwrap(), before);
    }
}

#[tokio::test]
async fn default_policy_allows_changed_workload_recovery_after_pod_absence_or_termination() {
    for backend in ["vllm", "ollama"] {
        for phase in [None, Some("Failed"), Some("Succeeded")] {
            let mut desired = spec(backend, backend == "vllm");
            let objects = crate::kube_api::Objects::default();
            let directory = tempfile::tempdir().unwrap();
            let (_fixture, operations) = operations(&objects, directory.path(), &desired).await;
            operations
                .ensure_storage(&desired.storage(), None)
                .await
                .unwrap();
            let bound = operations.ensure(&desired, None).await.unwrap();
            let mut old_pod = objects.get("v1", "Pod", "agents", &desired.name).unwrap();
            if let Some(phase) = phase {
                old_pod["status"] = json!({"phase":phase});
                objects.insert(old_pod.clone());
            } else {
                objects
                    .0
                    .lock()
                    .unwrap()
                    .remove(&format!("/api/v1/namespaces/agents/pods/{}", desired.name));
            }
            desired.image = format!("registry.example/runtime@sha256:{}", "b".repeat(64));
            operations
                .ensure(&desired, bound.id.as_deref())
                .await
                .unwrap();
            let replacement = objects.get("v1", "Pod", "agents", &desired.name).unwrap();
            assert_ne!(replacement["metadata"]["uid"], old_pod["metadata"]["uid"]);
            assert_eq!(replacement["spec"]["containers"][0]["image"], desired.image);
        }
    }
}

#[tokio::test]
async fn update_policy_does_not_mask_or_authorize_owned_object_tampering() {
    for policy in [ServiceUpdatePolicy::Preserve, ServiceUpdatePolicy::Recreate] {
        for kind in ["Pod", "ConfigMap"] {
            let mut desired = spec("vllm", true);
            let objects = crate::kube_api::Objects::default();
            let directory = tempfile::tempdir().unwrap();
            let (_fixture, operations) = operations(&objects, directory.path(), &desired).await;
            operations
                .ensure_storage(&desired.storage(), None)
                .await
                .unwrap();
            let bound = operations.ensure(&desired, None).await.unwrap();
            let mut object = objects.get("v1", kind, "agents", &desired.name).unwrap();
            if kind == "Pod" {
                object["metadata"]["uid"] = json!("foreign-pod");
            } else {
                object["data"]["NEMOCLAW_RUNTIME_SPEC"] = json!("foreign-configuration");
            }
            objects.insert(object);
            let before = objects.0.lock().unwrap().clone();
            desired.settings.update_policy = policy;
            desired.image = format!("registry.example/runtime@sha256:{}", "b".repeat(64));
            super::assert_binding_mismatch(operations.ensure(&desired, bound.id.as_deref()).await);
            assert_eq!(*objects.0.lock().unwrap(), before);
        }
    }
}
