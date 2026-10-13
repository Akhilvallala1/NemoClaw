// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Setup-only delivery through an owned, bounded, offline initializer.
use crate::{Backend, Error, Mutation, ObservationError, Row};
use async_trait::async_trait;
use bollard::{
    models::{ContainerInspectResponse, ImageInspect},
    query_parameters::{
        AttachContainerOptions, CreateContainerOptions, RemoveContainerOptions,
        StopContainerOptions,
    },
};
use futures_util::StreamExt;
use nemoclaw_container_inputs::{
    Completion, ENTRYPOINT, InputFile, MARKER, MAX_CREDENTIAL_BYTES, MAX_DESCRIPTOR_BYTES,
    MAX_REQUEST_BYTES, ROOT, Request, Role,
};
use nemoclaw_sdk::{
    managed::{GENERATION_LABEL, OWNER_LABEL},
    services::installers::container::inputs::InputsSpec,
};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeSet, HashMap},
    time::Duration,
};
use tokio::io::AsyncWriteExt;
const INPUT_LABEL: &str = "nemoclaw.nvidia.com/input-spec";

pub(crate) fn definition() -> crate::Definition {
    super::schema_definition(nemoclaw_sdk::services::installers::container::inputs::INPUTS_KIND)
        .validate_spec(nemoclaw_sdk::services::validate_resource_spec)
        .computed("complete", crate::rerun_when_stopped)
        .computed("id", input_identity)
}

fn input_identity(name: &str, prior: &crate::State) -> Option<tf_provider::value::Value<String>> {
    use tf_provider::value::Value;
    if prior.get("complete") == Some(&Value::Value("false".into())) {
        Some(Value::Unknown)
    } else {
        crate::carry_prior(name, prior)
    }
}

use crate::runtime_image::{setup_environment_is_safe, validate_input_image};

