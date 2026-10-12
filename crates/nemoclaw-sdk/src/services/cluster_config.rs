// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Capacity and scheduling for a model service on the gateway's selected cluster.

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeMap;

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
/// One GPU model service in the managed gateway's namespace. Storage survives destroy.
pub struct KubernetesService {
    /// Environment reference to an absolute local OCI metadata bundle for the service image.
    pub image_metadata: crate::config::Credential,
    /// Requested CPU capacity in millicores. Must not exceed container.cpuLimitMillis.
    #[schemars(range(min = 1))]
    pub cpu_request_millis: u32,
    /// Requested container memory in GiB. Must not exceed container.memoryLimitGiB.
    #[serde(rename = "memoryRequestGiB")]
    #[schemars(range(min = 1))]
    pub memory_request_gib: u64,
    /// Retained model-volume capacity in GiB. Must cover prepared data plus a 16 GiB working reserve; allow additional space for model downloads and retained snapshots.
    #[serde(rename = "storageGiB")]
    #[schemars(range(min = 16))]
    pub storage_gib: u64,
    /// StorageClass for retained volumes. Omission selects the cluster default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub storage_class: Option<String>,
    /// Required node labels in addition to the model's declared CPU architecture.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub node_selector: BTreeMap<String, String>,
    /// Node taints the model Pod may tolerate.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tolerations: Vec<ServiceToleration>,
    /// Existing RuntimeClass to use for the model Pod.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime_class_name: Option<String>,
}

impl KubernetesService {
    pub(crate) fn resolve(
        &self,
        container: Option<&super::installers::vllm::ServiceContainer>,
        update_policy: ServiceUpdatePolicy,
    ) -> Result<KubernetesSettings, crate::config::ConfigError> {
        let missing = || {
            crate::config::ConfigError::new(
                "cluster model services require container.cpuLimitMillis and container.memoryLimitGiB",
            )
        };
        let container = container.ok_or_else(missing)?;
        Ok(KubernetesSettings {
            image_metadata: self.image_metadata.clone(),
            cpu_request_millis: self.cpu_request_millis,
            cpu_limit_millis: container.cpu_limit_millis.ok_or_else(missing)?,
            memory_request_gib: self.memory_request_gib,
            memory_limit_gib: container.memory_limit_gib.ok_or_else(missing)?,
            storage_gib: self.storage_gib,
            storage_class: self.storage_class.clone(),
            node_selector: self.node_selector.clone(),
            tolerations: self.tolerations.clone(),
            runtime_class_name: self.runtime_class_name.clone(),
            update_policy,
        })
    }

    pub fn validate(&self) -> Result<(), crate::config::ConfigError> {
        crate::config::schema::validate_definition("KubernetesService", self)
    }
}

/// Resolved cluster settings retain the operational encoding used by saved receipts.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KubernetesSettings {
    /// Environment reference to an absolute local OCI metadata bundle for this service image. Plan and apply verify its digest, Linux architecture, and runtime labels before changing cluster resources. Destroy does not read it.
    pub image_metadata: crate::config::Credential,
    /// Requested CPU capacity in millicores.
    #[schemars(range(min = 1))]
    pub cpu_request_millis: u32,
    /// CPU limit in millicores; must be at least the request.
    #[schemars(range(min = 1))]
    pub cpu_limit_millis: u32,
    /// Requested container memory in GiB, independent of the model's GPU budget.
    #[serde(rename = "memoryRequestGiB")]
    #[schemars(range(min = 1))]
    pub memory_request_gib: u64,
    /// Container memory limit in GiB; must cover the request, shared-memory size, and recipe preparation-memory requirement individually. Combined loading and serving demand needs additional headroom.
    #[serde(rename = "memoryLimitGiB")]
    #[schemars(range(min = 1))]
    pub memory_limit_gib: u64,
    /// Retained model-volume capacity in GiB. Must cover prepared data plus a 16 GiB working reserve; model downloads and earlier snapshots need additional space.
    #[serde(rename = "storageGiB")]
    #[schemars(range(min = 16))]
    pub storage_gib: u64,
    /// StorageClass for retained volumes. Omission selects the cluster default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub storage_class: Option<String>,
    /// Required node labels in addition to the model's declared CPU architecture.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub node_selector: BTreeMap<String, String>,
    /// Node taints the model Pod may tolerate.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tolerations: Vec<ServiceToleration>,
    /// Existing RuntimeClass to use for the model Pod.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime_class_name: Option<String>,
    /// Defaults to Preserve, which refuses replacement of an existing nonterminal Pod. Recreate permits sequential replacement and possible downtime on every update until this policy is removed or changed. Initial creation and recovery of missing or terminal Pods remain allowed; changing only this policy does not restart a Pod.
    #[serde(default, skip_serializing_if = "ServiceUpdatePolicy::is_preserve")]
    pub update_policy: ServiceUpdatePolicy,
}

/// Whether updates may stop an existing model service before its replacement is ready.
#[derive(
    Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema,
)]
pub enum ServiceUpdatePolicy {
    /// Keep existing services and reject changes that require their replacement.
    #[default]
    Preserve,
    /// Permit sequential replacement, including downtime if the replacement cannot start.
    Recreate,
}

