// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::installers::{ollama, vllm};
use crate::{CancellationToken, Error, docker::Connections};
use nemoclaw_runtime::RuntimeSpec;
use std::time::Duration;

/// The contract a ready container serves, as a runtime contract data source computes it.
enum Contract {
    Runtime(Box<RuntimeSpec>),
    Proxy(ollama::ProxySettings),
    Application(Box<crate::managed::Spec>),
}

/// A service container whose readiness a check waits for.
pub struct Readiness {
    engine: String,
    name: String,
    contract: Contract,
}

impl Readiness {
    /// Validate readiness inputs without contacting hosts.
    ///
    /// # Errors
    /// Returns an error naming the invalid input.
    pub fn new(engine: &str, name: &str, contract: &str) -> Result<Self, Error> {
        crate::config::validate_engine_endpoint(engine)?;
        if !regex::Regex::new(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$")
            .unwrap()
            .is_match(name)
        {
            return Err(Error::Conflict(
                "name must be a container name of letters, digits, underscores, periods, or hyphens",
            ));
        }
        // Runtime contracts name their kind; the Ollama proxy contract does not.
        let tagged = serde_json::from_str::<serde_json::Value>(contract)
            .map_err(|_| Error::Conflict("contract must be a runtime contract data source's spec"))?
            .get("kind")
            .is_some();
        let application = serde_json::from_str::<serde_json::Value>(contract)
            .is_ok_and(|value| value["kind"] == "container_service");
        let contract = if application {
            let spec: crate::managed::Spec = serde_json::from_str(contract)
                .map_err(|_| Error::State("invalid application readiness contract"))?;
            nemoclaw_sdk::services::validate_resource_spec(&spec.kind, contract)?;
            if spec.engine() != engine || spec.name != name {
                return Err(crate::ObservationError::BindingMismatch.into());
            }
            Contract::Application(Box::new(spec))
        } else if tagged {
            Contract::Runtime(Box::new(RuntimeSpec::decode(contract)?))
        } else {
            Contract::Proxy(ollama::ProxySettings::decode(contract)?)
        };
        Ok(Self {
            engine: engine.into(),
            name: name.into(),
            contract,
        })
    }
}

pub async fn wait_service_ready(
    connections: &Connections,
    readiness: &Readiness,
    container_id: &str,
    timeout: Duration,
    cancel: &CancellationToken,
) -> Result<(), Error> {
    if container_id.is_empty() {
        return Err(Error::State(
            "service readiness requires a container identity",
        ));
    }
    if cancel.is_cancelled() {
        return Err(Error::Cancelled);
    }
    let engine = crate::managed::service_engine(connections, &readiness.engine)?;
    // The container must be the declared one; its start time orders status reports.
    let observe = || async {
        let observed =
            tokio::time::timeout(Duration::from_secs(20), engine.container(container_id))
                .await
                .map_err(|_| crate::ObservationError::Transport)??;
        let Some(observed) = observed else {
            return Ok(None);
        };
        if observed.id.as_deref() != Some(container_id)
            || observed
                .name
                .as_deref()
                .map(|name| name.trim_start_matches('/'))
                != Some(readiness.name.as_str())
        {
            return Err(crate::ObservationError::BindingMismatch.into());
        }
        let state = observed.state.ok_or(crate::ObservationError::Incomplete)?;
        Ok::<_, Error>(Some((
            state.running.ok_or(crate::ObservationError::Incomplete)?,
            state.started_at.filter(|value| !value.is_empty()),
        )))
    };
    let check = async {
        let spec = match &readiness.contract {
            Contract::Runtime(spec) => spec,
            Contract::Application(spec) => loop {
                if container_health(&engine, spec, container_id).await? {
                    return Ok(());
                }
                if timeout.is_zero() {
                    return Err(Error::State("container is not ready"));
                }
                tokio::time::sleep(Duration::from_secs(5)).await;
            },
            Contract::Proxy(settings) => {
                let (running, _) = observe()
                    .await?
                    .ok_or(Error::State("proxy runtime is absent"))?;
                if !running {
                    return Err(Error::State("proxy runtime is not running; reapply"));
                }
                if timeout.is_zero() {
                    super::authentication::read_key(&engine, container_id).await?;
                } else {
                    super::authentication::read_proxy_key(&engine, container_id).await?;
                }
                ollama::proxy::verify_model(settings).await?;
                return Ok(());
            }
        };
        let (kind, authenticated) = match spec.as_ref() {
            RuntimeSpec::Vllm(service) => (vllm::SERVICE_KIND, service.authentication.is_some()),
            RuntimeSpec::Ollama(_) => (ollama::SERVICE_KIND, false),
        };
        loop {
            let (running, started_at) = observe()
                .await?
                .ok_or(Error::State("service runtime is unobservable"))?;
            if !running {
                return Err(Error::State(
                    "service stopped during readiness; inspect logs and reapply",
                ));
            }
            let started_at = started_at.ok_or(crate::ObservationError::Incomplete)?;
            let phase = super::status::phase(&engine, kind, container_id, &started_at).await?;
            match phase.as_str() {
                "ready" => {
                    if authenticated {
                        super::authentication::read_service_key(&engine, container_id).await?;
                    }
                    return Ok(());
                }
                "stopped" => {
                    return Err(Error::State(
                        "service protection stopped the runtime; reapply is required",
                    ));
                }
                _ if timeout.is_zero() => return Err(Error::State("service is not ready")),
                _ => tokio::time::sleep(Duration::from_secs(5)).await,
            }
        }
    };
    tokio::select! {
        () = cancel.cancelled() => Err(Error::Cancelled),
        result = async {
            if timeout.is_zero() { check.await } else {
                tokio::time::timeout(timeout, check).await
                    .map_err(|_| Error::State("service readiness check timed out"))?
            }
        } => result,
    }
}

async fn container_health(
    engine: &crate::docker::Engine,
    spec: &crate::managed::Spec,
    id: &str,
) -> Result<bool, Error> {
    let expected_labels = spec.labels()?;
    let container = tokio::time::timeout(Duration::from_secs(20), engine.container(id))
        .await
        .map_err(|_| crate::ObservationError::Transport)??
        .ok_or(Error::State("container runtime is unobservable"))?;
    if container.id.as_deref() != Some(id)
        || container
            .name
            .as_deref()
            .map(|name| name.trim_start_matches('/'))
            != Some(spec.name.as_str())
        || container
            .config
            .as_ref()
            .and_then(|config| config.labels.as_ref())
            .is_none_or(|labels| {
                expected_labels
                    .iter()
                    .any(|(key, value)| labels.get(key) != Some(value))
            })
    {
        return Err(crate::ObservationError::BindingMismatch.into());
    }
    let state = container.state.ok_or(crate::ObservationError::Incomplete)?;
    if state.running != Some(true) {
        return Err(Error::State("container is not running; explicitly reapply"));
    }
    let health = state
        .health
        .and_then(|health| health.status)
        .ok_or(Error::State(
            "container has no observable Docker HEALTHCHECK",
        ))?;
    match health.to_string().as_str() {
        "healthy" => Ok(true),
        "starting" => Ok(false),
        "unhealthy" => Err(Error::State(
            "container HEALTHCHECK failed; inspect application logs",
        )),
        _ => Err(Error::State("container health observation is unknown")),
    }
}

#[cfg(all(test, unix))]
mod container_tests {
    use super::*;
    use crate::docker::fixture::Fixture;
    use nemoclaw_sdk::managed::Spec;
    use serde_json::json;
    fn application_readiness(encoded: &str) -> Result<Readiness, Error> {
        let spec: Spec = serde_json::from_str(encoded)
            .map_err(|_| Error::State("invalid application readiness contract"))?;
        Readiness::new(spec.engine(), &spec.name, encoded)
    }