pub struct InputsBackend {
    engine: crate::docker::Engine,
    secrets: std::sync::Arc<dyn nemoclaw_sdk::Secrets>,
}
impl InputsBackend {
    pub fn new(engine: crate::docker::Engine) -> Self {
        Self {
            engine,
            secrets: std::sync::Arc::new(nemoclaw_sdk::EnvironmentSecrets),
        }
    }
    #[cfg(all(test, unix))]
    fn with_secrets(mut self, secrets: std::sync::Arc<dyn nemoclaw_sdk::Secrets>) -> Self {
        self.secrets = secrets;
        self
    }
    fn spec(&self, row: &Row) -> Result<InputsSpec, Error> {
        let spec: InputsSpec = serde_json::from_str(
            row.get("spec")
                .ok_or(Error::State("missing application inputs"))?,
        )
        .map_err(|_| Error::State("invalid application inputs"))?;
        spec.descriptor(
            row.get("sandbox_id")
                .ok_or(Error::State("missing application binding"))?,
        )?;
        if self.engine.endpoint() != spec.storage.engine {
            return Err(ObservationError::BindingMismatch.into());
        }
        Ok(spec)
    }
    fn payload(&self, spec: &InputsSpec, row: &Row) -> Result<Vec<u8>, Error> {
        let (uid, gid) = owner(spec);
        let root = &spec.root;
        let mut files = Vec::new();
        for secret in spec.secrets.values() {
            files.push(InputFile {
                path: secret.target_path[root.len() + 1..].into(),
                role: Role::Credential,
                content: self.secrets.resolve(&secret.credential.env)?,
            });
        }
        if let Some((path, descriptor)) = spec.descriptor(&row["sandbox_id"])? {
            files.push(InputFile {
                path: path[root.len() + 1..].into(),
                role: Role::Descriptor,
                content: serde_json::to_string(&descriptor)
                    .map_err(|_| Error::State("invalid application descriptor"))?,
            });
        }
        let request = Request {
            uid,
            gid,
            completion: completion(spec, row),
            files,
        };
        request
            .validate()
            .map_err(|_| ObservationError::Authentication)?;
        let bytes = serde_json::to_vec(&request)
            .map_err(|_| Error::State("cannot encode application inputs"))?;
        if bytes.len() > MAX_REQUEST_BYTES {
            return Err(ObservationError::Authentication.into());
        }
        Ok(bytes)
    }
    async fn image(&self, spec: &InputsSpec) -> Result<ImageInspect, Error> {
        let image = self
            .engine
            .image(&spec.setup.image)
            .await?
            .ok_or(Error::Conflict(
                "input setup image is absent; preload the pinned image in the selected engine",
            ))?;
        validate_input_image(&image, &spec.architecture)?;
        Ok(image)
    }
    async fn volume(&self, spec: &InputsSpec) -> Result<(), Error> {
        let volume = self
            .engine
            .volume(&spec.storage.name)
            .await?
            .ok_or(Error::State("owned application input volume is absent"))?;
        if volume.name != spec.storage.name
            || volume.driver != "local"
            || !volume.options.is_empty()
            || volume.labels.get(OWNER_LABEL) != Some(&spec.storage.owner)
            || volume.labels.get(GENERATION_LABEL) != Some(&spec.storage.generation)
        {
            return Err(ObservationError::BindingMismatch.into());
        }
        Ok(())
    }
    async fn container(
        &self,
        spec: &InputsSpec,
        row: &Row,
        removing: bool,
    ) -> Result<Option<ContainerInspectResponse>, Error> {
        let Some(container) = self.engine.container(&spec.helper_name()).await? else {
            return Ok(None);
        };
        identity(spec, row, &container)?;
        if !removing {
            self.volume(spec).await?;
            if container.image.as_deref() != self.image(spec).await?.id.as_deref() {
                return Err(ObservationError::BindingMismatch.into());
            }
        }
        Ok(Some(container))
    }
    async fn application_stopped(&self, spec: &InputsSpec) -> Result<(), Error> {
        if let Some(application) = self.engine.container(&spec.application_name()).await? {
            let labels = application
                .config
                .as_ref()
                .and_then(|c| c.labels.as_ref())
                .ok_or(ObservationError::Incomplete)?;
            if labels.get(OWNER_LABEL) != Some(&spec.storage.owner)
                || labels.get(GENERATION_LABEL) != Some(&spec.storage.generation)
            {
                return Err(ObservationError::BindingMismatch.into());
            }
            if application.state.as_ref().and_then(|s| s.running) != Some(false) {
                return Err(Error::Conflict(
                    "incomplete application inputs cannot be rewritten while the application is running; stop it explicitly and retry",
                ));
            }
        }
        Ok(())
    }
    async fn file(
        &self,
        id: &str,
        path: &str,
        spec: &InputsSpec,
        limit: usize,
        directory: bool,
    ) -> Result<Option<Vec<u8>>, Error> {
        let Some(entry) = self.engine.read_entry(id, path, limit, directory).await? else {
            return Ok(None);
        };
        let (uid, gid) = owner(spec);
        if entry.uid != Some(uid as u64)
            || entry.gid != Some(gid as u64)
            || entry.mode != Some(if directory { 0o700 } else { 0o600 })
        {
            return Err(Error::State(
                "unsafe protected input metadata; resources retained",
            ));
        }
        Ok(Some(entry.bytes))
    }
    async fn complete(
        &self,
        container: &ContainerInspectResponse,
        spec: &InputsSpec,
        row: &Row,
    ) -> Result<bool, Error> {
        let state = container
            .state
            .as_ref()
            .ok_or(ObservationError::Incomplete)?;
        if state.running != Some(false)
            || state.status.as_ref().map(ToString::to_string).as_deref() != Some("exited")
            || state.exit_code != Some(0)
        {
            return Ok(false);
        }
        let id = container
            .id
            .as_deref()
            .ok_or(ObservationError::Incomplete)?;
        let Some(marker) = self
            .file(id, &format!("{ROOT}/{MARKER}"), spec, 4096, false)
            .await?
        else {
            return Ok(false);
        };
        if marker != serde_json::to_vec(&completion(spec, row)).expect("nonsecret completion") {
            return Err(ObservationError::BindingMismatch.into());
        }
        let mut directories = BTreeSet::from([ROOT.to_owned()]);
        for path in spec
            .secrets
            .values()
            .map(|s| s.target_path.as_str())
            .chain(spec.connections.values().map(|c| c.target_path.as_str()))
        {
            let relative = &path[spec.root.len() + 1..];
            let mut prefix = ROOT.to_owned();
            for part in relative.split('/').take(relative.split('/').count() - 1) {
                prefix.push('/');
                prefix.push_str(part);
                directories.insert(prefix.clone());
            }
        }
        for path in directories {
            if self.file(id, &path, spec, 0, true).await?.is_none() {
                return Ok(false);
            }
        }
        for secret in spec.secrets.values() {
            let path = format!("{ROOT}/{}", relative(spec, &secret.target_path));
            let Some(value) = self
                .file(id, &path, spec, MAX_CREDENTIAL_BYTES, false)
                .await?
            else {
                return Ok(false);
            };
            if !std::str::from_utf8(&value).is_ok_and(nemoclaw_container_inputs::credential) {
                return Err(ObservationError::Authentication.into());
            }
        }
        if let Some((path, descriptor)) = spec.descriptor(&row["sandbox_id"])? {
            let Some(value) = self
                .file(
                    id,
                    &format!("{ROOT}/{}", relative(spec, &path)),
                    spec,
                    MAX_DESCRIPTOR_BYTES,
                    false,
                )
                .await?
            else {
                return Ok(false);
            };
            if value != serde_json::to_vec(&descriptor).expect("nonsecret descriptor") {
                return Err(ObservationError::BindingMismatch.into());
            }
        }
        Ok(true)
    }
    async fn create(&self, spec: &InputsSpec, row: &Row) -> Result<String, Error> {
        let config = configuration(spec, row)?;
        let created = self
            .engine
            .api
            .create_container(
                Some(CreateContainerOptions {
                    name: Some(spec.helper_name()),
                    ..Default::default()
                }),
                config,
            )
            .await
            .map_err(|e| crate::docker::remote(&e))?;
        if created.id.is_empty() {
            return Err(ObservationError::Incomplete.into());
        }
        Ok(created.id)
    }
    async fn delete(&self, id: &str, spec: &InputsSpec) -> Result<(), Error> {
        self.engine
            .api
            .remove_container(
                id,
                Some(RemoveContainerOptions {
                    force: false,
                    v: true,
                    ..Default::default()
                }),
            )
            .await
            .map_err(|e| crate::docker::remote(&e))?;
        if self.engine.container(&spec.helper_name()).await?.is_some() {
            return Err(ObservationError::Incomplete.into());
        }
        Ok(())
    }
    async fn execute(&self, id: &str, spec: &InputsSpec, payload: &[u8]) -> Result<(), Error> {
        let mut attached = self
            .engine
            .api
            .attach_container(
                id,
                Some(AttachContainerOptions {
                    stream: true,
                    stdin: true,
                    stdout: true,
                    stderr: true,
                    logs: false,
                    ..Default::default()
                }),
            )
            .await
            .map_err(|e| crate::docker::remote(&e))?;
        self.engine
            .api
            .start_container(id, None)
            .await
            .map_err(|e| crate::docker::remote(&e))?;
        let mut ready = Vec::new();
        while ready.len() < 6 {
            let frame = attached
                .output
                .next()
                .await
                .ok_or(Error::State(
                    "setup helper closed before safe credential admission",
                ))?
                .map_err(|e| crate::docker::remote(&e))?;
            if !matches!(frame, bollard::container::LogOutput::StdOut { .. })
                || frame.as_ref().len() > 6 - ready.len()
            {
                return Err(Error::State(
                    "setup helper did not authorize credential admission",
                ));
            }
            ready.extend_from_slice(frame.as_ref());
        }
        if ready != b"ready\n" {
            return Err(Error::State(
                "setup helper did not authorize credential admission",
            ));
        }
        self.application_stopped(spec).await?;
        attached
            .input
            .write_all(payload)
            .await
            .map_err(|_| ObservationError::Transport)?;
        attached
            .input
            .shutdown()
            .await
            .map_err(|_| ObservationError::Transport)?;
        while let Some(frame) = attached.output.next().await {
            let frame = frame.map_err(|e| crate::docker::remote(&e))?;
            if !frame.as_ref().is_empty() {
                return Err(Error::State(
                    "setup helper failed; binding and protected volume retained",
                ));
            }
        }
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        loop {
            let container = self
                .engine
                .container(id)
                .await?
                .ok_or(ObservationError::Incomplete)?;
            let state = container.state.ok_or(ObservationError::Incomplete)?;
            if state.running == Some(false)
                && state.status.as_ref().map(ToString::to_string).as_deref() == Some("exited")
            {
                if state.exit_code == Some(0) {
                    return Ok(());
                }
                return Err(Error::State(
                    "setup helper failed; binding and protected volume retained",
                ));
            }
            if tokio::time::Instant::now() >= deadline {
                return Err(ObservationError::Transport.into());
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }
}
fn relative<'a>(spec: &InputsSpec, path: &'a str) -> &'a str {
    &path[spec.root.len() + 1..]
}
fn owner(spec: &InputsSpec) -> (u32, u32) {
    let (uid, gid) = spec.user.split_once(':').unwrap();
    (uid.parse().unwrap(), gid.parse().unwrap())
}
fn completion(spec: &InputsSpec, row: &Row) -> Completion {
    Completion {
        revision: spec.revision.clone(),
        sandbox_id: row["sandbox_id"].clone(),
    }
}
fn labels(spec: &InputsSpec, row: &Row) -> Result<HashMap<String, String>, Error> {
    let bytes = serde_json::to_vec(&(spec, &row["sandbox_id"]))
        .map_err(|_| Error::State("invalid application input identity"))?;
    let hash: String = Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    Ok([
        (OWNER_LABEL.into(), spec.storage.owner.clone()),
        (GENERATION_LABEL.into(), spec.storage.generation.clone()),
        (INPUT_LABEL.into(), hash),
    ]
    .into())
}
fn configuration(
    spec: &InputsSpec,
    row: &Row,
) -> Result<bollard::models::ContainerCreateBody, Error> {
    let (uid, gid) = owner(spec);
    let config=serde_json::from_value(json!({
            "Image":spec.setup.image,"User":"0:0","Env":[],"Entrypoint":[ENTRYPOINT],"Cmd":["install",uid.to_string(),gid.to_string()],
            "Labels":labels(spec,row)?,"AttachStdin":true,"AttachStdout":true,"AttachStderr":true,"OpenStdin":true,"StdinOnce":true,"Tty":false,"Healthcheck":{"Test":["NONE"]},
            "HostConfig":{"NetworkMode":"none","IpcMode":"private","PidMode":"","ReadonlyRootfs":true,"Privileged":false,
                "CapDrop":["ALL"],"CapAdd":["CHOWN","FOWNER","DAC_OVERRIDE"],"SecurityOpt":["no-new-privileges:true"],
                "RestartPolicy":{"Name":"no"},"LogConfig":{"Type":"none","Config":{}},"Memory":134217728,"PidsLimit":16,
                "Mounts":[{"Type":"volume","Source":spec.storage.name,"Target":ROOT,"VolumeOptions":{"NoCopy":true}}]}
        })).map_err(|_|Error::State("invalid setup container configuration"))?;

    Ok(config)
}
fn identity(
    spec: &InputsSpec,
    row: &Row,
    container: &ContainerInspectResponse,
) -> Result<String, Error> {
    let config = container
        .config
        .as_ref()
        .ok_or(ObservationError::Incomplete)?;
    let host = serde_json::to_value(
        container
            .host_config
            .as_ref()
            .ok_or(ObservationError::Incomplete)?,
    )
    .map_err(|_| ObservationError::Incomplete)?;
    let expected = serde_json::to_value(configuration(spec, row)?)
        .map_err(|_| ObservationError::Incomplete)?;
    let actual_config = serde_json::to_value(config).map_err(|_| ObservationError::Incomplete)?;
    // Image labels are inherited; the ownership keys must match the fixed configuration.
    let owned_labels = expected["Labels"]
        .as_object()
        .ok_or(ObservationError::Incomplete)?;
    if container.name.as_deref().map(|s| s.trim_start_matches('/'))
        != Some(spec.helper_name().as_str())
        || !setup_environment_is_safe(config.env.as_deref())
        || [
            "Image",
            "User",
            "Entrypoint",
            "Cmd",
            "Tty",
            "OpenStdin",
            "StdinOnce",
        ]
        .iter()
        .any(|key| actual_config[key] != expected[key])
        || owned_labels
            .iter()
            .any(|(key, value)| actual_config["Labels"][key] != *value)
        || actual_config["Healthcheck"]["Test"] != expected["Healthcheck"]["Test"]
        || [
            "NetworkMode",
            "IpcMode",
            "ReadonlyRootfs",
            "Privileged",
            "CapDrop",
            "CapAdd",
            "SecurityOpt",
            "Memory",
            "PidsLimit",
        ]
        .iter()
        .any(|key| host[key] != expected["HostConfig"][key])
        || host["RestartPolicy"]["Name"] != expected["HostConfig"]["RestartPolicy"]["Name"]
        || host["LogConfig"]["Type"] != expected["HostConfig"]["LogConfig"]["Type"]
    {
        return Err(ObservationError::BindingMismatch.into());
    }
    for field in [
        "Binds",
        "VolumesFrom",
        "Devices",
        "DeviceRequests",
        "Tmpfs",
        "PortBindings",
    ] {
        let value = &host[field];
        if !value.is_null()
            && !value.as_array().is_some_and(Vec::is_empty)
            && !value.as_object().is_some_and(serde_json::Map::is_empty)
        {
            return Err(ObservationError::BindingMismatch.into());
        }
    }
    if host["PidMode"].as_str().is_some_and(|s| !s.is_empty()) {
        return Err(ObservationError::BindingMismatch.into());
    }
    let mounts = container
        .mounts
        .as_ref()
        .ok_or(ObservationError::Incomplete)?;
    if mounts.len() != 1
        || mounts[0].destination.as_deref() != Some(ROOT)
        || mounts[0].typ.as_deref() != Some("volume")
        || mounts[0].name.as_deref() != Some(spec.storage.name.as_str())
        || mounts[0].rw != Some(true)
    {
        return Err(ObservationError::BindingMismatch.into());
    }
    let id = container
        .id
        .as_ref()
        .filter(|s| !s.is_empty())
        .ok_or(ObservationError::Incomplete)?;
    let expected = row
        .get("id")
        .filter(|s| !s.is_empty())
        .or_else(|| row.get("prior_id").filter(|s| !s.is_empty()));
    if expected.is_some_and(|s| s != id) {
        return Err(ObservationError::BindingMismatch.into());
    }
    Ok(id.clone())
}
fn observed(mut row: Row, id: String, complete: bool) -> Row {
    row.remove("prior_id");
    row.insert("id".into(), id);
    row.insert("complete".into(), complete.to_string());
    row
}
fn diagnostic(error: Error) -> ObservationError {
    match error {
        Error::Observation(e) => e,
        Error::State(s) | Error::Conflict(s) => ObservationError::Backend(s),
        _ => {
            ObservationError::Backend("protected input setup failed; retain the binding and volume")
        }
    }
}