impl ServiceUpdatePolicy {
    pub(crate) fn is_preserve(&self) -> bool {
        *self == Self::Preserve
    }
}

impl KubernetesSettings {
    /// Check declared storage and memory against runtime budgets before mutation.
    pub fn validate_runtime(
        &self,
        runtime: &nemoclaw_runtime::RuntimeSpec,
        shared_memory_gib: u64,
    ) -> Result<(), crate::config::ConfigError> {
        self.validate()?;
        let (prepared, preparation_memory) = match runtime {
            nemoclaw_runtime::RuntimeSpec::Vllm(service) => {
                service.recipe.as_ref().map_or((0, 0), |recipe| {
                    (
                        recipe.resources.prepared_bytes,
                        recipe.resources.preparation_memory_gi_b,
                    )
                })
            }
            nemoclaw_runtime::RuntimeSpec::Ollama(_) => (0, 0),
        };
        crate::config::validation::require(
            shared_memory_gib <= self.memory_limit_gib,
            "container.memoryLimitGiB must cover container.sharedMemoryGiB",
        )?;
        crate::config::validation::require(
            preparation_memory <= self.memory_limit_gib,
            "container.memoryLimitGiB must cover recipe preparationMemoryGiB",
        )?;
        let invalid =
            || crate::config::ConfigError::new("cluster storage capacity exceeds supported bounds");
        let required = prepared
            .checked_add(16 * nemoclaw_runtime::hardware::GIB)
            .ok_or_else(invalid)?;
        let capacity = self
            .storage_gib
            .checked_mul(nemoclaw_runtime::hardware::GIB)
            .ok_or_else(invalid)?;
        crate::config::validation::require(
            capacity >= required,
            "cluster storageGiB must cover recipe preparedBytes plus a 16 GiB working reserve; allow additional space for model downloads and retained snapshots",
        )
    }

