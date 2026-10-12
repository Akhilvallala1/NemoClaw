// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use super::installers::ollama;
use crate::Error;
use serde_json::{Value, json};
pub(crate) fn configure_readiness(
    graph: &mut Value,
    targets: &[crate::compile::Target],
) -> Result<(), Error> {
    for target in targets
        .iter()
        .filter(|target| super::resource_behavior(&target.kind).runtime_process)
    {
        let container = crate::docker_compute::address(&target.address);
        let logical = container.split_once('.').unwrap().1;
        let wait: u64 = target
            .values
            .get("wait_timeout_seconds")
            .map_or(Ok(9 * 3600), |wait| wait.parse())
            .map_err(|_| Error::State("invalid service readiness timeout"))?;
        let spec = crate::managed::Spec::from_values(&target.kind, &target.values)?;
        let literal = |value: &str| value.replace("${", "$${").replace("%{", "%%{");
        let contract = match target.kind.as_str() {
            "inference_service" => format!(
                "${{data.nemoclaw_{}.{logical}.spec}}",
                super::installers::vllm::RUNTIME_DATA_SOURCE
            ),
            "ollama_service" => format!(
                "${{data.nemoclaw_{}.{logical}.spec}}",
                ollama::RUNTIME_DATA_SOURCE
            ),
            _ => literal(&target.values["spec"]),
        };
        graph["data"]["nemoclaw_service_readiness"][logical] = json!({
            "engine":literal(spec.engine()), "name":literal(&spec.name), "contract":contract,
            "container_id":format!("${{{container}.id}}"),
            "read_trigger":"${timestamp() != \"\"}", "wait_timeout_seconds":wait
        });
    }
    for target in targets
        .iter()
        .filter(|target| target.kind == ollama::proxy::PROXY)
    {
        let container = crate::docker_compute::address(&target.address);
        let logical = container.split_once('.').unwrap().1;
        let address = format!("data.nemoclaw_service_readiness.{logical}");
        let proxy = ollama::proxy::row_spec(&target.values)?;
        let literal = |value: &str| value.replace("${", "$${").replace("%{", "%%{");
        // Readiness checks the contract the container runs with.
        graph["data"]["nemoclaw_service_readiness"][logical] = json!({
            "engine":literal(&target.values["engine"]),
            "name":literal(&proxy.name),
            "contract":format!("${{data.nemoclaw_{}.{logical}.spec}}", ollama::proxy::RUNTIME_DATA_SOURCE),
            "container_id":format!("${{{container}.id}}"),
            "read_trigger":"${timestamp() != \"\"}", "wait_timeout_seconds":30
        });
        for instances in graph["resource"].as_object_mut().unwrap().values_mut() {
            for resource in instances.as_object_mut().unwrap().values_mut() {
                if let Some(dependencies) = resource["depends_on"].as_array_mut()
                    && dependencies.contains(&json!(container))
                {
                    dependencies.push(json!(address));
                }
            }
        }
    }
    Ok(())
}
