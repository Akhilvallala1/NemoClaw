// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Credential-file publication through a never-started container and a fresh
//! owned volume. Application connection settings do not belong to this resource.
use crate::{Backend, Error, Mutation, ObservationError, Row};
use async_trait::async_trait;
use bollard::{
    models::ContainerInspectResponse,
    query_parameters::{CreateContainerOptions, RemoveContainerOptions, RemoveVolumeOptions},
};
use nemoclaw_sdk::{
    managed::{GENERATION_LABEL, OWNER_LABEL},
    services::installers::container::inputs::{
        self as files, Files, MARKER, ROOT, credential_file,
    },
};
use serde_json::json;
use std::{collections::HashMap, time::Duration};

const INPUT_LABEL: &str = "nemoclaw.nvidia.com/protected-files";
const MAX_CREDENTIAL_BYTES: usize = 4096;

pub(crate) fn definition() -> crate::Definition {
    let mut definition = crate::Definition::new(files::FILES_KIND, files::FIELDS, &[])
        // Earlier state included a generated agent descriptor. Reject it rather
        // than silently changing the contents of an established volume.
        .schema_version(1)
        .computed("complete", crate::rerun_when_stopped)
        .computed("helper_id", |name, prior| {
            use tf_provider::value::Value;
            if prior.get("complete") == Some(&Value::Value("false".into())) {
                Some(Value::Unknown)
            } else {
                crate::carry_prior(name, prior)
            }
        })
        .validate_inputs(|known, unknown| {
            if !unknown.is_empty() {
                return Ok(());
            }
            Files::from_row(known)
                .map_err(|e| e.to_string())?
                .validate()
                .map_err(|e| e.to_string().into())
        });
    definition.structured = files::structured_inputs();
    definition
}

