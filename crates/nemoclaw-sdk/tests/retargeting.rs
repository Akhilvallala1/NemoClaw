// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Re-authoring each example for each gateway target needs exactly the edits
//! that docs/usage.md lists. This covers authored documents only: state binds
//! a deployment's target, so a live deployment never moves.

use crate::examples;
use nemoclaw_sdk::config::{Document, schema::input_schema};
use serde_json::{Value, json};
use std::collections::BTreeSet;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Target {
    ManagedDocker,
    ManagedPodman,
    ManagedKubernetes,
    ExternalDocker,
    ExternalPodman,
    ExternalKubernetes,
}

impl Target {
    const ALL: [Self; 6] = [
        Self::ManagedDocker,
        Self::ManagedPodman,
        Self::ManagedKubernetes,
        Self::ExternalDocker,
        Self::ExternalPodman,
        Self::ExternalKubernetes,
    ];

    /// A gateway of this kind with only the target's required fields.
    fn gateway(self) -> Value {
        const DOCKER: &str = "unix:///var/run/docker.sock";
        const PODMAN: &str = "unix:///run/user/1000/podman/podman.sock";
        let managed = |target| json!({"management": "managed", "target": target});
        let external = |target| {
            json!({
                "management": "external",
                "endpoint": "https://openshell.example.com",
                "target": target
            })
        };
        match self {
            Self::ManagedDocker => managed(json!({"docker": {}})),
            Self::ManagedPodman => managed(json!({"podman": {"engine": PODMAN}})),
            Self::ManagedKubernetes => managed(json!({"kubernetes": {
                "endpoint": "https://127.0.0.1:17690",
                "kubeconfig": {"env": "CLUSTER_KUBECONFIG"},
                "context": "cluster",
                "namespace": "agents",
                "authentication": {"profile": "development"}
            }})),
            Self::ExternalDocker => external(json!({"docker": {"engine": DOCKER}})),
            Self::ExternalPodman => external(json!({"podman": {"engine": PODMAN}})),
            Self::ExternalKubernetes => external(json!({"kubernetes": {}})),
        }
    }

    fn kubernetes(self) -> bool {
        matches!(self, Self::ManagedKubernetes | Self::ExternalKubernetes)
    }
}

/// The edits docs/usage.md lists for moving a document to another target.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
enum Edit {
    /// Kubernetes: no engine supplies a default image, so each sandbox names
    /// its `image.ref`.
    SetImageRef,
    /// Kubernetes: `image.metadata` stands in for engine image inspection.
    AddImageMetadata,
    /// Kubernetes: no managed services, so each `serviceRef` provider uses an
    /// external endpoint instead.
    ReplaceServices,
    /// Docker and Podman: the engine inspects the image instead.
    RemoveImageMetadata,
    /// Other than managed Docker: each Ollama and vLLM service needs explicit
    /// `placement` and `publication`, since only a managed Docker gateway
    /// lends its engine and network to services. An `ollamaProxy` service
    /// needs an explicit `engine` instead; no example declares one.
    PlaceServices,
}

/// The edits that resolve each violation a retargeted example reports. A
/// schema violation is its field, with map keys as `*`, and keyword; the
/// others are semantic messages.
const RESOLUTIONS: &[(&str, &[Edit])] = &[
    (
        "/spec/sandboxes/*/image: required",
        &[Edit::SetImageRef, Edit::AddImageMetadata],
    ),
    (
        "/spec/sandboxes/*/image/metadata: required",
        &[Edit::AddImageMetadata],
    ),
    ("/spec/sandboxes/*/image: not", &[Edit::RemoveImageMetadata]),
    ("/spec/services: maxProperties", &[Edit::ReplaceServices]),
    (
        "Ollama requires the managed gateway Docker engine or explicit placement",
        &[Edit::PlaceServices],
    ),
    (
        "vLLM requires the managed gateway Docker engine or explicit placement",
        &[Edit::PlaceServices],
    ),
];

/// The edits moving `example` to `target` needs, predicted from its features.
fn predicted(example: &Value, target: Target) -> BTreeSet<Edit> {
    let sandboxes = values(&example["spec"]["sandboxes"]);
    let services = values(&example["spec"]["services"]);
    let named = |sandbox: &&Value| has_image_ref(sandbox);
    let described = |sandbox: &&Value| sandbox["image"].get("metadata").is_some();
    let placed = |service: &&Value| service.get("placement").is_some();
    let cluster = target.kubernetes();
    [
        (Edit::SetImageRef, cluster && !sandboxes.iter().all(named)),
        (
            Edit::AddImageMetadata,
            cluster && !sandboxes.iter().all(described),
        ),
        (Edit::ReplaceServices, cluster && !services.is_empty()),
        (
            Edit::RemoveImageMetadata,
            !cluster && sandboxes.iter().any(described),
        ),
        (
            Edit::PlaceServices,
            !cluster && target != Target::ManagedDocker && !services.iter().all(placed),
        ),
    ]
    .into_iter()
    .filter_map(|(edit, needed)| needed.then_some(edit))
    .collect()
}