    fn application() -> (Spec, serde_json::Value) {
        let document = nemoclaw_sdk::config::Document::parse(
            include_bytes!(
                "../../../nemoclaw-sdk/tests/fixtures/config/container-agent-connection.yaml"
            )
            .as_slice(),
        )
        .unwrap();
        let generations = ["workspace", "provider", "sandbox", "container_service"]
            .map(|kind| (kind.into(), "a".repeat(32)))
            .into();
        let target = nemoclaw_sdk::compile::targets(&document, &generations)
            .unwrap()
            .into_iter()
            .find(|target| target.kind == "container_service")
            .unwrap();
        let value: serde_json::Value = serde_json::from_str(&target.values["spec"]).unwrap();
        let spec: Spec = serde_json::from_value(value.clone()).unwrap();
        (spec, value)
    }

    #[tokio::test]
    async fn container_readiness_observes_health_without_exec_or_mutation() {
        let (spec, value) = application();
        for (health, running, expected) in [
            ("healthy", true, true),
            ("unhealthy", true, false),
            ("starting", true, false),
            ("", true, false),
            ("healthy", false, false),
        ] {
            let name = spec.name.clone();
            let labels = spec.labels().unwrap();
            let fixture = Fixture::engine(move |request| {
                assert_eq!(request.method, "GET");
                assert_eq!(request.path, "/containers/provider-container/json");
                Some((200, serde_json::to_vec(&json!({"Id":"provider-container", "Name":format!("/{name}"),"Config":{"Labels":labels},"State":{"Running":running,"Health":{"Status":health}}})).unwrap()))
            }).await;
            let connections = Connections::fixed([fixture.engine_for(spec.engine())]).unwrap();
            let result = wait_service_ready(
                &connections,
                &application_readiness(&value.to_string()).unwrap(),
                "provider-container",
                Duration::ZERO,
                &CancellationToken::new(),
            )
            .await;
            assert_eq!(result.is_ok(), expected, "{health} {running}: {result:?}");
        }
    }

