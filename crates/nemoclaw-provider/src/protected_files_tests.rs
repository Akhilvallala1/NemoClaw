// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! A fake Docker engine proves ordering, custody, and ownership, not Linux
//! filesystem enforcement.
use super::*;
use crate::docker::fixture::Fixture;
use std::sync::{Arc, Mutex};

const SENTINEL: &str = "test-only-protected-token";

struct Secrets(bool);
impl nemoclaw_sdk::Secrets for Secrets {
    fn resolve(&self, _: &str) -> Result<String, ObservationError> {
        if self.0 {
            Ok(SENTINEL.into())
        } else {
            Err(ObservationError::Authentication)
        }
    }
}

/// The compiled inputs of the credential-file fixture.
fn row(engine: &str) -> Row {
    let document = nemoclaw_sdk::config::Document::parse(
        include_bytes!("../../nemoclaw-sdk/tests/fixtures/config/container-credentials.yaml")
            .as_slice(),
    )
    .unwrap();
    let generations = [
        "workspace",
        "provider",
        "sandbox",
        "managed_gateway",
        "container_service",
    ]
    .map(|kind| (kind.into(), "a".repeat(32)))
    .into();
    let mut row = nemoclaw_sdk::compile::targets(&document, &generations)
        .unwrap()
        .into_iter()
        .find(|t| t.kind == files::FILES_KIND)
        .unwrap()
        .values;
    row.insert("engine".into(), engine.into());
    row
}

#[derive(Default)]
struct Engine {
    helper: Option<serde_json::Value>,
    volume: Option<serde_json::Value>,
    files: Vec<(String, Vec<u8>)>,
    uploads: Vec<Vec<u8>>,
    requests: Vec<(String, String)>,
    creates: usize,
    fail_upload: bool,
}

/// A stateful engine that holds one helper container and one volume.
async fn engine(state: Arc<Mutex<Engine>>) -> Fixture {
    Fixture::engine(move |request| {
        let mut state = state.lock().unwrap();
        let route = request.path.split('?').next().unwrap().to_owned();
        state
            .requests
            .push((request.method.clone(), request.path.clone()));
        assert!(!request.path.contains(SENTINEL));
        let found = |value: &Option<serde_json::Value>| match value {
            Some(value) => (200, serde_json::to_vec(value).unwrap()),
            None => (404, b"{}".to_vec()),
        };
        Some(match (request.method.as_str(), route.as_str()) {
            ("GET", route) if route.starts_with("/volumes/") => found(&state.volume),
            ("POST", "/volumes/create") => {
                let body: serde_json::Value = serde_json::from_slice(&request.body).unwrap();
                let volume = json!({"Name":body["Name"],"Driver":"local","Labels":body["Labels"],
                    "Mountpoint":"/var/lib/docker/volumes/inputs/_data","Scope":"local","Options":{}});
                state.volume = Some(volume.clone());
                (201, serde_json::to_vec(&volume).unwrap())
            }
            ("DELETE", route) if route.starts_with("/volumes/") => {
                state.volume = None;
                (204, vec![])
            }
            ("POST", "/containers/create") => {
                let body: serde_json::Value = serde_json::from_slice(&request.body).unwrap();
                assert!(!body.to_string().contains(SENTINEL));
                assert_eq!(body["HostConfig"]["NetworkMode"], "none");
                let name = url::form_urlencoded::parse(request.path.split_once('?').unwrap().1.as_bytes())
                    .find(|(key, _)| key == "name").unwrap().1.into_owned();
                state.creates += 1;
                let id = format!("helper-{}", state.creates);
                state.helper = Some(json!({"Id":id,"Name":format!("/{name}"),
                    "Config":{"Image":body["Image"],"Labels":body["Labels"]},"State":{"Status":"created"},
                    "Mounts":[{"Type":"volume","Name":body["HostConfig"]["Mounts"][0]["Source"],
                        "Destination":ROOT,"RW":true}]}));
                (201, serde_json::to_vec(&json!({"Id":id,"Warnings":[]})).unwrap())
            }
            ("GET", route) if route.ends_with("/json") => found(&state.helper),
            ("DELETE", route) if route.starts_with("/containers/") => {
                state.helper = None;
                state.files.clear();
                (204, vec![])
            }
            ("PUT", route) if route.ends_with("/archive") => {
                if state.fail_upload { return Some((503, b"{}".to_vec())); }
                let mut archive = tar::Archive::new(request.body.as_slice());
                for entry in archive.entries().unwrap() {
                    let mut entry = entry.unwrap();
                    let mut bytes = Vec::new();
                    std::io::Read::read_to_end(&mut entry, &mut bytes).unwrap();
                    let path = entry.path().unwrap().display().to_string();
                    state.files.retain(|(name, _)| *name != path);
                    state.files.push((path, bytes));
                }
                state.uploads.push(request.body.clone());
                (200, vec![])
            }
            ("GET", route) if route.ends_with("/archive") => {
                let path = request
                    .path
                    .split("path=")
                    .nth(1)
                    .unwrap()
                    .replace("%2F", "/");
                let name = path.trim_start_matches(&format!("{ROOT}/")).to_owned();
                match state.files.iter().find(|(file, _)| *file == name) {
                    Some((_, bytes)) => (
                        200,
                        nemoclaw_docker::archive(&[(name.as_str(), bytes, 0o600)]).unwrap(),
                    ),
                    None => (404, b"{}".to_vec()),
                }
            }
            (method, route) => panic!("unexpected Docker request {method} {route}"),
        })
    })
    .await
}

