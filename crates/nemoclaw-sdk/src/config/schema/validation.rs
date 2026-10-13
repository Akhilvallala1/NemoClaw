// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Shared structural contract for authored input and normalized SDK values.
use crate::config::{API_VERSION, DEFAULT_AGENT_IMAGE, constraints as c};
use serde_json::{Value, json};

pub(crate) use nemoclaw_runtime::schema::{at, forbid, property};
fn optional_string(
    schema: &mut Value,
    field: &str,
    default: &str,
    constraint: &Value,
    normalized: bool,
) {
    if normalized {
        schema
            .as_object_mut()
            .unwrap()
            .entry("required")
            .or_insert(json!([]))
            .as_array_mut()
            .unwrap()
            .push(json!(field));
    }
    property(
        schema,
        field,
        json!({
            "anyOf": if normalized { json!([constraint]) } else { json!([{ "const": "" }, constraint]) }, "default": default,
            "x-nemoclaw-default-rule": "Omitted or empty selects the default."
        }),
    );
}
pub(super) fn constrain(root: &mut Value, normalized: bool) {
    property(root, "apiVersion", json!({"const": API_VERSION}));
    property(root, "kind", json!({"const": c::KIND}));
    let defs = root["$defs"].as_object_mut().unwrap();
    for variant in defs["Integration"]["oneOf"]
        .as_array_mut()
        .expect("tagged integration variants")
    {
        property(
            variant,
            "kind",
            json!({"description": "Integration implementation selected by this definition."}),
        );
    }
    for variant in defs["ServiceDefinition"]["oneOf"]
        .as_array_mut()
        .expect("tagged service variants")
    {
        property(
            variant,
            "kind",
            json!({"description": "Supported installer selected by this service definition."}),
        );
    }
    for name in ["Spec", "Sandbox", "Agent"] {
        property(
            &mut defs[name],
            "integrations",
            json!({"propertyNames": {"pattern": c::SLUG}}),
        );
    }
    for name in ["Spec", "Sandbox"] {
        for field in ["inferences", "harnesses", "inferenceProviders"] {
            property(
                &mut defs[name],
                field,
                json!({"propertyNames": {"pattern": c::SLUG}}),
            );
        }
        property(
            &mut defs[name],
            "inferenceProviders",
            json!({"x-nemoclaw-error": format!("inferenceProviders must map lowercase names ({}) to provider definitions", c::SLUG)}),
        );
    }
    property(
        &mut defs["Spec"],
        "services",
        json!({"propertyNames": {"pattern": c::SLUG}}),
    );
    property(
        &mut defs["Agent"],
        "inferenceRef",
        json!({"pattern": c::SLUG}),
    );
    defs["Agent"]["oneOf"] = json!([
        {"required": ["inference"], "not": {"required": ["inferenceRef"]}},
        {"required": ["inferenceRef"], "not": {"required": ["inference"]}}
    ]);
    property(
        &mut defs["Agent"],
        "integrationRefs",
        json!({"uniqueItems": true, "items": {"type": "string", "pattern": c::SLUG}}),
    );
    for name in ["Metadata", "InlineInferenceProvider", "Agent"] {
        property(
            defs.get_mut(name).unwrap(),
            "name",
            json!({"pattern": c::SLUG}),
        );
    }
    property(&mut defs["Metadata"], "uid", json!({"pattern": c::UUID}));
    for (name, kind) in [("SecretRef", "secret"), ("FileRef", "file")] {
        property(
            &mut defs[name],
            "env",
            json!({
                "pattern": c::ENV,
                "not": {"anyOf": [
                    {"const": "NEMOCLAW_KUBERNETES_STATE"},
                    {"pattern": "^(?:NEMOCLAW_MANAGED_K8S_|HELM_|KUBE_)"}
                ]},
                "x-nemoclaw-error": format!("{kind} reference must name a valid environment variable that does not shadow managed Kubernetes runtime controls")
            }),
        );
    }
    property(
        &mut defs["ManagedKubernetes"],
        "kubeconfig",
        json!({"properties": {"env": {
            "not": {"anyOf": [
                {"enum": [
                    "PATH", "HOME", "USERPROFILE", "KUBECONFIG", "TMPDIR", "TMP", "TEMP",
                    "SYSTEMROOT", "COMSPEC", "PATHEXT", "SHELL", "ENV", "BASH_ENV", "IFS", "CDPATH",
                    "SSL_CERT_FILE", "SSL_CERT_DIR", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE",
                    "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "KUBERNETES_MASTER",
                    "KUBERNETES_SERVICE_HOST", "KUBERNETES_SERVICE_PORT", "KUBERNETES_SERVICE_PORT_HTTPS"
                ]},
                {"pattern": "^(?:PYTHON|HELM|LD_|DYLD_|TF_|TOFU_|PLUGIN_|NEMOCLAW_INTERNAL_)"}
            ]},
            "x-nemoclaw-error": "kubeconfig environment reference must not shadow process, trust, proxy, or cluster controls"
        }}}),
    );
    // The listed variables reach OpenTofu beside its platform variables, so
    // they follow the kubeconfig reference's rules and cannot replace those.
    let reserved =
        defs["ManagedKubernetes"]["properties"]["kubeconfig"]["properties"]["env"]["not"].clone();
    property(
        &mut defs["ManagedKubernetes"],
        "environment",
        json!({
            "uniqueItems": true,
            "items": {
                "type": "string",
                "pattern": c::ENV,
                "not": {"anyOf": [
                    reserved,
                    {"const": "NEMOCLAW_KUBERNETES_STATE"},
                    {"pattern": "^(?:NEMOCLAW_MANAGED_K8S_|HELM_|KUBE_)"}
                ]}
            },
            "x-nemoclaw-error": "Kubernetes environment names must be unique variable names that do not shadow process, trust, proxy, or cluster controls"
        }),
    );
    property(
        &mut defs["Spec"],
        "sandboxes",
        json!({
            "propertyNames": {"pattern": c::SLUG}, "minProperties": 1, "maxProperties": 32,
            "x-nemoclaw-error": format!("spec.sandboxes must map 1 to 32 lowercase names ({}) to sandbox definitions", c::SLUG)
        }),
    );
    // Earlier documents listed named entries; the key now carries the name.
    defs["Sandbox"]["x-nemoclaw-removed-fields"] =
        json!({"name": "a sandbox's name is its key under spec.sandboxes"});
    defs["InferenceProvider"]["x-nemoclaw-removed-fields"] = json!({
        "name": "a provider's name is its key under inferenceProviders; only an inline route provider states name"
    });
    defs["Sandbox"]["allOf"] = json!([]);
    optional_string(
        &mut defs["Image"],
        "ref",
        DEFAULT_AGENT_IMAGE,
        &json!({"pattern": c::IMAGE}),
        normalized,
    );
    defs["Image"]["properties"]["ref"]
        .as_object_mut()
        .unwrap()
        .remove("default");
    defs["Image"]["properties"]["ref"]["x-nemoclaw-default-rule"] = json!(
        "A Kubernetes target requires an explicit immutable image reference. For Docker and Podman targets, omitted or empty selects the generic SDK agent image pin; verify that it contains the selected Fabric adapter."
    );
    optional_string(
        &mut defs["Network"],
        "tier",
        c::NETWORK_TIER,
        &json!({"const": c::NETWORK_TIER}),
        false,
    );
    property(
        &mut defs["Network"],
        "tier",
        json!({"x-nemoclaw-default-rule": "Omitted or empty selects isolated only without policy.explicit."}),
    );
    defs["Network"]["if"] = json!({"required": ["policy"]});
    defs["Network"]["then"] = json!({"properties": {"tier": {"const": ""}}});
    nemoclaw_openshell::policy::constrain(defs);
    property(
        &mut defs["Sandbox"],
        "harnessRef",
        json!({"pattern": c::SLUG}),
    );
    defs["Sandbox"]["allOf"]
        .as_array_mut()
        .unwrap()
        .push(json!({"oneOf": [
            {"required": ["harness"], "not": {"required": ["harnessRef"]}},
            {"required": ["harnessRef"], "not": {"required": ["harness"]}}
        ]}));
    let native_identifier =
        json!({"minLength":1,"maxLength":256,"pattern":"^[^\\u0000-\\u001f\\u007f]+$(?![\\s\\S])"});
    let allow = &mut defs["AgentTools"]["properties"]["allow"];
    allow["items"] = json!({"type":"string"});
    allow["items"]
        .as_object_mut()
        .unwrap()
        .extend(native_identifier.as_object().unwrap().clone());
    allow["uniqueItems"] = json!(true);

    property(&mut defs["Route"], "name", json!({"pattern": c::SLUG}));
    property(
        &mut defs["Inference"],
        "default",
        json!({"pattern": c::SLUG}),
    );
    property(
        &mut defs["Inference"],
        "routes",
        json!({"minItems":1,"maxItems":32}),
    );
    defs["Inference"]["if"] = json!({"properties":{"routes":{"minItems":2}},"required":["routes"]});
    defs["Inference"]["then"] = json!({"required":["default"]});
    defs["Route"]["oneOf"] = json!([
        {"required":["providerRef"],"not":{"required":["provider"]}},
        {"required":["provider"],"not":{"required":["providerRef"]}}
    ]);
    property(
        &mut defs["Route"],
        "providerRef",
        json!({"pattern": c::SLUG}),
    );
    property(
        &mut defs["Overrides"],
        "model",
        json!({"pattern": c::MODEL}),
    );

    constrain_gateway(defs, normalized);

    // An inline definition carries the keyed definition's fields beside its
    // name, so it takes the same rules.
    for name in ["InferenceProvider", "InlineInferenceProvider"] {
        let provider = &mut defs[name];
        property(provider, "serviceRef", json!({"pattern": c::SLUG}));
        provider["if"] = json!({"required": ["serviceRef"]});
        provider["then"] = json!({
            "properties": {"provider":{"const":"openai"},"endpoint": {"const": ""}}, "allOf": [forbid(&["credential"])],
            "x-nemoclaw-error": "serviceRef excludes endpoint and credential and selects provider openai"
        });
        provider["else"] = json!({"required": ["endpoint"], "properties": {"endpoint": {"pattern": "^https?://"}}});
        let mut plain = forbid(&["credential"]);
        plain["x-nemoclaw-error"] = json!("an http:// endpoint takes no credential");
        provider["allOf"] = json!([
            {"if": at("endpoint", json!({"pattern": "^http:"}), true), "then": plain},
            {"if": {"required":["api"]}, "then": {
                "if": at("api", json!({"const":"anthropic-messages"}), true),
                "then": at("provider", json!({"const":"anthropic"}), false),
                "else": at("provider", json!({"const":"openai"}), false)
            }}
        ]);
    }
    defs["AgentExecution"]["minProperties"] = json!(1);
    crate::services::constrain_schema(defs, normalized);

    // Cluster sandboxes need an explicit image, since no local engine supplies
    // a default; image metadata stands in for engine inspection only there.
    let cluster = at(
        "spec/gateway/target",
        json!({"required": ["kubernetes"]}),
        true,
    );
    let mut explicit = at(
        "spec/sandboxes/*/image",
        json!({"required": ["ref", "metadata"], "properties": {"ref": {"pattern": c::IMAGE}}}),
        true,
    );
    explicit["x-nemoclaw-error"] = json!(
        "a Kubernetes target requires each sandbox image.ref pinned by digest and image.metadata"
    );
    let mut inspected = at("spec/sandboxes/*/image", forbid(&["metadata"]), false);
    inspected["x-nemoclaw-error"] = json!(
        "image.metadata is available only for a spec.gateway.target.kubernetes gateway; Docker and Podman use engine image inspection"
    );
    root["allOf"] = json!([
        {"if": cluster.clone(), "then": explicit, "else": inspected},
        {
            "if": cluster,
            "then": {
                "allOf": [at("spec/services", json!({"maxProperties": 0}), false)],
                "x-nemoclaw-error": "a Kubernetes target requires external inference endpoints; managed services are not supported"
            }
        }
    ]);
    root["x-nemoclaw-parser-checks"] = json!([
        "Document::parse rejects YAML aliases, anchors, merge keys, all explicit tags (including core tags such as !!binary), duplicate keys, multiple documents, and input larger than 1 MiB. It applies the compiled input schema before defaulting; Document::validate applies the normalized schema and semantic checks, including for directly constructed Rust values.",
        "The parser checks endpoint transport and address policy, managed gateway port bounds, canonical private IPv4 /24 networks, local engine socket syntax, and publication address/port/network agreement.",
        "A managed Kubernetes target requires explicit kubeconfig environment, context, namespace, and development authentication profile; Agent Sandbox and one default StorageClass must already be installed. Its HTTPS endpoint is exactly 127.0.0.1 with an explicit port from 1 through 65535 and no path. A Kubernetes target, managed or external, excludes managed inference services. The openshift distribution uses the upstream Kubernetes driver and requires platform-owned OpenShift security prerequisites. Cluster identity, ownership, prerequisite compatibility, and credential files are checked during operations.",
        "Explicit sandbox policies are also checked by the pinned OpenShell policy parser and validator, including protocol-specific rule semantics, process identities, filesystem paths, and destination address restrictions.",
        "Explicit filesystem grants must permit reads of the packaged Fabric runtime and NemoClaw bridge directories; parent and read-write grants count. This parser check does not inspect images, resolve symlinks, or establish runtime permissions.",
        "The schema requires an explicit default for multiple model choices. Rust checks unique route names, that the default names a route, and that native model and tool fields have valid structural shapes. Fabric validates adapter-specific combinations.",
        "The parser resolves integrationRefs only from enclosing deployment or sandbox definitions, rejects name shadowing and missing agent references, and permits at most one attached web search definition per sandbox. Native search must be authored separately through public Fabric configuration and validated by Fabric. Agent-inline definitions attach directly; unused enclosing definitions grant no access.",
        "The schema requires exactly one sandbox harness or harnessRef and rejects agent-level harness selection. Rust resolves visible harnesses without shadowing. Each sandbox requires one agent and hosts one Fabric runtime using the sandbox-selected implementation. Shared definitions reuse configuration across sandboxes.",
        "Native reasoning-effort identifiers are preserved for Fabric validation. Managed inference services may constrain routes to their declared served model.",
        "Rust resolves inferenceRef from enclosing inferences, preserves declaration scope for nested provider references, and rejects missing names and shadowing. The schema rejects inline/reference ambiguity.",
        "The parser resolves providerRef from enclosing inferenceProviders, rejects shadowing, conflicting selected names, more than 32 selected providers, incompatible managed-service combinations, and compares route models and authentication with the selected provider. Provider transport and reference consistency are checked after reference resolution for both inline and shared definitions. Unselected definitions create no resources. Snapshot identity must match the service model.",
        "The parser checks memory threshold ordering and GPU/KV budget relationships; recipe path safety, byte-length limits, environment-map conflicts, snapshot file uniqueness, directory conflicts, and total-size overflow.",
        "Schema validation does not observe hardware, image labels, model weights, credentials, ownership, connectivity, or inference readiness. Those checks run during the relevant SDK operation."
    ]);
}