#[async_trait]
impl Backend for InputsBackend {
    async fn plan(&self, _: &str, desired: &Row, prior: Option<&Row>) -> Result<(), Error> {
        let spec = self.spec(desired)?;
        self.payload(&spec, desired)?;
        tokio::time::timeout(Duration::from_secs(20), self.image(&spec))
            .await
            .map_err(|_| ObservationError::Transport)??;
        if let Some(prior) = prior {
            let prior_spec = self.spec(prior)?;
            self.container(&prior_spec, prior, false).await?;
        }
        Ok(())
    }
    async fn read(
        &self,
        _: &str,
        prior: &Row,
        removing: bool,
    ) -> Result<Option<Row>, ObservationError> {
        let work = async {
            let spec = self.spec(prior)?;
            let Some(container) = self.container(&spec, prior, removing).await? else {
                return Ok(None);
            };
            let complete = if removing {
                false
            } else {
                self.complete(&container, &spec, prior).await?
            };
            Ok(Some(observed(
                prior.clone(),
                container.id.ok_or(ObservationError::Incomplete)?,
                complete,
            )))
        };
        tokio::time::timeout(Duration::from_secs(60), work)
            .await
            .map_err(|_| ObservationError::Transport)?
            .map_err(diagnostic)
    }
    async fn ensure(&self, _: &str, desired: &Row) -> Mutation {
        let mut bound = None;
        let work = async {
            let spec = self.spec(desired)?;
            let payload = self.payload(&spec, desired)?;
            self.image(&spec).await?;
            self.volume(&spec).await?;
            if let Some(container) = self.container(&spec, desired, false).await? {
                let id = container.id.clone().ok_or(ObservationError::Incomplete)?;
                bound = Some(observed(desired.clone(), id.clone(), false));
                if self.complete(&container, &spec, desired).await? {
                    return Ok(observed(desired.clone(), id, true));
                }
                if container.state.as_ref().and_then(|s| s.running) != Some(false) {
                    return Err(Error::Conflict(
                        "setup helper is still running; preserve its binding and confirm it stopped before retry",
                    ));
                }
                self.application_stopped(&spec).await?;
                self.delete(&id, &spec).await?;
            }
            self.application_stopped(&spec).await?;
            let id = self.create(&spec, desired).await?;
            let fresh = observed(desired.clone(), id.clone(), false);
            bound = Some(fresh.clone());
            let container = self
                .container(&spec, &fresh, false)
                .await?
                .ok_or(ObservationError::Incomplete)?;
            if container.state.as_ref().and_then(|s| s.running) != Some(false) {
                return Err(ObservationError::BindingMismatch.into());
            }
            self.execute(&id, &spec, &payload).await?;
            let container = self
                .container(&spec, &fresh, false)
                .await?
                .ok_or(ObservationError::Incomplete)?;
            if !self.complete(&container, &spec, &fresh).await? {
                return Err(Error::State(
                    "input publication could not be verified; binding and volume retained",
                ));
            }
            Ok::<_, Error>(observed(desired.clone(), id, true))
        };
        let result = tokio::time::timeout(Duration::from_secs(60), work)
            .await
            .map_err(|_| Error::Observation(ObservationError::Transport))
            .and_then(|r| r);
        match result {
            Ok(row) => Mutation::complete(row),
            Err(error) => match bound {
                Some(row) => Mutation::partial(row, diagnostic(error)),
                None => Mutation::failed(diagnostic(error)),
            },
        }
    }
    async fn remove(&self, _: &str, prior: &Row, _: bool) -> Result<(), ObservationError> {
        let work = async {
            let spec = self.spec(prior)?;
            let Some(container) = self.container(&spec, prior, true).await? else {
                return Ok(());
            };
            let id = container.id.ok_or(ObservationError::Incomplete)?;
            if container.state.as_ref().and_then(|s| s.running) != Some(false) {
                self.engine
                    .api
                    .stop_container(
                        &id,
                        Some(StopContainerOptions {
                            t: Some(5),
                            ..Default::default()
                        }),
                    )
                    .await
                    .map_err(|e| crate::docker::remote(&e))?;
            }
            self.delete(&id, &spec).await?;
            // Named-volume deletion belongs to the existing Docker graph.
            Ok::<_, Error>(())
        };
        tokio::time::timeout(Duration::from_secs(30), work)
            .await
            .map_err(|_| ObservationError::Transport)?
            .map_err(diagnostic)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tf_provider::value::Value;
    #[test]
    fn incomplete_input_delivery_requires_an_explicit_apply_update() {
        let definition = definition();
        assert_eq!(
            definition.attributes().filter(|name| *name == "id").count(),
            1
        );
        let prior: crate::State = [
            ("id".into(), Value::Value("bound".into())),
            ("complete".into(), Value::Value("false".into())),
        ]
        .into();
        let (planned, replacements) = crate::plan_update(&definition, &prior, prior.clone());
        assert_eq!(planned["complete"], Value::Unknown);
        assert_eq!(planned["id"], Value::Unknown);
        assert!(replacements.is_empty());
        let mut complete = prior;
        complete.insert("complete".into(), Value::Value("true".into()));
        let (planned, replacements) = crate::plan_update(&definition, &complete, complete.clone());
        assert_eq!(planned, complete);
        assert!(replacements.is_empty());
    }
    #[tokio::test]
    #[cfg(unix)]
    async fn application_inputs_register_an_engine_backend_without_a_gateway_client() {
        let row = super::delivery_tests::row();
        let fixture = crate::docker::fixture::Fixture::start(|_| {
            panic!("backend registration must not query Docker")
        })
        .await;
        let spec: InputsSpec = serde_json::from_str(&row["spec"]).unwrap();
        for attribute in ["Owner", "Generation"] {
            let mut invalid = serde_json::to_value(&spec).unwrap();
            invalid["storage"][attribute] = json!("");
            assert!(
                nemoclaw_sdk::services::validate_resource_spec(
                    definition().kind,
                    &invalid.to_string()
                )
                .is_err(),
                "input preparation requires the volume's {attribute}"
            );
        }
        let connections =
            crate::docker::Connections::fixed([fixture.engine_for(&spec.storage.engine)]).unwrap();
        assert!(
            super::super::BackendRegistry::new(&connections)
                .resolve(definition().kind, &row)
                .unwrap()
                .is_some()
        );
    }
    #[tokio::test]
    #[cfg(unix)]
    async fn invalid_delivery_never_mutates_or_reports_absence() {
        let fixture = crate::docker::fixture::Fixture::engine(|_| {
            panic!("invalid input must not contact the engine")
        })
        .await;
        let backend =
            InputsBackend::new(crate::docker::Engine::connect(&fixture.endpoint).unwrap());
        let obsolete = Row::from([
            ("spec".into(), json!({"process":{},"setup":{"image":"obsolete"},"service":"voice","workspace":"nc-0000000000000000","secrets":{},"connections":{}}).to_string()),
            ("sandbox_id".into(), "none".into()),
            ("id".into(), "retained-helper".into()),
        ]);
        for row in [Row::new(), obsolete] {
            assert!(backend.plan("container_inputs", &row, None).await.is_err());
            assert!(backend.read("container_inputs", &row, false).await.is_err());
            let mutation = backend.ensure("container_inputs", &row).await;
            assert!(mutation.state().is_none());
            assert!(mutation.error().is_some());
            assert!(
                backend
                    .remove("container_inputs", &row, true)
                    .await
                    .is_err()
            );
        }
    }
}

#[cfg(all(test, unix))]
#[path = "inputs_tests.rs"]
mod delivery_tests;