#[tokio::test]
async fn failed_upload_retains_the_helper_binding_for_explicit_recovery() {
    let state = Arc::new(Mutex::new(Engine {
        fail_upload: true,
        ..Default::default()
    }));
    let fixture = engine(state.clone()).await;
    let desired = row("unix:///var/run/docker.sock");
    let backend = FilesBackend::new(fixture.engine_for("unix:///var/run/docker.sock"))
        .with_secrets(Arc::new(Secrets(true)));
    let failed = backend.ensure(files::FILES_KIND, &desired).await;
    assert!(failed.error().is_some());
    let partial = failed
        .state()
        .expect("an interrupted upload must keep its owned binding")
        .clone();
    assert_eq!(partial["complete"], "false");
    assert!(!partial["helper_id"].is_empty());
    assert!(!format!("{partial:?}").contains(SENTINEL));
    let read = backend
        .read(files::FILES_KIND, &partial, false)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(read["complete"], "false");
    // Losing only the helper is not loss of the still-owned volume binding.
    state.lock().unwrap().helper = None;
    let volume_only = backend
        .read(files::FILES_KIND, &partial, false)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(volume_only["id"], partial["id"]);
    assert_eq!(volume_only["complete"], "false");
    state.lock().unwrap().fail_upload = false;
    let mut retry = volume_only;
    retry.insert("helper_id".into(), String::new());
    let recovered = backend.ensure(files::FILES_KIND, &retry).await;
    assert!(recovered.error().is_none(), "{:?}", recovered.error());
    let recovered = recovered.state().unwrap();
    assert_eq!(recovered["complete"], "true");
    assert_ne!(recovered["helper_id"], partial["helper_id"]);
    backend
        .remove(files::FILES_KIND, recovered, true)
        .await
        .unwrap();
}

