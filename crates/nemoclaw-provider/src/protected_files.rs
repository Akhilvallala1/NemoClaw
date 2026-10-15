// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! `protected_files`: publishes an application's credential files and agent
//! connection descriptor into a fresh owned volume. Docker's archive API
//! writes them through a setup container that is created but never started.
use crate::{Backend, Error, Mutation, ObservationError, Row};
use async_trait::async_trait;
use bollard::{
    models::ContainerInspectResponse,
    query_parameters::{CreateContainerOptions, RemoveContainerOptions, RemoveVolumeOptions},
};
use nemoclaw_sdk::{
    managed::{GENERATION_LABEL, OWNER_LABEL},
    services::installers::container::inputs::{
        self as files, DESCRIPTOR, Files, MARKER, ROOT, credential_file,
    },
};
use serde_json::json;
use std::{collections::HashMap, time::Duration};

const INPUT_LABEL: &str = "nemoclaw.nvidia.com/protected-files";
const MAX_CREDENTIAL_BYTES: usize = 4096;

pub(crate) fn definition() -> crate::Definition {
    let fields = files::fields();
    let mut definition = crate::Definition::new(files::FILES_KIND, &fields, &[])
        .optional(&files::optional_fields())
        .computed("complete", crate::rerun_when_stopped)
        .computed("id", identity_plan)
        .validate_inputs(validate);
    definition.structured = files::structured_inputs();
    definition.references = files::references();
    definition
}

/// Check known inputs offline; the agent's sandbox identity may still be unknown.
fn validate(known: &Row, unknown: &[&str]) -> Result<(), std::borrow::Cow<'static, str>> {
    if !unknown.is_empty() {
        return Ok(());
    }
    Files::from_row(known)
        .map_err(|error| error.to_string())?
        .validate(false)
        .map_err(|error| error.to_string().into())
}

/// An incomplete publication is published again, under a new identity.
fn identity_plan(name: &str, prior: &crate::State) -> Option<tf_provider::value::Value<String>> {
    use tf_provider::value::Value;
    if prior.get("complete") == Some(&Value::Value("false".into())) {
        Some(Value::Unknown)
    } else {
        crate::carry_prior(name, prior)
    }
}

