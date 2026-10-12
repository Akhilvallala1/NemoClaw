// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use crate::{
    args::{Cli, Command},
    credentials,
    deployment::create as deployment,
    io::document,
};
use nemoclaw_sdk::{CancellationToken, OperationResult, Progress, config::Document};
use std::{path::Path, sync::Arc};
use tokio::io::{AsyncBufReadExt, AsyncRead};

pub(crate) enum CommandResult {
    Export(Box<Document>),
    Authored(Option<std::path::PathBuf>),
    Operation(Box<OperationResult>),
}

pub(crate) async fn run<R: AsyncRead + Unpin>(
    cli: Cli,
    mut stdin: R,
    cancel: &CancellationToken,
    progress: Arc<dyn Fn(Progress) + Send + Sync>,
) -> Result<CommandResult, Box<dyn std::error::Error>> {
    let Cli {
        state_dir,
        bundle_dir,
        command,
        ..
    } = cli;
    if let Command::Onboard { file, output } = &command {
        let source = file.as_deref().map_or(
            nemoclaw_onboarding::Source::Defaults,
            nemoclaw_onboarding::Source::Template,
        );
        let saved = nemoclaw_onboarding::author(source, output, true, cancel).await?;
        return Ok(CommandResult::Authored(saved.then(|| output.clone())));
    }
    let mut deployment = deployment(&state_dir, bundle_dir.as_deref(), progress.clone())?;
    let warn = |warnings: Vec<String>| {
        for message in warnings {
            progress(Progress::Warning { message });
        }
    };
    let result = match command {
        Command::Plan { destroy: true, .. } => deployment.plan_destroy(cancel).await?,
        Command::Plan {
            file: Some(file),
            non_interactive,
            ..
        } => {
            let (document, warnings) = document(&file, &mut stdin, cancel).await?;
            warn(warnings);
            let mut lines = tokio::io::BufReader::new(stdin).lines();
            deployment = credentials::attach(
                deployment,
                &document,
                non_interactive,
                file != Path::new("-"),
                &mut lines,
                cancel,
            )
            .await?;
            deployment.plan(&document, cancel).await?
        }
        Command::Apply {
            file,
            non_interactive,
            ..
        } => {
            let (document, warnings) = document(&file, &mut stdin, cancel).await?;
            warn(warnings);
            let mut lines = tokio::io::BufReader::new(stdin).lines();
            deployment = credentials::attach(
                deployment,
                &document,
                non_interactive,
                file != Path::new("-"),
                &mut lines,
                cancel,
            )
            .await?;
            deployment.apply(&document, cancel).await?
        }
        Command::Plan {
            file: None,
            destroy: false,
            ..
        } => return Err("configuration input is required".into()),
        Command::Export { .. } => {
            return Ok(CommandResult::Export(Box::new(
                deployment.export(cancel).await?,
            )));
        }
        Command::Destroy { .. } => deployment.destroy(cancel).await?,
        Command::Onboard { .. } => unreachable!("onboarding returns before deployment setup"),
    };
    Ok(CommandResult::Operation(Box::new(result)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::Parser;
    use std::{
        pin::Pin,
        task::{Context, Poll},
    };
    use tokio::io::ReadBuf;

    struct ForbiddenInput;
    impl AsyncRead for ForbiddenInput {
        fn poll_read(
            self: Pin<&mut Self>,
            _: &mut Context<'_>,
            _: &mut ReadBuf<'_>,
        ) -> Poll<std::io::Result<()>> {
            panic!("this command must not read stdin");
        }
    }

    #[tokio::test]
    async fn observation_and_teardown_commands_never_read_input() {
        for args in [
            vec!["nemoclaw", "plan", "--destroy"],
            vec!["nemoclaw", "destroy"],
            vec!["nemoclaw", "export"],
        ] {
            let directory = tempfile::tempdir().unwrap();
            let mut cli = Cli::try_parse_from(args).unwrap();
            cli.bundle_dir = Some(directory.path().join("missing-bundle"));
            cli.state_dir = directory.path().join("state");
            // The real SDK rejects the missing bundle; no runtime is invoked.
            assert!(
                run(
                    cli,
                    ForbiddenInput,
                    &CancellationToken::new(),
                    Arc::new(|_| {})
                )
                .await
                .is_err()
            );
        }
    }

    #[tokio::test]
    async fn configuration_commands_validate_injected_input_before_creating_state() {
        for command in ["plan", "apply"] {
            let directory = tempfile::tempdir().unwrap();
            let state = directory.path().join("state");
            let mut cli = Cli::try_parse_from(["nemoclaw", command, "-"]).unwrap();
            cli.state_dir = state.clone();
            cli.bundle_dir = Some(directory.path().join("missing-bundle"));
            let error = run(
                cli,
                &b"apiKey: secret-sentinel"[..],
                &CancellationToken::new(),
                Arc::new(|_| {}),
            )
            .await
            .err()
            .unwrap();
            assert!(!error.to_string().contains("secret-sentinel"));
            assert!(!state.exists());
        }
    }

    #[tokio::test]
    async fn legacy_cluster_service_fields_warn_with_their_current_locations() {
        let mut legacy: serde_json::Value =
            serde_saphyr::from_str(include_str!("../../../examples/kubernetes/local-vllm.yaml"))
                .unwrap();
        let service = &mut legacy["spec"]["services"]["qwen"];
        let container = service
            .as_object_mut()
            .unwrap()
            .remove("container")
            .unwrap();
        for field in ["cpuLimitMillis", "memoryLimitGiB"] {
            service["kubernetes"][field] = container[field].clone();
        }
        service["kubernetes"]["updatePolicy"] = "Recreate".into();
        let legacy = legacy.to_string();
        let current = include_str!("../../../examples/kubernetes/local-vllm.yaml");
        for command in ["plan", "apply"] {
            for (input, expected) in [(legacy.as_str(), 3), (current, 0)] {
                let directory = tempfile::tempdir().unwrap();
                let mut cli = Cli::try_parse_from(["nemoclaw", command, "-"]).unwrap();
                cli.state_dir = directory.path().join("state");
                cli.bundle_dir = Some(directory.path().join("missing-bundle"));
                let events = Arc::new(std::sync::Mutex::new(Vec::new()));
                let saved = events.clone();
                // The missing bundle stops the operation after input validation.
                assert!(
                    run(
                        cli,
                        input.as_bytes(),
                        &CancellationToken::new(),
                        Arc::new(move |event| saved.lock().unwrap().push(event)),
                    )
                    .await
                    .is_err()
                );
                let warnings: Vec<_> = events
                    .lock()
                    .unwrap()
                    .iter()
                    .filter_map(|event| match event {
                        Progress::Warning { message } if message.contains("deprecated") => {
                            Some(message.clone())
                        }
                        _ => None,
                    })
                    .collect();
                assert_eq!(warnings.len(), expected, "{command}: {warnings:?}");
                for (old, new) in [
                    ("kubernetes.cpuLimitMillis", "container.cpuLimitMillis"),
                    ("kubernetes.memoryLimitGiB", "container.memoryLimitGiB"),
                    ("kubernetes.updatePolicy", "spec.services.qwen.updatePolicy"),
                ]
                .iter()
                .take(expected)
                {
                    assert!(
                        warnings.iter().any(|warning| warning
                            .contains(&format!("spec.services.qwen.{old}"))
                            && warning.contains(new)),
                        "{command}: {old} -> {new}: {warnings:?}"
                    );
                }
            }
        }
    }
}