#[test]
fn retargeting_each_example_needs_only_the_documented_edits() {
    let validator = jsonschema::validator_for(&input_schema()).unwrap();
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let paths = examples::yaml_files(&root.join("examples"));
    assert!(!paths.is_empty());
    let mut failures = Vec::new();
    for path in paths {
        let text = std::fs::read_to_string(&path).unwrap();
        let example: Value = serde_saphyr::from_str(&text).unwrap();
        let defaulted = serde_json::to_value(Document::parse(text.as_bytes()).unwrap()).unwrap();
        let name = path.strip_prefix(&root).unwrap().display();
        for target in Target::ALL {
            let expected = predicted(&example, target);
            match required_edits(&validator, &example, &defaulted, target) {
                Ok(edits) if edits == expected => {}
                Ok(edits) => failures.push(format!(
                    "{name} to {target:?} needs {edits:?}; the rule table predicts {expected:?}"
                )),
                Err(violation) => failures.push(format!("{name} to {target:?}: {violation}")),
            }
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

/// Retarget `example`, then apply the documented edit for each violation
/// until it parses. Returns the edits applied, or a violation that no edit
/// resolves.
fn required_edits(
    validator: &jsonschema::Validator,
    example: &Value,
    defaulted: &Value,
    target: Target,
) -> Result<BTreeSet<Edit>, String> {
    let mut document = example.clone();
    document["spec"]["gateway"] = target.gateway();
    let mut applied = BTreeSet::new();
    loop {
        let violations = violations(validator, &document);
        if violations.is_empty() {
            return Ok(applied);
        }
        let mut round = BTreeSet::new();
        for (class, violation) in violations {
            let (_, edits) = RESOLUTIONS
                .iter()
                .find(|(known, _)| *known == class)
                .ok_or_else(|| format!("no documented edit resolves {violation}"))?;
            if let Some(edit) = edits.iter().find(|edit| applied.contains(*edit)) {
                return Err(format!("{edit:?} did not resolve {violation}"));
            }
            round.extend(edits.iter().copied());
        }
        for edit in &round {
            edit.apply(&mut document, defaulted);
        }
        applied.extend(round);
    }
}

/// Every schema violation, or else the first semantic one, each as its
/// class in `RESOLUTIONS` and as reported.
fn violations(validator: &jsonschema::Validator, document: &Value) -> Vec<(String, String)> {
    let schema: Vec<_> = validator
        .iter_errors(document)
        .map(|error| {
            let mut path = error.instance_path().as_str().to_owned();
            if let jsonschema::error::ValidationErrorKind::Required { property } = error.kind() {
                path = format!("{path}/{}", property.as_str().unwrap());
            }
            let keyword = error.kind().keyword();
            (
                format!("{}: {keyword}", any_key(&path)),
                format!("{path}: {keyword}"),
            )
        })
        .collect();
    if !schema.is_empty() {
        return schema;
    }
    match Document::parse(document.to_string().as_bytes()) {
        Ok(_) => Vec::new(),
        Err(error) => vec![(error.to_string(), error.to_string())],
    }
}

/// `pointer` with each sandbox, service, and inference provider key as `*`.
fn any_key(pointer: &str) -> String {
    let mut map = false;
    pointer
        .split('/')
        .map(|segment| {
            let key = std::mem::replace(
                &mut map,
                matches!(segment, "sandboxes" | "services" | "inferenceProviders"),
            );
            if key { "*" } else { segment }
        })
        .collect::<Vec<_>>()
        .join("/")
}

impl Edit {
    fn apply(self, document: &mut Value, defaulted: &Value) {
        let spec = &mut document["spec"];
        match self {
            Self::SetImageRef => {
                for sandbox in values_mut(&mut spec["sandboxes"]) {
                    if !has_image_ref(sandbox) {
                        sandbox["image"]["ref"] = json!(format!(
                            "registry.example.com/nemoclaw/openclaw@sha256:{}",
                            "0".repeat(64)
                        ));
                    }
                }
            }
            Self::AddImageMetadata => {
                for sandbox in values_mut(&mut spec["sandboxes"]) {
                    sandbox["image"]["metadata"] = json!({"env": "NEMOCLAW_AGENT_IMAGE_METADATA"});
                }
            }
            Self::ReplaceServices => {
                spec.as_object_mut().unwrap().remove("services");
                use_external_endpoints(spec);
            }
            Self::RemoveImageMetadata => {
                for sandbox in values_mut(&mut spec["sandboxes"]) {
                    sandbox["image"].as_object_mut().unwrap().remove("metadata");
                }
            }
            Self::PlaceServices => {
                for (name, service) in spec["services"].as_object_mut().unwrap() {
                    if service.get("placement").is_some() {
                        continue;
                    }
                    let port = &defaulted["spec"]["services"][name]["serving"]["port"];
                    service["placement"] =
                        json!({"engine": "ssh://gpu-box", "networkCidr": "172.30.119.0/24"});
                    service["publication"] = json!({
                        "endpoint": format!("http://10.0.0.8:{port}/v1"),
                        "bindAddress": "10.0.0.8"
                    });
                }
            }
        }
    }
}

/// Points each provider that names a service at an external endpoint.
fn use_external_endpoints(value: &mut Value) {
    match value {
        Value::Object(object) => {
            if object.remove("serviceRef").is_some() {
                object.insert("endpoint".into(), json!("https://inference.example.com/v1"));
            }
            object.values_mut().for_each(use_external_endpoints);
        }
        Value::Array(items) => items.iter_mut().for_each(use_external_endpoints),
        _ => {}
    }
}

/// The schema already requires an authored `image.ref` to be pinned by digest.
fn has_image_ref(sandbox: &Value) -> bool {
    sandbox["image"]["ref"]
        .as_str()
        .is_some_and(|image| !image.is_empty())
}

fn values(map: &Value) -> Vec<&Value> {
    map.as_object()
        .map(|map| map.values().collect())
        .unwrap_or_default()
}

fn values_mut(map: &mut Value) -> impl Iterator<Item = &mut Value> {
    map.as_object_mut().unwrap().values_mut()
}
