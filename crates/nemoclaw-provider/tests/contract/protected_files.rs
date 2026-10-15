// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Authored `protected_files` inputs through pinned OpenTofu.

use nemoclaw_sdk::services::installers::container::inputs::{self as files, Files};
use serde_json::{Value, json};
use std::fs;

/// The compiled fixture's inputs as authored HCL, with a literal agent ref.
fn authored(files: &Files) -> Value {
    let mut resource = json!({});
    for (field, value) in files.row() {
        if files::SCALAR_FIELDS.contains(&field.as_str()) {
            resource[field] = json!(value);
        }
    }
    for input in files::structured_inputs() {
        if let Some(encoded) = files.row().get(input.field) {
            resource[input.attribute] = input.configuration(encoded).unwrap();
        }
    }
    let agent = files.agent.as_ref().unwrap();
    resource["agent"] = json!({
        "type": files::references()[0].kind, "workspace": agent.workspace,
        "sandbox": agent.sandbox, "sandbox_id": "11111111-2222-3333-4444-555555555555",
        "owner": agent.owner, "name": agent.name,
    });
    resource
}

#[test]
#[ignore = "requires NEMOCLAW_TEST_BUNDLE; offline input validation"]
fn authored_protected_files_are_validated_offline_without_echoing_inputs() {
    use nemoclaw_sdk::{compile, config::Document};
    let document = Document::parse(
        include_bytes!(
            "../../../nemoclaw-sdk/tests/fixtures/config/container-agent-connection.yaml"
        )
        .as_slice(),
    )
    .unwrap();
    let generations = [
        "workspace",
        "provider",
        "sandbox",
        "ollama_service",
        "managed_gateway",
        "container_service",
    ]
    .map(|kind| (kind.into(), "a".repeat(32)))
    .into();
    let target = compile::targets(&document, &generations)
        .unwrap()
        .into_iter()
        .find(|target| target.kind == files::FILES_KIND)
        .unwrap();
    let valid = authored(&Files::from_row(&target.values).unwrap());
    let workspace = crate::workspace();
    for fault in [None, Some("owner"), Some("generation"), Some("credential")] {
        let mut resource = valid.clone();
        match fault {
            Some("credential") => {
                let name = resource["credentials"]
                    .as_object()
                    .unwrap()
                    .keys()
                    .next()
                    .unwrap()
                    .clone();
                resource["credentials"][name]["env"] = json!("PRIVATE_SENTINEL=");
            }
            Some(attribute) => resource[attribute] = json!(""),
            None => {}
        }
        fs::write(
            workspace.path().join("main.tf.json"),
            json!({
                "terraform":{"required_providers":{"protected":{"source":"registry.opentofu.org/nvidia/protected"}}},
                "provider":{"protected":{}},
                "resource":{"protected_files":{"application":resource}}
            })
            .to_string(),
        )
        .unwrap();
        let output = workspace
            .command()
            .args(["validate", "-json"])
            .output()
            .unwrap();
        let report: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(
            output.status.success(),
            fault.is_none(),
            "{fault:?}: {report}"
        );
        if fault.is_some() {
            let diagnostic = report["diagnostics"]
                .as_array()
                .unwrap()
                .iter()
                .find(|diagnostic| diagnostic["summary"] == "Invalid configuration")
                .unwrap_or_else(|| panic!("{report}"));
            // OpenTofu adds the authored source snippet; the provider's own
            // detail must not copy input values.
            assert!(
                !diagnostic["detail"]
                    .as_str()
                    .unwrap()
                    .contains("PRIVATE_SENTINEL")
            );
        }
        assert!(!workspace.path().join("terraform.tfstate").exists());
    }
}