pub struct FilesBackend {
    engine: crate::docker::Engine,
    secrets: std::sync::Arc<dyn nemoclaw_sdk::Secrets>,
}
impl FilesBackend {
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
    fn spec(&self, row: &Row) -> Result<Files, Error> {
        let spec = Files::from_row(row)?;
        spec.validate()?;
        if self.engine.endpoint() != spec.engine {
            return Err(ObservationError::BindingMismatch.into());
        }
        Ok(spec)
    }
    fn values(&self, spec: &Files) -> Result<Vec<(String, String)>, Error> {
        spec.credentials
            .iter()
            .map(|(name, env)| {
                let value = self.secrets.resolve(env)?;
                if value.is_empty()
                    || value.len() > MAX_CREDENTIAL_BYTES
                    || !value.bytes().all(|b| (0x21..=0x7e).contains(&b))
                {
                    return Err(ObservationError::Authentication.into());
                }
                Ok((name.clone(), value))
            })
            .collect()
    }
    async fn volume(&self, spec: &Files) -> Result<bool, Error> {
        let Some(volume) = self.engine.volume(&spec.helper_name()).await? else {
            return Ok(false);
        };
        if volume.name != spec.helper_name()
            || volume.driver != "local"
            || !volume.options.is_empty()
            || labels(spec)
                .iter()
                .any(|(key, value)| volume.labels.get(key) != Some(value))
        {
            return Err(ObservationError::BindingMismatch.into());
        }
        Ok(true)
    }
    async fn helper(
        &self,
        spec: &Files,
        row: &Row,
    ) -> Result<Option<ContainerInspectResponse>, Error> {
        let Some(helper) = self.engine.container(&spec.helper_name()).await? else {
            return Ok(None);
        };
        let observed = helper.config.as_ref().and_then(|c| c.labels.as_ref());
        let mounts = helper.mounts.as_deref().unwrap_or_default();
        let id = helper.id.as_deref().unwrap_or_default();
        if id.is_empty()
            || helper
                .name
                .as_deref()
                .map(|name| name.trim_start_matches('/'))
                != Some(spec.helper_name().as_str())
            || labels(spec)
                .iter()
                .any(|(key, value)| observed.and_then(|l| l.get(key)) != Some(value))
            || helper.config.as_ref().and_then(|c| c.image.as_deref()) != Some(spec.image.as_str())
            || helper
                .state
                .as_ref()
                .and_then(|s| s.status)
                .map(|s| s.to_string())
                .as_deref()
                != Some("created")
            || mounts.len() != 1
            || mounts[0].typ.as_deref() != Some("volume")
            || mounts[0].name.as_deref() != Some(spec.helper_name().as_str())
            || mounts[0].destination.as_deref() != Some(ROOT)
            || mounts[0].rw != Some(true)
            || row
                .get("helper_id")
                .is_some_and(|bound| !bound.is_empty() && bound != id)
        {
            return Err(ObservationError::BindingMismatch.into());
        }
        Ok(Some(helper))
    }
    async fn complete(&self, id: &str, spec: &Files) -> Result<bool, Error> {
        let marker = self
            .engine
            .read_file(id, &format!("{ROOT}/{MARKER}"), 64)
            .await?;
        Ok(marker.as_deref() == Some(spec.revision().as_bytes()))
    }
    async fn discard(&self, spec: &Files, row: &Row) -> Result<(), Error> {
        // Check both objects before changing either, including during recovery.
        let helper = self.helper(spec, row).await?;
        let volume = self.volume(spec).await?;
        if let Some(helper) = helper {
            self.engine
                .api
                .remove_container(
                    &helper.id.unwrap_or_default(),
                    Some(RemoveContainerOptions {
                        force: false,
                        v: true,
                        ..Default::default()
                    }),
                )
                .await
                .map_err(|error| crate::docker::remote(&error))?;
            if self.engine.container(&spec.helper_name()).await?.is_some() {
                return Err(ObservationError::Incomplete.into());
            }
        }
        if volume {
            self.engine
                .api
                .remove_volume(
                    &spec.helper_name(),
                    Some(RemoveVolumeOptions { force: false }),
                )
                .await
                .map_err(|error| crate::docker::remote(&error))?;
            if self.engine.volume(&spec.helper_name()).await?.is_some() {
                return Err(ObservationError::Incomplete.into());
            }
        }
        Ok(())
    }
    async fn create(&self, spec: &Files) -> Result<String, Error> {
        let name = spec.helper_name();
        self.engine
            .api
            .create_volume(bollard::models::VolumeCreateRequest {
                name: Some(name.clone()),
                driver: Some("local".into()),
                labels: Some(labels(spec)),
                ..Default::default()
            })
            .await
            .map_err(|error| crate::docker::remote(&error))?;
        if !self.volume(spec).await? {
            return Err(ObservationError::Incomplete.into());
        }
        let config = serde_json::from_value(json!({
            "Image":spec.image,"Labels":labels(spec),
            "HostConfig":{"NetworkMode":"none","Mounts":[
                {"Type":"volume","Source":name,"Target":ROOT,"VolumeOptions":{"NoCopy":true}}
            ]}
        }))
        .map_err(|_| Error::State("invalid setup container configuration"))?;
        let created = self
            .engine
            .api
            .create_container(
                Some(CreateContainerOptions {
                    name: Some(name),
                    ..Default::default()
                }),
                config,
            )
            .await
            .map_err(|error| crate::docker::remote(&error))?;
        if created.id.is_empty() {
            return Err(ObservationError::Incomplete.into());
        }
        Ok(created.id)
    }
}

fn labels(spec: &Files) -> HashMap<String, String> {
    [
        (OWNER_LABEL.into(), spec.owner.clone()),
        (GENERATION_LABEL.into(), spec.generation.clone()),
        (INPUT_LABEL.into(), spec.revision()),
    ]
    .into()
}
fn archive(spec: &Files, values: &[(String, String)]) -> Result<Vec<u8>, Error> {
    let (uid, gid) = spec
        .user
        .split_once(':')
        .ok_or(Error::State("invalid credential file owner"))?;
    let (uid, gid) = (
        uid.parse()
            .map_err(|_| Error::State("invalid credential file owner"))?,
        gid.parse()
            .map_err(|_| Error::State("invalid credential file owner"))?,
    );
    let mut builder = tar::Builder::new(Vec::new());
    let mut append = |path: &str, bytes: &[u8], directory: bool| {
        let mut header = tar::Header::new_gnu();
        header.set_entry_type(if directory {
            tar::EntryType::Directory
        } else {
            tar::EntryType::Regular
        });
        header.set_mode(if directory { 0o700 } else { 0o600 });
        header.set_uid(uid);
        header.set_gid(gid);
        header.set_size(bytes.len() as u64);
        header.set_mtime(0);
        header.set_cksum();
        builder
            .append_data(&mut header, path, bytes)
            .map_err(|_| Error::State("cannot prepare protected files"))
    };
    append("secrets", &[], true)?;
    for (name, value) in values {
        append(&credential_file(name), value.as_bytes(), false)?;
    }
    builder
        .into_inner()
        .map_err(|_| Error::State("cannot prepare protected files"))
}
fn observed(mut row: Row, helper_id: String, complete: bool) -> Row {
    // Stable resource identity also records a volume when helper creation or
    // upload is interrupted. The helper's physical ID is a separate observation.
    row.insert("id".into(), format!("{}-inputs", row["name"]));
    row.insert("helper_id".into(), helper_id);
    row.insert("complete".into(), complete.to_string());
    row
}
fn diagnostic(error: Error) -> ObservationError {
    match error {
        Error::Observation(e) => e,
        Error::State(s) | Error::Conflict(s) => ObservationError::Backend(s),
        _ => ObservationError::Backend("protected file publication failed; resources retained"),
    }
}