/// A credential a file can hold: printable ASCII without spaces.
fn credential(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_CREDENTIAL_BYTES
        && value.bytes().all(|b| (0x21..=0x7e).contains(&b))
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
    #[cfg(test)]
    fn with_secrets(mut self, secrets: std::sync::Arc<dyn nemoclaw_sdk::Secrets>) -> Self {
        self.secrets = secrets;
        self
    }
    fn spec(&self, row: &Row) -> Result<Files, Error> {
        let spec = Files::from_row(row)?;
        spec.validate(true)?;
        if self.engine.endpoint() != spec.engine {
            return Err(ObservationError::BindingMismatch.into());
        }
        Ok(spec)
    }
    /// The credential values, read before anything changes.
    fn values(&self, spec: &Files) -> Result<Vec<(String, String)>, Error> {
        spec.credentials
            .iter()
            .map(|(name, env)| {
                let value = self.secrets.resolve(env)?;
                if !credential(&value) {
                    return Err(ObservationError::Authentication.into());
                }
                Ok((name.clone(), value))
            })
            .collect()
    }
    /// The owned helper, or `None` when absent; a foreign one is refused.
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
        let owned = labels(spec)
            .iter()
            .all(|(key, value)| observed.and_then(|l| l.get(key)) == Some(value))
            && helper
                .state
                .as_ref()
                .and_then(|s| s.status)
                .map(|s| s.to_string())
                == Some("created".into())
            && mounts.len() == 1
            && mounts[0].name.as_deref() == Some(spec.helper_name().as_str())
            && mounts[0].destination.as_deref() == Some(ROOT)
            && row
                .get("id")
                .is_none_or(|bound| bound.is_empty() || bound == id);
        if !owned || id.is_empty() {
            return Err(ObservationError::BindingMismatch.into());
        }
        Ok(Some(helper))
    }
    /// Whether the publication finished: the marker is written last, after one
    /// archive write that created every file with its owner and mode.
    async fn complete(&self, id: &str, spec: &Files) -> Result<bool, Error> {
        let marker = self
            .engine
            .read_file(id, &format!("{ROOT}/{MARKER}"), 64)
            .await?;
        Ok(marker.as_deref() == Some(spec.revision().as_bytes()))
    }
    /// Delete the owned helper and its volume.
    async fn discard(&self, spec: &Files, row: &Row) -> Result<(), Error> {
        if let Some(helper) = self.helper(spec, row).await? {
            let id = helper.id.unwrap_or_default();
            self.engine
                .api
                .remove_container(&id, None::<RemoveContainerOptions>)
                .await
                .map_err(|e| crate::docker::remote(&e))?;
        }
        if let Some(volume) = self.engine.volume(&spec.helper_name()).await? {
            if volume.labels.get(OWNER_LABEL) != Some(&spec.owner)
                || volume.labels.get(GENERATION_LABEL) != Some(&spec.generation)
            {
                return Err(ObservationError::BindingMismatch.into());
            }
            self.engine
                .api
                .remove_volume(&volume.name, None::<RemoveVolumeOptions>)
                .await
                .map_err(|e| crate::docker::remote(&e))?;
        }
        Ok(())
    }
    /// Create a fresh volume and helper, then write the files and the marker.
    async fn publish(&self, spec: &Files, values: &[(String, String)]) -> Result<String, Error> {
        let name = spec.helper_name();
        let labels = labels(spec);
        self.engine
            .api
            .create_volume(bollard::models::VolumeCreateRequest {
                name: Some(name.clone()),
                driver: Some("local".into()),
                labels: Some(labels.clone()),
                ..Default::default()
            })
            .await
            .map_err(|e| crate::docker::remote(&e))?;
        let config = serde_json::from_value(json!({
            "Image": spec.image, "Labels": labels,
            "HostConfig": {"NetworkMode": "none", "Mounts": [
                {"Type": "volume", "Source": name, "Target": ROOT, "VolumeOptions": {"NoCopy": true}}
            ]}
        }))
        .map_err(|_| Error::State("invalid setup container configuration"))?;
        let id = self
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
            .map_err(|e| crate::docker::remote(&e))?
            .id;
        self.engine
            .write_archive(&id, ROOT, archive(spec, values)?)
            .await?;
        self.engine
            .write_files(&id, ROOT, &[(MARKER, spec.revision().as_bytes(), 0o644)])
            .await?;
        Ok(id)
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

/// Credential files and the descriptor, owned by the application user:
/// directories 0700 and files 0600.
fn archive(spec: &Files, values: &[(String, String)]) -> Result<Vec<u8>, Error> {
    let (uid, gid) = spec.user.split_once(':').unwrap_or_default();
    let (uid, gid) = (uid.parse().unwrap_or(0), gid.parse().unwrap_or(0));
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
    if !values.is_empty() {
        append("secrets", &[], true)?;
    }
    for (name, value) in values {
        append(&credential_file(name), value.as_bytes(), false)?;
    }
    if let Some(descriptor) = spec.descriptor()? {
        append(DESCRIPTOR, descriptor.to_string().as_bytes(), false)?;
    }
    builder
        .into_inner()
        .map_err(|_| Error::State("cannot prepare protected files"))
}

fn observed(mut row: Row, id: String, complete: bool) -> Row {
    row.insert("id".into(), id);
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
            self.helper(&self.spec(prior)?, prior).await?;
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
            let Some(helper) = self.helper(&spec, prior).await? else {
                return Ok(None);
            };
            let id = helper.id.unwrap_or_default();
            let complete = !removing && self.complete(&id, &spec).await?;
            Ok(Some(observed(prior.clone(), id, complete)))
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
            if let Some(helper) = self.helper(&spec, desired).await? {
                let id = helper.id.unwrap_or_default();
                if self.complete(&id, &spec).await? {
                    return Ok(observed(desired.clone(), id, true));
                }
            }
            // An incomplete publication starts again in a fresh volume.
            self.discard(&spec, desired).await?;
            let id = self.publish(&spec, &values).await?;
            bound = Some(observed(desired.clone(), id.clone(), false));
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
