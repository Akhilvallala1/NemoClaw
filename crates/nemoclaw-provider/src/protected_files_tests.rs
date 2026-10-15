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

/// The compiled inputs of the connection fixture, with its agent resolved.
fn row(engine: &str) -> Row {
    let document = nemoclaw_sdk::config::Document::parse(
        include_bytes!("../../nemoclaw-sdk/tests/fixtures/config/container-agent-connection.yaml")
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
    row.insert(
        "agent_sandbox_id".into(),
        "11111111-2222-3333-4444-555555555555".into(),
    );
    row
}

#[derive(Default)]
struct Engine {
    helper: Option<serde_json::Value>,
    volume: Option<serde_json::Value>,
    files: Vec<(String, Vec<u8>)>,
    uploads: Vec<Vec<u8>>,
    requests: Vec<(String, String)>,
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
                let name = request.path.split("name=").nth(1).unwrap();
                state.helper = Some(json!({"Id":"helper-id","Name":format!("/{name}"),
                    "Config":{"Labels":body["Labels"]},"State":{"Status":"created"},
                    "Mounts":[{"Type":"volume","Name":body["HostConfig"]["Mounts"][0]["Source"],
                        "Destination":ROOT}]}));
                (201, br#"{"Id":"helper-id","Warnings":[]}"#.to_vec())
            }
            ("GET", route) if route.ends_with("/json") => found(&state.helper),
            ("DELETE", route) if route.starts_with("/containers/") => {
                state.helper = None;
                state.files.clear();
                (204, vec![])
            }
            ("PUT", route) if route.ends_with("/archive") => {
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
        let descriptor = &state.files.iter().find(|(f, _)| f == DESCRIPTOR).unwrap().1;
        let descriptor: serde_json::Value = serde_json::from_slice(descriptor).unwrap();
        assert_eq!(
            descriptor["authentication"]["credentialFile"],
            "/run/nemoclaw/secrets/openshell"
        );
        assert!(!descriptor.to_string().contains(SENTINEL));
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
    retry.insert("id".into(), String::new());
    assert!(
        backend(true)
            .ensure(files::FILES_KIND, &retry)
            .await
            .error()
            .is_none()
    );
    assert!(
        state
            .lock()
            .unwrap()
            .requests
            .iter()
            .any(|(m, p)| m == "DELETE" && p.starts_with("/volumes/"))
    );

    // Foreign resources are refused and never deleted.
    let owner = OWNER_LABEL.to_owned();
    state.lock().unwrap().helper.as_mut().unwrap()["Config"]["Labels"][owner.as_str()] =
        json!("foreign");
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

    // Removal deletes the owned helper and volume.
    state.lock().unwrap().helper.as_mut().unwrap()["Config"]["Labels"][owner.as_str()] =
        json!(published["owner"]);
    backend(true)
        .remove(files::FILES_KIND, &published, true)
        .await
        .unwrap();
    let state = state.lock().unwrap();
    assert!(state.helper.is_none() && state.volume.is_none());
}