#[async_trait]
impl Backend for FilesBackend {
    async fn plan(&self, _: &str, desired: &Row, prior: Option<&Row>) -> Result<(), Error> {
        let spec = self.spec(desired)?;
        self.values(&spec)?;
        if let Some(prior) = prior {
            let spec = self.spec(prior)?;
            self.helper(&spec, prior).await?;
            self.volume(&spec).await?;
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
            let helper = self.helper(&spec, prior).await?;
            let volume = self.volume(&spec).await?;
            match (helper, volume) {
                (None, false) => Ok(None),
                (None, true) => Ok(Some(observed(prior.clone(), String::new(), false))),
                (Some(_), false) => Err(ObservationError::Incomplete.into()),
                (Some(helper), true) => {
                    let id = helper.id.unwrap_or_default();
                    let complete = !removing && self.complete(&id, &spec).await?;
                    Ok(Some(observed(prior.clone(), id, complete)))
                }
            }
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
            let values = self.values(&spec)?;
            let volume = self.volume(&spec).await?;
            if let Some(helper) = self.helper(&spec, desired).await? {
                if !volume {
                    return Err(ObservationError::Incomplete.into());
                }
                let id = helper.id.unwrap_or_default();
                bound = Some(observed(desired.clone(), id.clone(), false));
                if self.complete(&id, &spec).await? {
                    return Ok(observed(desired.clone(), id, true));
                }
            }
            self.discard(&spec, desired).await?;
            // Record attempted creation before crossing the mutation boundary.
            bound = Some(observed(desired.clone(), String::new(), false));
            let id = self.create(&spec).await?;
            let fresh = observed(desired.clone(), id.clone(), false);
            bound = Some(fresh.clone());
            if self.helper(&spec, &fresh).await?.is_none() {
                return Err(ObservationError::Incomplete.into());
            }
            self.engine
                .write_archive(&id, ROOT, archive(&spec, &values)?)
                .await?;
            self.engine
                .write_files(&id, ROOT, &[(MARKER, spec.revision().as_bytes(), 0o644)])
                .await?;
            if !self.complete(&id, &spec).await? {
                return Err(Error::State(
                    "protected files could not be verified; resources retained",
                ));
            }
            Ok::<_, Error>(observed(desired.clone(), id, true))
        };
        let result = tokio::time::timeout(Duration::from_secs(60), work)
            .await
            .map_err(|_| Error::Observation(ObservationError::Transport))
            .and_then(|r| r);
        match (result, bound) {
            (Ok(row), _) => Mutation::complete(row),
            (Err(error), Some(row)) => Mutation::partial(row, diagnostic(error)),
            (Err(error), None) => Mutation::failed(diagnostic(error)),
        }
    }
    async fn remove(&self, _: &str, prior: &Row, _: bool) -> Result<(), ObservationError> {
        let work = async { self.discard(&self.spec(prior)?, prior).await };
        tokio::time::timeout(Duration::from_secs(30), work)
            .await
            .map_err(|_| ObservationError::Transport)?
            .map_err(diagnostic)
    }
}
#[cfg(all(test, unix))]
#[path = "protected_files_tests.rs"]
mod tests;
