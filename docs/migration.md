<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Assess Migration from an Earlier Version

The desired-state SDK, schema, and state format do not promise compatibility with the earlier product.
The current CLI has no general state adoption or migration command.
Keep the earlier deployment's tooling, configuration, and state while evaluating a separate v1 deployment.

There is no rehearsed upgrade, native-data transfer or rollback procedure yet ([#12639](https://github.com/NVIDIA/NemoClaw/issues/12639)).
The evaluation steps below create a separate deployment; they do not provide an in-place upgrade or data conversion.

To move a v1 document from `nemoclaw.nvidia.com/v1alpha1` to `nemoclaw.nvidia.com/v1alpha2`, [re-author it](#re-author-a-v1alpha1-document).

## Map the User Task

| Earlier task | Current destination |
|---|---|
| Install with npm | Build the native bundle from source; releases are tracked in [#12638](https://github.com/NVIDIA/NemoClaw/issues/12638) |
| Interactive onboarding and agent-specific aliases | `nemoclaw onboard` writes deployment YAML for the one `nemoclaw` CLI; see [get started](get-started.md) |
| `launch`, `status`, `doctor`, `backup-all`, or `rebuild` | No equivalent commands; the [CLI reference](reference/cli.md) lists the current ones |
| Imperative inference or sandbox changes | [Desired-state lifecycle](usage.md), with explicit update/replacement limits |
| Export configuration (`config export`) | `nemoclaw export`; see [CLI reference](reference/cli.md) and [state](state.md) |
| Configure agents, dashboards, tools, or heartbeats | [Agent runtimes](agents.md) and [interfaces](interfaces.md) |
| Integrate the TypeScript lifecycle package | [Rust SDK](sdk.md); no compatible TypeScript package is provided |
| Install policy presets, approve network requests interactively, or explain policy to an agent | Declare the [isolated preset or an explicit policy](sandbox-network.md#choose-a-policy); managed approval and explanation: [#12651](https://github.com/NVIDIA/NemoClaw/issues/12651) |
| Use Okta/Entra runtime identity and OAuth refresh | [#12652](https://github.com/NVIDIA/NemoClaw/issues/12652); provider authentication references do not replace it |
| Snapshot, restore, upload/download, or transfer history | No v1 equivalent yet ([#12639](https://github.com/NVIDIA/NemoClaw/issues/12639)); see [agent-data preservation](state.md#configuration-export-and-agent-data) |
| Manage messaging, MCP servers, or arbitrary plugins | Messaging: [#12037](https://github.com/NVIDIA/NemoClaw/issues/12037); MCP servers: [#12137](https://github.com/NVIDIA/NemoClaw/issues/12137); see [additional agent integrations](agents.md#additional-agent-integrations) |
| Provision a model router, managed NIM/llama.cpp, or distributed inference | Model Router and llama.cpp: [#12035](https://github.com/NVIDIA/NemoClaw/issues/12035); distributed inference: [#12641](https://github.com/NVIDIA/NemoClaw/issues/12641); managed NIM: [#12649](https://github.com/NVIDIA/NemoClaw/issues/12649) |
| Install a telemetry collector or reuse Deep Agents trace-export setup | [#12144](https://github.com/NVIDIA/NemoClaw/issues/12144); [OpenClaw tracing](agents.md#openclaw-tracing) selects an existing collector |

## Keep Deployment Identities Separate

Use a fresh deployment UUID, separate state directory, and resource names/endpoints that do not collide with the earlier deployment.
Copying YAML does not migrate native settings or conversations, and reusing names does not transfer ownership.
Use the [current schema](reference/configuration.md) and images built for the selected features.

The [validator](../crates/nemoclaw-sdk/src/config/validation.rs) rejects unsupported combinations, and [state validation](../crates/nemoclaw-sdk/src/state/mod.rs) rejects incompatible retained intent.
These checks are not a conversion mechanism.

## Evaluate v1 Beside the Existing Deployment

1. Record the earlier deployment's version, tooling, configuration, state, endpoints, and native data you need to retain.
   Use that version's documentation and tools to inspect it.
2. Check the task mapping above for workflows you rely on.
   If a workflow you need is in [current limits](limits.md), keep the earlier deployment available rather than assuming feature parity.
3. Build a separate matched v1 bundle and images, then prepare a fresh UUID and dedicated state directory using [the first-deployment guide](get-started.md).
   Check names, exposed ports, model capacity, and credentials so the evaluation does not overwrite or exhaust the original deployment's resources.
4. Plan and apply only the new v1 configuration/state.
   Verify the native interface and an actual agent reply, then check configuration export and [unchanged reapply](usage.md#verify-an-unchanged-reapply).
5. Validate each required task in the new deployment before switching use to it.
   An agent reply alone does not validate tools, channels, history continuity, or workload quality.
6. If evaluation fails, continue using the retained earlier deployment and diagnose v1 with its own bundle and state.
   Preview any v1 teardown separately and retain data needed for investigation before destroying its sandbox.

Continuing to use an untouched earlier deployment is not a rollback of data written in v1.
Transferring those changes back to the earlier runtime is tracked in [#12639](https://github.com/NVIDIA/NemoClaw/issues/12639).
Do not retire the old deployment when the required native-data backup, transfer, or return path is unverified.

## Preserve Data before Retirement

Export is a configuration operation; it does not back up agent files or history.
**Destroy deletes sandbox files and conversation history.**
Read [state and retention](state.md) before retiring either deployment.

Backup and restore of native agent data are tracked in [#12639](https://github.com/NVIDIA/NemoClaw/issues/12639).
Retain the earlier deployment until the required continuity has been verified.

## Re-Author a v1alpha1 Document

This NemoClaw reads `apiVersion: nemoclaw.nvidia.com/v1alpha2`.
Earlier v1 revisions wrote `nemoclaw.nvidia.com/v1alpha1`, which places the gateway settings and names sandboxes and inference providers differently.
This NemoClaw rejects that document, and state written by an earlier NemoClaw, without changing any resource:

| Input | Error |
|---|---|
| A v1alpha1 document given to `plan` or `apply` | `configuration uses nemoclaw.nvidia.com/v1alpha1; this NemoClaw reads nemoclaw.nvidia.com/v1alpha2; re-author it as described in docs/migration.md` |
| A state directory written by an earlier NemoClaw, with any command that reads it | `deployment state was written by an earlier NemoClaw for nemoclaw.nvidia.com/v1alpha1; retain it and use that NemoClaw to destroy it, or deploy this document as a separate deployment; see docs/migration.md` |

There is no conversion command, and this NemoClaw cannot adopt the earlier deployment's resources.
Re-author the document by hand and apply it as a separate deployment.
Agent files and conversation history are not transferred ([#12639](https://github.com/NVIDIA/NemoClaw/issues/12639)).

### Keep the Earlier Document

Keep the earlier bundle and its state directory; this NemoClaw cannot export or destroy that deployment.
Keep the v1alpha1 YAML you applied; it is the source for re-authoring and keeps its comments.
If you no longer have it, export it with the earlier bundle's CLI:

```sh
/path/to/earlier-bundle/bin/nemoclaw export --state-dir .local/deployment --output v1alpha1.yaml
```

Export observes the running deployment and fails when its resources are unavailable or differ from the retained intent.
Check its exit status before using the file.

### Rewrite the Fields

Copy the document and make these changes:

1. Set `apiVersion: nemoclaw.nvidia.com/v1alpha2`.
2. Set `metadata.uid` to a fresh lowercase UUID, for example from `uuidgen | tr '[:upper:]' '[:lower:]'`.
   A reused UID selects the earlier deployment's resource names.
3. Change a `# yaml-language-server: $schema=` comment to `nemoclaw-v1alpha2.schema.json`.
4. Move each field that v1alpha2 changed:

| v1alpha1 field | v1alpha2 field |
|---|---|
| Managed `spec.gateway.runtime.provider`: `docker`, `podman`, or `kubernetes`; omitted means `docker` | The one key under `spec.gateway.target`; omitted `target` means `docker` |
| Managed `spec.gateway.runtime.provider: openshift` | `spec.gateway.target.kubernetes.distribution: openshift` |
| Managed `spec.gateway.endpoint` | `spec.gateway.target.<key>.endpoint`; required under `kubernetes` |
| Managed `spec.gateway.engine` and `spec.gateway.imagePullPolicy` | The same names under `spec.gateway.target.docker` or `spec.gateway.target.podman` |
| Managed `spec.gateway.networkCIDR` | `networkCidr` under `spec.gateway.target.docker` or `spec.gateway.target.podman` |
| `spec.gateway.kubernetes`: `kubeconfig`, `context`, `namespace`, `authentication`, and `environment` | The same names under `spec.gateway.target.kubernetes` |
| `spec.gateway.image` | Removed; delete it, because the SDK pins the gateway image |
| External `spec.gateway.runtime.provider: docker` or `podman`, with `spec.gateway.engine` | `spec.gateway.target.docker.engine` or `spec.gateway.target.podman.engine`; `engine` stays optional |
| External `spec.gateway.runtime.provider: kubernetes` or `openshift` | `spec.gateway.target.kubernetes: {}` |
| External `spec.gateway.endpoint`, `credential`, and `tls` | Unchanged |
| `spec.sandboxes` list entries, each with `name` | A map from each sandbox name to its settings, without `name` |
| `spec.inferenceProviders` and a sandbox's `inferenceProviders` list entries, each with `name` | Maps from each provider name to its settings, without `name` |
| An inline route provider, `routes[].provider`, with `name` | Unchanged; `name` stays required |
| Credential references, `{env: NAME}` | Unchanged |

Names keep their earlier rules, and a deployment holds 1 to 32 sandboxes.
Map order has no meaning.

For example, this v1alpha1 excerpt:

```yaml
spec:
  gateway:
    management: managed
    runtime:
      provider: docker
    endpoint: http://127.0.0.1:17671
    networkCIDR: 172.20.0.0/24
  inferenceProviders:
    - name: local
      provider: openai
      endpoint: http://172.20.0.1:11434/v1
  sandboxes:
    - name: assistant
      harness:
        kind: nvidia.fabric.openclaw
```

becomes:

```yaml
spec:
  gateway:
    management: managed
    target:
      docker:
        # A separate deployment needs an endpoint and network that the
        # earlier deployment does not use.
        endpoint: http://127.0.0.1:17681
        networkCidr: 172.20.1.0/24
  inferenceProviders:
    local:
      provider: openai
      endpoint: http://172.20.0.1:11434/v1
  sandboxes:
    assistant:
      harness:
        kind: nvidia.fabric.openclaw
```

Plan the result with the new deployment's state directory.
A field left at its v1alpha1 location fails with a message that names its replacement, for example:

```text
configuration violates schema at spec.gateway (line 8, column 5): spec.gateway.runtime is replaced by the key under spec.gateway.target: docker, podman, or kubernetes; spec.gateway.endpoint of a managed gateway moved to the endpoint of its spec.gateway.target key; spec.gateway.networkCIDR moved to networkCidr under spec.gateway.target.docker or spec.gateway.target.podman
```

Each run reports one location; correct it and plan again until the document parses.
The [configuration reference](reference/configuration.md) lists every v1alpha2 field.
To start over instead, `nemoclaw onboard` writes a v1alpha2 document with a fresh UID.

### Deploy the Re-Authored Document

Choose what happens to the earlier deployment:

- **Destroy it with the earlier NemoClaw.**
  Run `/path/to/earlier-bundle/bin/nemoclaw plan --destroy --state-dir .local/deployment`, review the preview, then run the same CLI's `destroy` with that state directory.
  **Destroy deletes sandbox files and conversation history.**
  The storage it retains, and how to remove that storage, follow the earlier revision's documentation.
- **Keep it.**
  Keep its bundle and state directory to operate it.

Then apply the re-authored document as a separate deployment, as in [Keep Deployment Identities Separate](#keep-deployment-identities-separate):

- Use its fresh `metadata.uid` and a new state directory.
- Give the gateway an endpoint, `networkCidr`, and Kubernetes namespace that the earlier deployment does not use; destroy retains the earlier gateway network and namespace.
- Plan and apply with this NemoClaw.

## Find Earlier Documentation

The [combined staging site](https://nvidia-preview-nemoclaw-v1.docs.buildwithfern.com/nemoclaw/v1/overview) has a version selector:

- **v1 (Development)** describes the desired-state product.
- **Latest (main)** preserves the imported main guides and their release history; start at its [OpenClaw home](https://nvidia-preview-nemoclaw-v1.docs.buildwithfern.com/nemoclaw/user-guide/openclaw/home).

The main snapshot is pinned by the [documentation build](contributing/documentation-build.md#sources-and-outputs); its label does not qualify those procedures for v1.
Use the earlier deployment's actual version when selecting commands or assessing historical qualification.
Publishing the combined site and checking its legacy routes are tracked in [#12644](https://github.com/NVIDIA/NemoClaw/issues/12644).
