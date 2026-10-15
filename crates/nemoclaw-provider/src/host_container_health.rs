// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! `host_container_health`: whether an owned container reports a healthy
//! Docker HEALTHCHECK. It inspects the container only; it never runs a probe.
use crate::{Error, ObservationError, docker::Connections, provider::ConfiguredBackend};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, sync::Arc, time::Duration};
use tf_provider::{
    DataSource, Diagnostics,
    schema::{Attribute, AttributeConstraint, AttributeType, Block, Schema},
    value::{Value, ValueEmpty},
};

pub(crate) struct HostContainerHealthDataSource(pub Arc<ConfiguredBackend>);
#[derive(Default, Serialize, Deserialize)]
pub(crate) struct HostContainerHealthState {
    engine: Value<String>,
    name: Value<String>,
    container_id: Value<String>,
    labels: Value<BTreeMap<String, Value<String>>>,
    wait_timeout_seconds: Value<u64>,
    read_trigger: Value<bool>,
    healthy: Value<bool>,
}

/// The container a read must find.
struct Expected {
    engine: String,
    name: String,
    id: String,
    labels: BTreeMap<String, String>,
    wait: Duration,
}

impl Expected {
    /// The expected container; an error while any input is unknown or missing.
    fn from_state(config: &HostContainerHealthState) -> Result<Self, Error> {
        let text = |value: &Value<String>| match value {
            Value::Value(value) if !value.is_empty() => Ok(value.clone()),
            _ => Err(Error::State("container health inputs are not yet known")),
        };
        let labels = match &config.labels {
            Value::Null => BTreeMap::new(),
            Value::Value(labels) => labels
                .iter()
                .map(|(key, value)| Ok((key.clone(), text(value)?)))
                .collect::<Result<_, Error>>()?,
            Value::Unknown => {
                return Err(Error::State("container health inputs are not yet known"));
            }
        };
        let wait = match config.wait_timeout_seconds {
            Value::Value(seconds) => seconds.min(3600),
            Value::Null => 0,
            Value::Unknown => {
                return Err(Error::State("container health inputs are not yet known"));
            }
        };
        let engine = text(&config.engine)?;
        crate::config::validate_engine_endpoint(&engine)?;
        Ok(Self {
            engine,
            name: text(&config.name)?,
            id: text(&config.container_id)?,
            labels,
            wait: Duration::from_secs(wait),
        })
    }
}

/// Whether the container is healthy: `false` while its health check starts.
async fn observe(connections: &Connections, expected: &Expected) -> Result<bool, Error> {
    let container = tokio::time::timeout(
        Duration::from_secs(20),
        connections
            .resolve(&expected.engine)?
            .container(&expected.id),
    )
    .await
    .map_err(|_| ObservationError::Transport)??
    .ok_or(Error::State("container is absent; reapply"))?;
    let labels = container
        .config
        .as_ref()
        .and_then(|config| config.labels.as_ref());
    if container.id.as_deref() != Some(expected.id.as_str())
        || container
            .name
            .as_deref()
            .map(|name| name.trim_start_matches('/'))
            != Some(expected.name.as_str())
        || expected
            .labels
            .iter()
            .any(|(key, value)| labels.and_then(|labels| labels.get(key)) != Some(value))
    {
        return Err(ObservationError::BindingMismatch.into());
    }
    let state = container.state.ok_or(ObservationError::Incomplete)?;
    if state.running != Some(true) {
        return Err(Error::State("container is not running; reapply"));
    }
    match state
        .health
        .and_then(|health| health.status)
        .map(|s| s.to_string())
        .as_deref()
    {
        Some("healthy") => Ok(true),
        Some("starting") => Ok(false),
        Some("unhealthy") => Err(Error::State(
            "container health check failed; inspect its logs",
        )),
        _ => Err(Error::State("container has no Docker HEALTHCHECK")),
    }
}

async fn wait_healthy(connections: &Connections, expected: &Expected) -> Result<(), Error> {
    let deadline = tokio::time::Instant::now() + expected.wait;
    while !observe(connections, expected).await? {
        if tokio::time::Instant::now() >= deadline {
            return Err(Error::State("container health check is still starting"));
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
    Ok(())
}

#[async_trait]
impl DataSource for HostContainerHealthDataSource {
    type State<'a> = HostContainerHealthState;
    type ProviderMetaState<'a> = ValueEmpty;
    fn schema(&self, _: &mut Diagnostics) -> Option<Schema> {
        use AttributeConstraint::{Computed, Optional, Required};
        use AttributeType::{Bool, Map, Number, String};
        Some(Schema {
            version: 0,
            block: Block {
                attributes: [
                    ("engine", String, Required),
                    ("name", String, Required),
                    ("container_id", String, Required),
                    ("labels", Map(Box::new(String)), Optional),
                    ("wait_timeout_seconds", Number, Optional),
                    ("read_trigger", Bool, Optional),
                    ("healthy", Bool, Computed),
                ]
                .into_iter()
                .map(|(name, attr_type, constraint)| {
                    (
                        name.into(),
                        Attribute {
                            attr_type,
                            constraint,
                            ..Default::default()
                        },
                    )
                })
                .collect(),
                ..Default::default()
            },
        })
    }
    async fn read<'a>(
        &self,
        diags: &mut Diagnostics,
        mut config: HostContainerHealthState,
        _: ValueEmpty,
    ) -> Option<HostContainerHealthState> {
        let work = async {
            let expected = Expected::from_state(&config)?;
            wait_healthy(self.0.connections(), &expected).await
        };
        match work.await {
            Ok(()) => {
                config.healthy = Value::Value(true);
                Some(config)
            }
            Err(error) => {
                diags.root_error("Container health observation failed", error.to_string());
                None
            }
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::docker::fixture::Fixture;
    use serde_json::json;

    #[tokio::test]
    async fn only_a_running_healthy_owned_container_is_healthy() {
        let engine = "unix:///var/run/docker.sock";
        let expected = Expected {
            engine: engine.into(),
            name: "application".into(),
            id: "application-id".into(),
            labels: BTreeMap::from([("owner".into(), "deployment".into())]),
            wait: Duration::ZERO,
        };
        let container = |health: &str, running: bool| {
            json!({"Id":"application-id","Name":"/application","Config":{"Labels":{"owner":"deployment"}},
                "State":{"Running":running,"Health":{"Status":health}}})
        };
        let mut foreign = container("healthy", true);
        foreign["Config"]["Labels"]["owner"] = json!("PRIVATE_SENTINEL");
        for (status, body, healthy) in [
            (200, container("healthy", true), true),
            (200, container("starting", true), false),
            (200, container("unhealthy", true), false),
            (200, container("healthy", false), false),
            (200, foreign, false),
            (404, json!({}), false),
        ] {
            let fixture = Fixture::engine(move |request| {
                assert_eq!(request.method, "GET");
                Some((status, serde_json::to_vec(&body).unwrap()))
            })
            .await;
            let connections = Connections::fixed([fixture.engine_for(engine)]).unwrap();
            let result = wait_healthy(&connections, &expected).await;
            assert_eq!(result.is_ok(), healthy, "{status} {result:?}");
            if let Err(error) = result {
                assert!(!error.to_string().contains("PRIVATE_SENTINEL"));
            }
        }
    }
}