#[tokio::test]
async fn publication_checks_credentials_first_writes_private_files_once_and_cleans_up() {
    let state = Arc::new(Mutex::new(Engine::default()));
    let fixture = engine(state.clone()).await;
    let desired = row("unix:///var/run/docker.sock");
    let backend = |available| {
        FilesBackend::new(fixture.engine_for("unix:///var/run/docker.sock"))
            .with_secrets(Arc::new(Secrets(available)))
    };

    // A missing credential stops before any Docker request.
    assert!(
        backend(false)
            .ensure(files::FILES_KIND, &desired)
            .await
            .error()
            .is_some()
    );
    assert!(state.lock().unwrap().requests.is_empty());

    let published = backend(true).ensure(files::FILES_KIND, &desired).await;
    assert!(published.error().is_none(), "{:?}", published.error());
    let published = published.state().unwrap().clone();
    assert_eq!(published["complete"], "true");
    assert!(!format!("{published:?}").contains(SENTINEL));
    {
        let state = state.lock().unwrap();
        assert!(
            !state
                .requests
                .iter()
                .any(|(_, path)| path.ends_with("/start"))
        );
        let mut archive = tar::Archive::new(state.uploads[0].as_slice());
        for entry in archive.entries().unwrap() {
            let header = entry.unwrap().header().clone();
            let directory = header.entry_type().is_dir();
            assert_eq!(
                header.mode().unwrap(),
                if directory { 0o700 } else { 0o600 }
            );
            assert_eq!(
                (header.uid().unwrap(), header.gid().unwrap()),
                (65532, 65532)
            );
        }
        assert!(
            state
                .files
                .iter()
                .any(|(path, value)| path == "secrets/speech" && value == SENTINEL.as_bytes())
        );
    }

    // An unchanged apply reads the marker and writes nothing.
    let uploads = state.lock().unwrap().uploads.len();
    let read = backend(true)
        .read(files::FILES_KIND, &published, false)
        .await
        .unwrap();
    assert_eq!(read.as_ref(), Some(&published));
    assert!(
        backend(true)
            .ensure(files::FILES_KIND, &published)
            .await
            .error()
            .is_none()
    );
    assert_eq!(state.lock().unwrap().uploads.len(), uploads);

    // An interrupted publication starts again in a fresh volume.
    state
        .lock()
        .unwrap()
        .files
        .retain(|(name, _)| name != MARKER);
    let read = backend(true)
        .read(files::FILES_KIND, &published, false)
        .await
        .unwrap();
    assert_eq!(read.unwrap()["complete"], "false");
    let mut retry = published.clone();
    retry.insert("helper_id".into(), String::new());
    let repaired = backend(true).ensure(files::FILES_KIND, &retry).await;
    assert!(repaired.error().is_none(), "{:?}", repaired.error());
    let repaired = repaired.state().unwrap().clone();
    assert_eq!(repaired["id"], published["id"]);
    assert_ne!(repaired["helper_id"], published["helper_id"]);
    let published = repaired;
    assert!(
        state
            .lock()
            .unwrap()
            .requests
            .iter()
            .any(|(m, p)| m == "DELETE" && p.starts_with("/volumes/"))
    );

    // A foreign helper OR volume must prevent cleanup of either object.
    for foreign_volume in [false, true] {
        let set_owner = |owner: &str| {
            let mut state = state.lock().unwrap();
            if foreign_volume {
                state.volume.as_mut().unwrap()["Labels"][OWNER_LABEL] = json!(owner);
            } else {
                state.helper.as_mut().unwrap()["Config"]["Labels"][OWNER_LABEL] = json!(owner);
            }
        };
        set_owner("foreign");
        let deletes = |state: &Engine| state.requests.iter().filter(|(m, _)| m == "DELETE").count();
        let before = deletes(&state.lock().unwrap());
        assert!(
            backend(true)
                .read(files::FILES_KIND, &published, false)
                .await
                .is_err()
        );
        assert!(
            backend(true)
                .ensure(files::FILES_KIND, &published)
                .await
                .error()
                .is_some()
        );
        assert!(
            backend(true)
                .remove(files::FILES_KIND, &published, true)
                .await
                .is_err()
        );
        assert_eq!(deletes(&state.lock().unwrap()), before);
        set_owner(&published["owner"]);
    }

    // Removal deletes the owned helper and volume.
    backend(true)
        .remove(files::FILES_KIND, &published, true)
        .await
        .unwrap();
    let state = state.lock().unwrap();
    assert!(state.helper.is_none() && state.volume.is_none());
}