    #[tokio::test]
    async fn container_readiness_rejects_wrong_identity_and_unknown_observations() {
        let (spec, encoded) = application();
        let cancel = CancellationToken::new();
        cancel.cancel();
        assert!(matches!(
            wait_service_ready(
                &Connections::fixed([]).unwrap(),
                &application_readiness(&encoded.to_string()).unwrap(),
                "provider-container",
                Duration::ZERO,
                &cancel
            )
            .await,
            Err(Error::Cancelled)
        ));
        for variant in [
            "id",
            "name",
            "owner",
            "generation",
            "configuration",
            "missing-state",
            "missing-health",
            "absent",
            "authentication",
            "transport",
            "starting",
        ] {
            let mut body = json!({"Id":"provider-container","Name":format!("/{}",spec.name),"Config":{"Labels":spec.labels().unwrap()},"State":{"Running":true,"Health":{"Status":"healthy"}}});
            match variant {
                "id" => body["Id"] = json!("other-container"),
                "name" => body["Name"] = json!("/other-container"),
                "owner" => {
                    body["Config"]["Labels"][crate::managed::OWNER_LABEL] =
                        json!("PRIVATE_SENTINEL")
                }
                "generation" => {
                    body["Config"]["Labels"][crate::managed::GENERATION_LABEL] =
                        json!("PRIVATE_SENTINEL")
                }
                "configuration" => {
                    body["Config"]["Labels"][nemoclaw_sdk::managed::SPEC_LABEL] =
                        json!("PRIVATE_SENTINEL")
                }
                "missing-state" => body["State"] = json!({}),
                "missing-health" => body["State"] = json!({"Running":true}),
                "starting" => body["State"]["Health"]["Status"] = json!("starting"),
                _ => {}
            }
            let status = match variant {
                "absent" => 404,
                "authentication" => 401,
                "transport" => 500,
                _ => 200,
            };
            let fixture = Fixture::engine(move |request| {
                assert_eq!(request.method, "GET");
                assert_eq!(request.path, "/containers/provider-container/json");
                Some((status, serde_json::to_vec(&body).unwrap()))
            })
            .await;
            let connections = Connections::fixed([fixture.engine_for(spec.engine())]).unwrap();
            let error = wait_service_ready(
                &connections,
                &application_readiness(&encoded.to_string()).unwrap(),
                "provider-container",
                Duration::from_millis(50),
                &CancellationToken::new(),
            )
            .await
            .unwrap_err();
            assert!(!error.to_string().contains("PRIVATE_SENTINEL"));
            if variant == "starting" {
                assert!(error.to_string().contains("timed out"));
            }
        }
        for (pointer, value) in [
            ("/process/image_owned/user", json!("0:0")),
            ("/process/gpu", json!(true)),
            ("/process/host_ipc", json!(true)),
            ("/process/entrypoint", json!(["sh"])),
            ("/process/image", json!("application:latest")),
            ("/process/engine", json!("ssh://host")),
            ("/process/architecture", json!("native")),
            ("/process/mount_target", json!("/var/lib/../etc")),
        ] {
            let mut bad = encoded.clone();
            *bad.pointer_mut(pointer).unwrap() = value;
            assert!(
                application_readiness(&bad.to_string()).is_err(),
                "accepted {pointer}"
            );
        }
    }
}
