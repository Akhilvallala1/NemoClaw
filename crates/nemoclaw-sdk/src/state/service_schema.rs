// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Read the earlier cluster-only service schema without changing retained identities.

use super::Record;
use crate::{Error, config::Document, services::ServiceDefinition};
use serde::{Serialize, ser::SerializeMap};
use serde_json::Value;
use std::collections::BTreeMap;

pub(super) fn decode(bytes: &[u8]) -> Result<Record, Error> {
    let corrupt = || Error::State("deployment intent record is corrupt; retain it for recovery");
    let mut stored: Value = serde_json::from_slice(bytes).map_err(|_| corrupt())?;
    let original = stored.get("document").cloned().ok_or_else(corrupt)?;
    let mut normalized = original.clone();
    if crate::services::cluster_config::normalize(&mut normalized)
        .map_err(|_| corrupt())?
        .is_empty()
    {
        return serde_json::from_slice(bytes).map_err(|_| corrupt());
    }
    // Validate the authored compatibility shape before normalization. This rejects
    // mixed old/current declarations and cluster-only settings on other backends.
    crate::config::schema::validate_input(&original, None)?;
    let document: Document = serde_json::from_value(normalized).map_err(|_| corrupt())?;
    document.validate()?;
    let digest = legacy_digest(&document, &original)?;
    if stored.get("digest").and_then(Value::as_str) != Some(digest.as_str()) {
        return Err(Error::State(
            "deployment intent record is invalid; retain it for recovery",
        ));
    }
    stored["digest"] = Value::String(document.digest());
    stored["document"] = serde_json::to_value(document).map_err(|_| corrupt())?;
    serde_json::from_value(stored).map_err(|_| corrupt())
}

fn legacy_digest(document: &Document, original: &Value) -> Result<String, Error> {
    let document = document.canonical_for_digest();
    let services = document
        .spec
        .services
        .iter()
        .map(|(name, service)| {
            let original = &original["spec"]["services"][name];
            let old = &original["kubernetes"];
            // Only the previous writer's complete cluster layout qualifies for this
            // migration. The digest must not authenticate a partly migrated layout.
            if old.get("cpuLimitMillis").is_none()
                || old.get("memoryLimitGiB").is_none()
                || original.get("updatePolicy").is_some()
            {
                return Err(Error::State(
                    "deployment intent record is invalid; retain it for recovery",
                ));
            }
            let definition = match service {
                ServiceDefinition::Vllm(service) => LegacyDefinition::Vllm(LegacyService {
                    kind: "vllm",
                    kubernetes: service
                        .kubernetes
                        .as_ref()
                        .ok_or(Error::State("legacy cluster settings missing"))?
                        .resolve(service.container.as_ref(), service.update_policy)?,
                    container: old_container(original, service.container.as_ref()),
                    image: &service.image,
                    image_pull_policy: service.image_pull_policy,
                    runtime: &service.runtime,
                }),
                ServiceDefinition::Ollama(service) => LegacyDefinition::Ollama(LegacyService {
                    kind: "ollama",
                    kubernetes: service
                        .kubernetes
                        .as_ref()
                        .ok_or(Error::State("legacy cluster settings missing"))?
                        .resolve(service.container.as_ref(), service.update_policy)?,
                    container: old_container(original, service.container.as_ref()),
                    image: &service.image,
                    image_pull_policy: service.image_pull_policy,
                    runtime: &service.runtime,
                }),
                ServiceDefinition::OllamaProxy(_) => {
                    return Err(Error::State("legacy cluster model kind is invalid"));
                }
            };
            Ok((name.as_str(), definition))
        })
        .collect::<Result<BTreeMap<_, _>, Error>>()?;
    Ok(crate::config::digest_serialized(&LegacyDocument {
        api_version: &document.api_version,
        kind: &document.kind,
        metadata: &document.metadata,
        spec: LegacySpec {
            spec: &document.spec,
            services,
        },
    }))
}

fn old_container(
    original: &Value,
    container: Option<&crate::services::installers::vllm::ServiceContainer>,
) -> Option<LegacyContainer> {
    original
        .get("container")
        .and(container)
        .map(|container| LegacyContainer {
            ipc: container.ipc,
            shared_memory_gib: container.shared_memory_gi_b,
        })
}

// These serializers preserve the old typed declaration order. Hashing a generic
// JSON map would reorder keys and reject valid existing deployment digests.
#[derive(Serialize)]
struct LegacyDocument<'a> {
    #[serde(rename = "apiVersion")]
    api_version: &'a str,
    kind: &'a str,
    metadata: &'a crate::config::Metadata,
    spec: LegacySpec<'a>,
}

struct LegacySpec<'a> {
    spec: &'a crate::config::Spec,
    services: BTreeMap<&'a str, LegacyDefinition<'a>>,
}

impl Serialize for LegacySpec<'_> {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut output = serializer.serialize_map(None)?;
        if !self.spec.harnesses.is_empty() {
            output.serialize_entry("harnesses", &self.spec.harnesses)?;
        }
        if !self.spec.inferences.is_empty() {
            output.serialize_entry("inferences", &self.spec.inferences)?;
        }
        if !self.spec.integrations.is_empty() {
            output.serialize_entry("integrations", &self.spec.integrations)?;
        }
        output.serialize_entry("services", &self.services)?;
        output.serialize_entry("gateway", &self.spec.gateway)?;
        if !self.spec.inference_providers.is_empty() {
            output.serialize_entry("inferenceProviders", &self.spec.inference_providers)?;
        }
        output.serialize_entry("sandboxes", &self.spec.sandboxes)?;
        output.end()
    }
}

#[derive(Serialize)]
#[serde(untagged)]
enum LegacyDefinition<'a> {
    Vllm(LegacyService<'a, nemoclaw_runtime::vllm::Service>),
    Ollama(LegacyService<'a, nemoclaw_runtime::ollama::ManagedOllama>),
}

#[derive(Serialize)]
struct LegacyService<'a, T: Serialize> {
    kind: &'static str,
    kubernetes: crate::kubernetes::services::KubernetesSettings,
    #[serde(skip_serializing_if = "Option::is_none")]
    container: Option<LegacyContainer>,
    image: &'a str,
    #[serde(rename = "imagePullPolicy", skip_serializing_if = "Option::is_none")]
    image_pull_policy: Option<crate::config::ImagePullPolicy>,
    #[serde(flatten)]
    runtime: &'a T,
}

#[derive(Serialize)]
struct LegacyContainer {
    ipc: crate::services::installers::vllm::ServiceIpc,
    #[serde(rename = "sharedMemoryGiB")]
    shared_memory_gib: u64,
}