    /// Check declared capacity and scheduling without contacting the cluster.
    pub fn validate(&self) -> Result<(), crate::config::ConfigError> {
        KubernetesService {
            image_metadata: self.image_metadata.clone(),
            cpu_request_millis: self.cpu_request_millis,
            memory_request_gib: self.memory_request_gib,
            storage_gib: self.storage_gib,
            storage_class: self.storage_class.clone(),
            node_selector: self.node_selector.clone(),
            tolerations: self.tolerations.clone(),
            runtime_class_name: self.runtime_class_name.clone(),
        }
        .validate()?;
        crate::config::validation::require(
            self.cpu_limit_millis > 0
                && self.memory_limit_gib > 0
                && self.memory_limit_gib <= (i64::MAX as u64) >> 30,
            "container CPU and memory limits must be positive and memory must fit signed 64-bit bytes",
        )?;
        crate::config::validation::require(
            self.cpu_request_millis <= self.cpu_limit_millis
                && self.memory_request_gib <= self.memory_limit_gib,
            "cluster service CPU and memory requests must not exceed their limits",
        )
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
/// One explicit Kubernetes node-taint toleration.
pub struct ServiceToleration {
    /// Taint key. An empty key requires Exists and matches every key.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub key: String,
    /// Match the taint's value with Equal, or its presence with Exists.
    pub operator: TolerationOperator,
    /// Value matched by Equal; Exists requires an empty value.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub value: String,
    /// Omission matches all taint effects.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "TolerationEffect")]
    pub effect: Option<TolerationEffect>,
    /// Optional eviction delay, valid only for NoExecute tolerations.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "u64")]
    pub toleration_seconds: Option<u64>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
/// How a toleration matches a node taint.
pub enum TolerationOperator {
    Equal,
    Exists,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
/// Node-taint effect matched by a toleration.
pub enum TolerationEffect {
    NoSchedule,
    PreferNoSchedule,
    NoExecute,
}

/// Move legacy Kubernetes limit and update-policy fields to their current
/// locations, returning a deprecation warning for each moved field.
pub(crate) fn normalize(document: &mut Value) -> Result<Vec<String>, crate::config::ConfigError> {
    let Some(services) = document
        .pointer_mut("/spec/services")
        .and_then(Value::as_object_mut)
    else {
        return Ok(Vec::new());
    };
    let mut moved = Vec::new();
    for (name, service) in services.iter_mut() {
        for field in ["cpuLimitMillis", "memoryLimitGiB", "updatePolicy"] {
            let Some(value) = service
                .get_mut("kubernetes")
                .and_then(Value::as_object_mut)
                .and_then(|settings| settings.remove(field))
            else {
                continue;
            };
            let destination = if field == "updatePolicy" {
                service.as_object_mut()
            } else {
                service.as_object_mut().and_then(|service| {
                    service
                        .entry("container")
                        .or_insert_with(|| json!({}))
                        .as_object_mut()
                })
            }
            .ok_or_else(|| crate::config::ConfigError::new("invalid service container settings"))?;
            if destination.contains_key(field) {
                return Err(crate::config::ConfigError::new(
                    "declare each service limit or updatePolicy only once, using either its current field or its legacy Kubernetes field",
                ));
            }
            destination.insert(field.into(), value);
            let current = if field == "updatePolicy" {
                format!("spec.services.{name}.{field}")
            } else {
                format!("spec.services.{name}.container.{field}")
            };
            moved.push(format!(
                "spec.services.{name}.kubernetes.{field} is deprecated; use {current}"
            ));
        }
    }
    Ok(moved)
}

pub(crate) fn constrain(defs: &mut serde_json::Map<String, Value>, normalized: bool) {
    use crate::config::schema::validation::{at, property};
    const DNS_SUBDOMAIN: &str =
        r"[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*";
    const LABEL_NAME: &str = r"[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,61}[A-Za-z0-9])?";
    let key = json!({
        "pattern": format!(r"^(?:(?=[^/]{{1,253}}/){DNS_SUBDOMAIN}/)?{LABEL_NAME}$(?![\s\S])")
    });
    let value = json!({"type":"string", "pattern": format!(r"^(?:{LABEL_NAME})?$(?![\s\S])")});
    let settings = &mut defs["KubernetesService"];
    // Kubernetes quantities must fit signed 64-bit bytes after conversion from GiB.
    for field in ["memoryRequestGiB", "storageGiB"] {
        property(settings, field, json!({"maximum": (i64::MAX as u64) >> 30}));
    }
    for field in ["storageClass", "runtimeClassName"] {
        property(
            settings,
            field,
            json!({"type":"string", "maxLength":253, "pattern":format!(r"^{DNS_SUBDOMAIN}$(?![\s\S])")}),
        );
    }
    property(
        settings,
        "nodeSelector",
        json!({"propertyNames":key.clone(), "additionalProperties":value.clone()}),
    );
    let toleration = &mut defs["ServiceToleration"];
    property(toleration, "key", json!({"anyOf":[{"const":""},key]}));
    property(toleration, "value", value);
    property(
        toleration,
        "tolerationSeconds",
        json!({"type":"integer", "minimum":0, "maximum":i64::MAX}),
    );
    toleration["allOf"] = json!([
        {"if":at("operator",json!({"const":"Exists"}),true),
         "then":at("value",json!({"const":""}),false),
         "else":at("key",json!({"minLength":1}),true)},
        {"if":{"required":["tolerationSeconds"]},
         "then":at("effect",json!({"const":"NoExecute"}),true)}
    ]);

    if !normalized {
        for (field, schema) in [
            (
                "cpuLimitMillis",
                json!({"type":"integer", "minimum":1, "maximum":u32::MAX, "deprecated":true, "description":"Legacy alias for container.cpuLimitMillis. Do not supply both fields."}),
            ),
            (
                "memoryLimitGiB",
                json!({"type":"integer", "minimum":1, "maximum":(i64::MAX as u64) >> 30, "deprecated":true, "description":"Legacy alias for container.memoryLimitGiB. Do not supply both fields."}),
            ),
            (
                "updatePolicy",
                json!({"$ref":"#/$defs/ServiceUpdatePolicy", "deprecated":true, "description":"Legacy alias for the service-level updatePolicy. Do not supply both fields."}),
            ),
        ] {
            defs["KubernetesService"]["properties"][field] = schema;
        }
    }
    for service in defs["ServiceDefinition"]["oneOf"].as_array_mut().unwrap() {
        if !matches!(
            service["properties"]["kind"]["const"].as_str(),
            Some("vllm" | "ollama")
        ) {
            continue;
        }
        property(
            service,
            "updatePolicy",
            json!({"default":ServiceUpdatePolicy::default()}),
        );
        // Messages name both accepted locations; otherwise a missing or duplicated
        // limit is reported only as the failed anyOf or not keyword.
        let mut limits = Vec::new();
        let mut duplicates = Vec::new();
        for field in ["cpuLimitMillis", "memoryLimitGiB"] {
            let current = at(&format!("container/{field}"), json!({}), true);
            if normalized {
                limits.push(current);
                continue;
            }
            let legacy = at(&format!("kubernetes/{field}"), json!({}), true);
            limits.push(json!({
                "anyOf": [current, legacy],
                "x-nemoclaw-error": format!("cluster model services require container.{field} (or legacy kubernetes.{field})")
            }));
            duplicates.push(json!({
                "not": {"allOf": [current, legacy]},
                "x-nemoclaw-error": format!("declare container.{field} or legacy kubernetes.{field}, not both")
            }));
        }
        let mut rules = vec![json!({"if":{"required":["kubernetes"]}, "then":{"allOf":limits}})];
        rules.extend(duplicates);
        if !normalized {
            rules.push(json!({
                "not": {"allOf": [at("updatePolicy",json!({}),true), at("kubernetes/updatePolicy",json!({}),true)]},
                "x-nemoclaw-error": "declare updatePolicy or legacy kubernetes.updatePolicy, not both"
            }));
        }
        if let Some(existing) = service["allOf"].as_array_mut() {
            existing.extend(rules);
        } else {
            service["allOf"] = json!(rules);
        }
    }
}
