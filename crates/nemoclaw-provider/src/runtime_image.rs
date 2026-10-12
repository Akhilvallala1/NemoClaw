// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Read the runtime's image contract without acquiring images or creating resources.
use crate::{Error, ObservationError, docker::Connections, provider::ConfiguredBackend};
use async_trait::async_trait;
use nemoclaw_sdk::{
    discovery::{ObservationStatus, RuntimeImageObservation},
    managed::{ImageContract, ImageRequirements, RUNTIME_SPEC_VERSION, RUNTIME_SPEC_VERSION_LABEL},
};
use serde::{Deserialize, Serialize};
use std::{sync::Arc, time::Duration};
use tf_provider::{
    DataSource, Diagnostics,
    schema::{Attribute, AttributeConstraint, AttributeType, Block, Schema},
    value::{Value, ValueEmpty},
};

pub(crate) struct RuntimeImageDataSource(pub Arc<ConfiguredBackend>);
#[derive(Default, Serialize, Deserialize)]
pub(crate) struct RuntimeImageState {
    spec: Value<String>,
    image_id: Value<String>,
    allow_missing: Value<bool>,
    observation_json: Value<String>,
}
fn parse_spec(text: &str) -> Result<ImageRequirements, Error> {
    let spec: ImageRequirements = serde_json::from_str(text)
        .map_err(|_| Error::State("invalid runtime image requirements"))?;
    spec.validate()?;
    Ok(spec)
}
/// Docker injects this PATH; no caller settings reach the fixed publisher.
pub(crate) fn setup_environment_is_safe(environment: Option<&[String]>) -> bool {
    environment.is_none_or(|values| {
        values.is_empty()
            || values.len() == 1
                && values[0] == "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
    })
}
pub(crate) fn validate_input_image(
    image: &bollard::models::ImageInspect,
    architecture: &str,
) -> Result<(), Error> {
    use nemoclaw_container_inputs::{CONTRACT_LABEL, CONTRACT_VERSION, ENTRYPOINT};
    let config = image.config.as_ref().ok_or(ObservationError::Incomplete)?;
    if image.id.as_ref().is_none_or(String::is_empty)
        || image.os.as_deref() != Some("linux")
        || image.architecture.as_deref() != Some(architecture)
        || config
            .labels
            .as_ref()
            .and_then(|labels| labels.get(CONTRACT_LABEL))
            .map(String::as_str)
            != Some(CONTRACT_VERSION)
        || config
            .entrypoint
            .as_ref()
            .is_none_or(|parts| parts != &[ENTRYPOINT.to_owned()])
        || !setup_environment_is_safe(config.env.as_deref())
        || config.volumes.as_ref().is_some_and(|v| !v.is_empty())
    {
        return Err(Error::Conflict(
            "input setup image is incompatible; preload the pinned NemoClaw setup image for this platform",
        ));
    }
    Ok(())
}

