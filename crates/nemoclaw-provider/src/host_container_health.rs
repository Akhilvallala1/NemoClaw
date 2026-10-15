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

/// Longest wait for a container to finish starting.
const MAX_WAIT_SECONDS: u64 = 3600;
/// Interval between health observations while the container starts.
const POLL: Duration = Duration::from_secs(2);

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

/// The container a read must find, once every input is known.
struct Expected {
    engine: String,
    name: String,
    id: String,
    labels: BTreeMap<String, String>,
    wait: Duration,
}

fn known<'a>(value: &'a Value<String>, required: &'static str) -> Result<Option<&'a str>, Error> {
    match value {
        Value::Value(value) if !value.is_empty() => Ok(Some(value)),
        Value::Unknown => Ok(None),
        _ => Err(Error::State(required)),
    }
}

impl Expected {
    /// The expected container, or `None` while any input is unknown.
    fn from_state(config: &HostContainerHealthState) -> Result<Option<Self>, Error> {
        let engine = known(&config.engine, "container engine is required")?;
        let name = known(&config.name, "container name is required")?;
        let id = known(&config.container_id, "container identity is required")?;
        if let Some(engine) = engine {
            crate::config::validate_engine_endpoint(engine)?;
        }
        let wait = match config.wait_timeout_seconds {
            Value::Value(seconds) if seconds <= MAX_WAIT_SECONDS => Some(seconds),
            Value::Null => Some(0),
            Value::Unknown => None,
            Value::Value(_) => {
                return Err(Error::State(
                    "container health wait must be between 0 and 3600 seconds",
                ));
            }
        };
        let labels = match &config.labels {
            Value::Null => Some(BTreeMap::new()),
            Value::Unknown => None,
            Value::Value(labels) => labels
                .iter()
                .map(|(key, value)| match value {
                    Value::Value(value) => Ok(Some((key.clone(), value.clone()))),
                    Value::Unknown => Ok(None),
                    Value::Null => Err(Error::State("container label values are required")),
                })
                .collect::<Result<Option<_>, _>>()?,
        };
        let (Some(engine), Some(name), Some(id), Some(wait), Some(labels)) =
            (engine, name, id, wait, labels)
        else {
            return Ok(None);
        };
        Ok(Some(Self {
            engine: engine.into(),
            name: name.into(),
            id: id.into(),
            labels,
            wait: Duration::from_secs(wait),
        }))
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
    let health = state
        .health
        .and_then(|health| health.status)
        .ok_or(Error::State("container has no Docker HEALTHCHECK"))?;
    match health.to_string().as_str() {
        "healthy" => Ok(true),
        "starting" => Ok(false),
        "unhealthy" => Err(Error::State(
            "container health check failed; inspect its logs",
        )),
        _ => Err(ObservationError::Incomplete.into()),
    }
}

async fn wait_healthy(connections: &Connections, expected: &Expected) -> Result<(), Error> {
    let deadline = tokio::time::Instant::now() + expected.wait;
    loop {
        if observe(connections, expected).await? {
            return Ok(());
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(Error::State("container health check is still starting"));
        }
        tokio::time::sleep(POLL).await;
    }
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
    async fn validate<'a>(
        &self,
        diags: &mut Diagnostics,
        config: HostContainerHealthState,
    ) -> Option<()> {
        match Expected::from_state(&config) {
            Ok(_) => Some(()),
            Err(error) => {
                diags.root_error("Invalid container health requirements", error.to_string());
                None
            }
        }
    }
    async fn read<'a>(
        &self,
        diags: &mut Diagnostics,
        mut config: HostContainerHealthState,
        _: ValueEmpty,
    ) -> Option<HostContainerHealthState> {
        let work = async {
            let Some(expected) = Expected::from_state(&config)? else {
                return Err(Error::State("container health inputs are not yet known"));
            };
            if matches!(config.read_trigger, Value::Unknown) {
                return Err(Error::State(
                    "container health read trigger is not yet known",
                ));
            }
            wait_healthy(self.0.connections(), &expected).await
        }
        .await;
        match work {
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

    const ENGINE: &str = "unix:///var/run/docker.sock";

    fn expected() -> Expected {
        Expected {
            engine: ENGINE.into(),
            name: "application".into(),
            id: "application-id".into(),
            labels: BTreeMap::from([("owner".into(), "deployment".into())]),
            wait: Duration::ZERO,
        }
    }

    fn container(health: &str, running: bool) -> serde_json::Value {
        json!({"Id":"application-id","Name":"/application","Config":{"Labels":{"owner":"deployment"}},
            "State":{"Running":running,"Health":{"Status":health}}})
    }

    async fn read(status: u16, body: serde_json::Value) -> Result<(), Error> {
        let fixture = Fixture::engine(move |request| {
            assert_eq!(request.method, "GET");
            assert_eq!(request.path, "/containers/application-id/json");
            Some((status, serde_json::to_vec(&body).unwrap()))
        })
        .await;
        let connections = Connections::fixed([fixture.engine_for(ENGINE)]).unwrap();
        wait_healthy(&connections, &expected()).await
    }

    #[tokio::test]
    async fn only_a_running_healthy_owned_container_is_healthy() {
        assert!(read(200, container("healthy", true)).await.is_ok());
        let mut cases = vec![
            (200, container("starting", true)),
            (200, container("unhealthy", true)),
            (200, container("healthy", false)),
            (
                200,
                json!({"Id":"application-id","Name":"/application","Config":{"Labels":{"owner":"deployment"}},"State":{"Running":true}}),
            ),
            (404, json!({})),
            (401, json!({})),
            (500, json!({})),
        ];
        for (pointer, value) in [
            ("/Id", json!("PRIVATE_SENTINEL")),
            ("/Name", json!("/PRIVATE_SENTINEL")),
            ("/Config/Labels/owner", json!("PRIVATE_SENTINEL")),
        ] {
            let mut body = container("healthy", true);
            *body.pointer_mut(pointer).unwrap() = value;
            cases.push((200, body));
        }
        for (status, body) in cases {
            let error = read(status, body.clone()).await.unwrap_err();
            assert!(
                !error.to_string().contains("PRIVATE_SENTINEL"),
                "{status} {body}"
            );
        }
    }

    #[test]
    fn requirements_validate_offline_and_defer_unknown_values() {
        let valid = || HostContainerHealthState {
            engine: Value::Value(ENGINE.into()),
            name: Value::Value("application".into()),
            container_id: Value::Value("application-id".into()),
            ..Default::default()
        };
        assert!(Expected::from_state(&valid()).unwrap().is_some());
        for change in [
            |state: &mut HostContainerHealthState| state.container_id = Value::Unknown,
            |state: &mut HostContainerHealthState| state.labels = Value::Unknown,
            |state: &mut HostContainerHealthState| state.wait_timeout_seconds = Value::Unknown,
        ] {
            let mut state = valid();
            change(&mut state);
            assert!(Expected::from_state(&state).unwrap().is_none());
        }
        for change in [
            |state: &mut HostContainerHealthState| state.name = Value::Null,
            |state: &mut HostContainerHealthState| state.container_id = Value::Value(String::new()),
            |state: &mut HostContainerHealthState| state.engine = Value::Value("tcp://e".into()),
            |state: &mut HostContainerHealthState| {
                state.wait_timeout_seconds = Value::Value(MAX_WAIT_SECONDS + 1)
            },
        ] {
            let mut state = valid();
            change(&mut state);
            assert!(Expected::from_state(&state).is_err());
        }
    }
}