/// Gateway variants and their targets. Each target is its own definition, so
/// it states only its own defaults, required fields, and pull policies.
fn constrain_gateway(defs: &mut serde_json::Map<String, Value>, normalized: bool) {
    // Earlier documents named these fields directly on the gateway; a
    // diagnostic names the replacement instead of only rejecting the field.
    let runtime = "spec.gateway.runtime is replaced by the key under spec.gateway.target: docker, podman, or kubernetes";
    let engine = "spec.gateway.engine moved to spec.gateway.target.docker.engine or spec.gateway.target.podman.engine";
    for gateway in defs["Gateway"]["oneOf"]
        .as_array_mut()
        .expect("gateway variants")
    {
        property(
            gateway,
            "management",
            json!({"description": "Whether this deployment manages the gateway."}),
        );
        if normalized {
            gateway["required"]
                .as_array_mut()
                .unwrap()
                .push(json!("target"));
        }
        let managed = gateway["properties"]["management"]["const"] == "managed";
        if !normalized {
            let target = if managed {
                json!(super::super::ManagedTarget::default())
            } else {
                json!(super::super::ExternalTarget::default())
            };
            property(gateway, "target", json!({"default": target}));
        }
        if managed {
            gateway["x-nemoclaw-removed-fields"] = json!({
                "runtime": runtime,
                "endpoint": "spec.gateway.endpoint of a managed gateway moved to the endpoint of its spec.gateway.target key",
                "engine": engine,
                "image": "spec.gateway.image is removed because the SDK pins the gateway image",
                "imagePullPolicy": "spec.gateway.imagePullPolicy moved to spec.gateway.target.docker or spec.gateway.target.podman",
                "networkCIDR": "spec.gateway.networkCIDR moved to networkCidr under spec.gateway.target.docker or spec.gateway.target.podman",
                "kubernetes": "spec.gateway.kubernetes moved to spec.gateway.target.kubernetes"
            });
        } else {
            gateway["x-nemoclaw-removed-fields"] = json!({"runtime": runtime, "engine": engine});
            property(gateway, "endpoint", json!({"pattern": "^https?://"}));
            gateway["if"] = at("endpoint", json!({"pattern": "^http:"}), true);
            gateway["then"] = forbid(&["credential", "tls"]);
        }
    }
    // The generated reference describes each target key by its variant.
    for name in ["ManagedTarget", "ExternalTarget"] {
        for variant in defs[name]["oneOf"].as_array_mut().expect("target variants") {
            let key = variant["required"][0]
                .as_str()
                .expect("single-key target variant")
                .to_owned();
            let description = variant["description"].clone();
            property(variant, &key, json!({"description": description}));
        }
    }
    let endpoint = json!({"pattern": "^http://127\\.0\\.0\\.1:[0-9]+/?$"});
    let network = json!({"pattern": "/24$"});
    for (name, key) in [("ManagedDocker", "docker"), ("ManagedPodman", "podman")] {
        let target = &mut defs[name];
        optional_string(
            target,
            "endpoint",
            c::GATEWAY_ENDPOINT,
            &endpoint,
            normalized,
        );
        property(
            target,
            "endpoint",
            json!({"x-nemoclaw-error": "a Docker or Podman gateway endpoint is http://127.0.0.1:PORT with an unprivileged port"}),
        );
        optional_string(target, "networkCidr", "", &network, normalized);
        let cidr = target["properties"]["networkCidr"].as_object_mut().unwrap();
        cidr.remove("default");
        cidr.insert(
            "x-nemoclaw-default-rule".into(),
            json!("Omitted or empty selects 172.30.N.0/24, where N is the first byte of SHA-256(metadata.uid)."),
        );
        cidr.insert(
            "x-nemoclaw-error".into(),
            json!("networkCidr must be a canonical private IPv4 /24"),
        );
        property(
            target,
            "imagePullPolicy",
            json!({"default": super::super::ImagePullPolicy::default()}),
        );
        target["x-nemoclaw-removed-fields"] = json!({
            "image": format!("spec.gateway.target.{key} takes no image because the SDK pins the gateway image"),
            "networkCIDR": format!("spec.gateway.target.{key} spells networkCIDR as networkCidr")
        });
    }
    optional_string(
        &mut defs["ManagedDocker"],
        "engine",
        c::GATEWAY_ENGINE,
        &json!({"pattern": "^unix:///"}),
        normalized,
    );
    // Docker accepts two of the engine policies. Its own choices, rather than
    // the shared definition, let editors offer only those.
    let choices = defs["ImagePullPolicy"]["oneOf"]
        .as_array()
        .expect("pull policy choices")
        .iter()
        .filter(|choice| choice["const"] != "Always")
        .cloned()
        .collect::<Vec<_>>();
    let policy = defs["ManagedDocker"]["properties"]["imagePullPolicy"]
        .as_object_mut()
        .unwrap();
    policy.remove("$ref");
    policy.insert("oneOf".into(), json!(choices));
    property(
        &mut defs["ManagedPodman"],
        "engine",
        json!({
            "minLength": 1,
            "pattern": "^unix:///",
            "x-nemoclaw-error": "Podman requires spec.gateway.target.podman.engine to name its local API service socket"
        }),
    );
    property(
        &mut defs["ManagedKubernetes"],
        "endpoint",
        json!({
            "pattern": c::KUBERNETES_GATEWAY_ENDPOINT,
            "x-nemoclaw-error": "managed Kubernetes requires an explicit HTTPS 127.0.0.1 endpoint with a nonzero port and no path"
        }),
    );
    property(
        &mut defs["ManagedKubernetes"],
        "distribution",
        json!({"default": super::super::KubernetesDistribution::default()}),
    );
    // Declared, empty properties make an unknown field an additional property,
    // which the removed-field hint can name.
    let existing = &mut defs["ExternalKubernetes"];
    existing["properties"] = json!({});
    existing["x-nemoclaw-removed-fields"] = json!({
        "distribution": "distribution applies only to a managed gateway's spec.gateway.target.kubernetes; an existing gateway reports only the kubernetes driver"
    });
}