async fn observe(
    connections: &Connections,
    spec: &ImageRequirements,
    image_id: Option<&str>,
    allow_missing: bool,
) -> Result<RuntimeImageObservation, Error> {
    let image = tokio::time::timeout(
        Duration::from_secs(20),
        connections.resolve(&spec.engine)?.image(&spec.image),
    )
    .await
    .map_err(|_| ObservationError::Transport)??;
    let mut observation = RuntimeImageObservation {
        status: ObservationStatus::Unknown,
        source: "engine_image".into(),
        required_version: match spec.contract {
            ImageContract::Application => "docker-healthcheck-v1",
            ImageContract::Inputs => "container-inputs-v1",
            ImageContract::Runtime { .. } => RUNTIME_SPEC_VERSION,
        }
        .into(),
    };
    let Some(image) = image else {
        if allow_missing && image_id.is_none() {
            return Ok(observation);
        }
        return Err(Error::Conflict(
            "runtime image is absent from the selected engine; load the pinned image there or allow pulling",
        ));
    };
    if image.id.as_ref().is_none_or(String::is_empty)
        || image_id.is_some_and(|id| image.id.as_deref() != Some(id))
    {
        return Err(ObservationError::Incomplete.into());
    }
    let labels = image
        .config
        .as_ref()
        .and_then(|config| config.labels.as_ref());
    if matches!(spec.contract, ImageContract::Inputs) {
        validate_input_image(&image, &spec.architecture)?;
        observation.status = ObservationStatus::Available;
        return Ok(observation);
    }
    if matches!(spec.contract, ImageContract::Application) {
        let config = image
            .config
            .as_ref()
            .ok_or(crate::ObservationError::Incomplete)?;
        let health = config
            .healthcheck
            .as_ref()
            .and_then(|health| health.test.as_ref());
        if image.os.as_deref() != Some("linux")
            || image.architecture.as_deref() != Some(spec.architecture.as_str())
            || health.is_none_or(|test| {
                test.len() < 2 || !matches!(test[0].as_str(), "CMD" | "CMD-SHELL")
            })
            || config.entrypoint.as_ref().is_none_or(Vec::is_empty)
                && config.cmd.as_ref().is_none_or(Vec::is_empty)
        {
            return Err(Error::Conflict(
                "application image requires the declared Linux platform, image-owned startup, and a Docker HEALTHCHECK",
            ));
        }
        observation.status = ObservationStatus::Available;
        observation.required_version = "docker-healthcheck-v1".into();
        return Ok(observation);
    }
    let ImageContract::Runtime {
        labels: required_labels,
    } = &spec.contract
    else {
        unreachable!()
    };
    if labels
        .and_then(|labels| labels.get(RUNTIME_SPEC_VERSION_LABEL))
        .map(String::as_str)
        != Some(RUNTIME_SPEC_VERSION)
    {
        return Err(Error::Configuration(nemoclaw_sdk::config::ConfigError(
            format!(
                "runtime image does not support runtime specification {RUNTIME_SPEC_VERSION}; rebuild the runtime image with this revision's nemoclaw-build runtime command and update the image digest (docs/build.md)"
            ),
        )));
    }
    if image.os.as_deref() != Some("linux")
        || image.architecture.as_deref() != Some(spec.architecture.as_str())
        || required_labels
            .iter()
            .any(|(key, value)| labels.and_then(|labels| labels.get(key)) != Some(value))
    {
        return Err(Error::Conflict(
            "runtime image platform or required backend, recipe, or authentication labels are incompatible; rebuild the runtime image and update its digest",
        ));
    }
    observation.status = ObservationStatus::Available;
    Ok(observation)
}
#[async_trait]
impl DataSource for RuntimeImageDataSource {
    type State<'a> = RuntimeImageState;
    type ProviderMetaState<'a> = ValueEmpty;
    fn schema(&self, _: &mut Diagnostics) -> Option<Schema> {
        use AttributeConstraint::{Computed, Optional, Required};
        use AttributeType::{Bool, String};
        Some(Schema {
            version: 0,
            block: Block {
                attributes: [
                    ("spec", String, Required),
                    ("image_id", String, Optional),
                    ("allow_missing", Bool, Optional),
                    ("observation_json", String, Computed),
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
    async fn validate<'a>(&self, diags: &mut Diagnostics, config: RuntimeImageState) -> Option<()> {
        let result = match config.spec {
            Value::Value(text) => parse_spec(&text).map(|_| ()),
            Value::Unknown => Ok(()),
            Value::Null => Err(Error::State("runtime image requirements are required")),
        };
        match result {
            Ok(()) => Some(()),
            Err(error) => {
                diags.root_error("Invalid runtime image requirements", error.to_string());
                None
            }
        }
    }
    async fn read<'a>(
        &self,
        diags: &mut Diagnostics,
        mut config: RuntimeImageState,
        _: ValueEmpty,
    ) -> Option<RuntimeImageState> {
        let work = async {
            let Value::Value(text) = &config.spec else {
                return Err(Error::State("runtime image requirements are not yet known"));
            };
            let spec = parse_spec(text)?;
            let image_id = match &config.image_id {
                Value::Null => None,
                Value::Value(id) if !id.is_empty() => Some(id.as_str()),
                _ => return Err(Error::State("runtime image identity is not yet known")),
            };
            let allow_missing = match config.allow_missing {
                Value::Null => false,
                Value::Value(value) => value,
                Value::Unknown => {
                    return Err(Error::State(
                        "runtime image acquisition policy is not yet known",
                    ));
                }
            };
            observe(self.0.connections(), &spec, image_id, allow_missing).await
        }
        .await;
        match work {
            Ok(observation) => {
                config.observation_json = Value::Value(
                    serde_json::to_string(&observation).expect("runtime image observation"),
                );
                Some(config)
            }
            Err(error) => {
                diags.root_error(
                    "Runtime image compatibility check failed",
                    error.to_string(),
                );
                None
            }
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::docker::fixture::Fixture;
    use nemoclaw_sdk::{compile, config::Document};
    use serde_json::json;

    #[test]
    fn publisher_image_contract_checks_platform_startup_environment_and_volumes() {
        use nemoclaw_container_inputs::{CONTRACT_LABEL, CONTRACT_VERSION, ENTRYPOINT};
        for architecture in ["arm64", "amd64"] {
            let valid = json!({"Id":"sha256:publisher", "Os":"linux", "Architecture":architecture,
                "Config":{"Entrypoint":[ENTRYPOINT], "Labels":{CONTRACT_LABEL:CONTRACT_VERSION}}});
            for environment in [
                serde_json::Value::Null,
                json!([]),
                json!(["PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"]),
            ] {
                let mut image = valid.clone();
                image["Config"]["Env"] = environment;
                validate_input_image(&serde_json::from_value(image).unwrap(), architecture)
                    .unwrap();
            }
            for (pointer, bad) in [
                ("/Id", json!("")),
                ("/Os", json!("windows")),
                (
                    "/Architecture",
                    json!(if architecture == "arm64" {
                        "amd64"
                    } else {
                        "arm64"
                    }),
                ),
                ("/Config/Entrypoint", json!(["/bin/sh"])),
                ("/Config/Labels/io.nemoclaw.container-inputs", json!("2")),
                ("/Config/Env", json!(["TOKEN=unexpected-image-content"])),
                ("/Config/Env", json!(["PATH=/tmp"])),
                ("/Config/Env", json!(["LD_PRELOAD=/tmp/injected.so"])),
                (
                    "/Config/Env",
                    json!([
                        "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
                        "TOKEN=unexpected-image-content"
                    ]),
                ),
                (
                    "/Config/Env",
                    json!([
                        "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
                        "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
                    ]),
                ),
                ("/Config/Volumes", json!({"/outside":{}})),
            ] {
                let mut image = valid.clone();
                let (parent, field) = pointer.rsplit_once('/').unwrap();
                image.pointer_mut(parent).unwrap()[field] = bad;
                assert!(
                    validate_input_image(&serde_json::from_value(image).unwrap(), architecture)
                        .is_err(),
                    "accepted {pointer}"
                );
            }
        }
    }

    #[tokio::test]
    async fn application_image_contract_rejects_missing_health_startup_and_platform() {
        let fixtures: Vec<serde_json::Value> =
            serde_json::from_str(include_str!("managed/reference.json")).unwrap();
        let mut value: serde_json::Value =
            serde_json::from_str(fixtures[1]["spec"].as_str().unwrap()).unwrap();
        value["kind"] = json!("container_service");
        for (key, value_to_set) in [
            ("configuration", json!("")),
            ("entrypoint", json!([])),
            ("command", json!([])),
            ("user", json!("65532:65532")),
            ("gpu", json!(false)),
            ("host_ipc", json!(false)),
            ("mount_target", json!("/var/lib/application")),
            ("memory_bytes", json!(1_u64 << 30)),
            ("shared_memory_bytes", json!(64_u64 << 20)),
        ] {
            value["process"][key] = value_to_set;
        }
        let spec = ImageRequirements::from_spec(&serde_json::from_value(value).unwrap()).unwrap();
        for variant in [
            "valid",
            "health",
            "none",
            "startup",
            "platform",
            "identity",
            "absent",
            "authentication",
            "transport",
        ] {
            let mut image = json!({"Id":"sha256:application","Os":"linux","Architecture":spec.architecture,"Config":{"Entrypoint":["/usr/local/bin/application"],"Healthcheck":{"Test":["CMD","application","healthcheck"]}}});
            match variant {
                "health" => {
                    image["Config"]
                        .as_object_mut()
                        .unwrap()
                        .remove("Healthcheck");
                }
                "none" => image["Config"]["Healthcheck"]["Test"] = json!(["NONE"]),
                "startup" => image["Config"]["Entrypoint"] = json!([]),
                "platform" => image["Os"] = json!("PRIVATE_SENTINEL"),
                "identity" => image["Id"] = json!(""),
                _ => {}
            }
            let code = match variant {
                "absent" => 404,
                "authentication" => 401,
                "transport" => 503,
                _ => 200,
            };
            let fixture = Fixture::start(move |request| {
                assert_eq!(request.method, "GET");
                assert!(request.path.starts_with("/images/"));
                Some((code, serde_json::to_vec(&image).unwrap()))
            })
            .await;
            let connections = Connections::fixed([fixture.engine_for(&spec.engine)]).unwrap();
            let result = observe(&connections, &spec, None, true).await;
            match variant {
                "valid" => {
                    assert_eq!(result.unwrap().status, ObservationStatus::Available);
                    assert!(
                        observe(&connections, &spec, Some("sha256:wrong"), false)
                            .await
                            .is_err()
                    );
                }
                "absent" => {
                    assert_eq!(result.unwrap().status, ObservationStatus::Unknown);
                    assert!(observe(&connections, &spec, None, false).await.is_err());
                }
                _ => {
                    assert!(!result.unwrap_err().to_string().contains("PRIVATE_SENTINEL"));
                }
            }
        }
    }

    #[tokio::test]
    async fn image_contract_checks_are_read_only_and_fail_closed_before_acquisition() {
        for bytes in [
            include_bytes!("../../nemoclaw-sdk/tests/fixtures/config/spark.yaml").as_slice(),
            include_bytes!("../../nemoclaw-sdk/tests/fixtures/config/managed-ollama.yaml")
                .as_slice(),
        ] {
            let document = Document::parse(bytes).unwrap();
            let generations = [
                ("managed_gateway".into(), "a".repeat(32)),
                ("inference_service".into(), "b".repeat(32)),
                ("ollama_service".into(), "c".repeat(32)),
            ]
            .into();
            let target = compile::runtime_targets(&document, &generations)
                .unwrap()
                .into_iter()
                .find(|target| {
                    matches!(target.kind.as_str(), "inference_service" | "ollama_service")
                })
                .unwrap();
            let spec = ImageRequirements::from_spec(
                &serde_json::from_str(&target.values["spec"]).unwrap(),
            )
            .unwrap();
            let ImageContract::Runtime {
                labels: required_labels,
            } = &spec.contract
            else {
                panic!("expected runtime image")
            };
            for variant in [
                "valid",
                "missing",
                "version",
                "backend",
                "architecture",
                "identity",
                "absent",
                "authentication",
                "transport",
            ] {
                let mut image = json!({"Id":"sha256:runtime", "Os":"linux", "Architecture":spec.architecture,
                    "Config":{"Labels":required_labels}});
                let code = match variant {
                    "absent" => 404,
                    "authentication" => 401,
                    "transport" => 500,
                    _ => 200,
                };
                match variant {
                    "missing" => {
                        image["Config"]["Labels"]
                            .as_object_mut()
                            .unwrap()
                            .remove(RUNTIME_SPEC_VERSION_LABEL);
                    }
                    "version" => {
                        image["Config"]["Labels"][RUNTIME_SPEC_VERSION_LABEL] =
                            json!("PRIVATE_SENTINEL")
                    }
                    "backend" => {
                        image["Config"]["Labels"]["org.nemoclaw.backend"] =
                            json!("PRIVATE_SENTINEL")
                    }
                    "architecture" => image["Architecture"] = json!("PRIVATE_SENTINEL"),
                    "identity" => image["Id"] = json!(""),
                    _ => {}
                }
                let fixture = Fixture::start(move |request| {
                    assert_eq!(request.method, "GET");
                    assert!(request.path.starts_with("/images/"));
                    Some((code, serde_json::to_vec(&image).unwrap()))
                })
                .await;
                let connections = Connections::fixed([fixture.engine_for(&spec.engine)]).unwrap();
                let result = observe(&connections, &spec, None, true).await;
                match variant {
                    "valid" => {
                        assert_eq!(result.unwrap().status, ObservationStatus::Available);
                        assert!(
                            observe(&connections, &spec, Some("sha256:other"), false)
                                .await
                                .is_err()
                        );
                        assert_eq!(
                            observe(&connections, &spec, Some("sha256:runtime"), false)
                                .await
                                .unwrap()
                                .status,
                            ObservationStatus::Available
                        );
                    }
                    "absent" => {
                        assert_eq!(result.unwrap().status, ObservationStatus::Unknown);
                        assert!(observe(&connections, &spec, None, false).await.is_err());
                        assert!(
                            observe(&connections, &spec, Some("sha256:runtime"), true)
                                .await
                                .is_err()
                        );
                    }
                    _ => {
                        let message = result.unwrap_err().to_string();
                        assert!(!message.contains("PRIVATE_SENTINEL"), "{message}");
                        if matches!(variant, "missing" | "version") {
                            assert!(message.contains("runtime specification v1"), "{message}");
                            assert!(message.contains("rebuild"));
                        }
                        if variant == "authentication" {
                            assert_eq!(message, "observation authentication failed");
                        }
                        if variant == "transport" {
                            assert_eq!(message, "observation transport failed");
                        }
                    }
                }
            }
        }
    }
}
