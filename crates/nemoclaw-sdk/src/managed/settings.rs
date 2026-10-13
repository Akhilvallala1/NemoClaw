// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Runtime settings compiled from a managed gateway's authored target.
//!
//! Service specifications serialize these settings into retained resource
//! values and the labels that bind containers, so their layout stays fixed
//! when the authored configuration changes shape.

use crate::config::{
    ComputeDriver, ConfigError, DEFAULT_GATEWAY_IMAGE, FileRef, ImagePullPolicy,
    KubernetesAuthentication, KubernetesDistribution, LocalGateway, ManagedDocker, ManagedGateway,
    ManagedKubernetes, ManagedPodman, ManagedTarget,
};
use serde::{Deserialize, Serialize};

/// A managed gateway's runtime settings, with the SDK-pinned gateway image.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct GatewaySettings {
    pub runtime: GatewayRuntime,
    pub endpoint: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub engine: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub image: String,
    #[serde(
        rename = "imagePullPolicy",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub image_pull_policy: Option<ImagePullPolicy>,
    #[serde(rename = "networkCIDR", skip_serializing_if = "String::is_empty")]
    pub network_cidr: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kubernetes: Option<KubernetesSettings>,
}

/// The compute driver a managed gateway runs every sandbox with.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct GatewayRuntime {
    pub provider: ComputeDriver,
}

/// The cluster a managed Kubernetes gateway is installed in.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KubernetesSettings {
    pub kubeconfig: FileRef,
    pub context: String,
    pub namespace: String,
    pub authentication: KubernetesAuthentication,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub environment: Vec<String>,
}

impl ManagedGateway {
    /// Runtime settings for this gateway's target, with the pinned gateway
    /// image on a local engine. The acquisition policy is a mutable provider
    /// attribute rather than container identity, so it is left out.
    pub(crate) fn runtime_settings(&self) -> GatewaySettings {
        let ManagedTarget::Kubernetes(cluster) = &self.target else {
            return self
                .local()
                .expect("Docker and Podman targets run on a local engine")
                .runtime_settings();
        };
        GatewaySettings {
            runtime: GatewayRuntime {
                provider: match cluster.distribution {
                    KubernetesDistribution::Kubernetes => ComputeDriver::Kubernetes,
                    KubernetesDistribution::OpenShift => ComputeDriver::OpenShift,
                },
            },
            endpoint: cluster.endpoint.clone(),
            kubernetes: Some(KubernetesSettings {
                kubeconfig: cluster.kubeconfig.clone(),
                context: cluster.context.clone(),
                namespace: cluster.namespace.clone(),
                authentication: cluster.authentication.clone(),
                environment: cluster.environment.clone(),
            }),
            ..GatewaySettings::default()
        }
    }
}

impl LocalGateway<'_> {
    /// Runtime settings for this gateway, with the pinned gateway image and
    /// without the mutable acquisition policy.
    pub(crate) fn runtime_settings(&self) -> GatewaySettings {
        GatewaySettings {
            runtime: GatewayRuntime {
                provider: self.compute_driver,
            },
            endpoint: self.endpoint.into(),
            engine: self.engine.into(),
            image: DEFAULT_GATEWAY_IMAGE.into(),
            image_pull_policy: None,
            network_cidr: self.network_cidr.into(),
            kubernetes: None,
        }
    }
}

impl GatewaySettings {
    /// The authored gateway these settings were compiled from.
    ///
    /// # Errors
    /// Returns an error when the settings pair a cluster with a local engine
    /// driver or carry settings their target does not take.
    pub fn authored(&self) -> Result<ManagedGateway, ConfigError> {
        let provider = self.runtime.provider;
        let target = match (&self.kubernetes, provider) {
            (None, ComputeDriver::Docker) => ManagedTarget::Docker(ManagedDocker {
                endpoint: self.endpoint.clone(),
                engine: self.engine.clone(),
                image_pull_policy: self.image_pull_policy,
                network_cidr: self.network_cidr.clone(),
            }),
            (None, ComputeDriver::Podman) => ManagedTarget::Podman(ManagedPodman {
                endpoint: self.endpoint.clone(),
                engine: self.engine.clone(),
                image_pull_policy: self.image_pull_policy,
                network_cidr: self.network_cidr.clone(),
            }),
            (Some(cluster), ComputeDriver::Kubernetes | ComputeDriver::OpenShift)
                if self.engine.is_empty()
                    && self.image.is_empty()
                    && self.image_pull_policy.is_none()
                    && self.network_cidr.is_empty() =>
            {
                ManagedTarget::Kubernetes(ManagedKubernetes {
                    distribution: if provider == ComputeDriver::OpenShift {
                        KubernetesDistribution::OpenShift
                    } else {
                        KubernetesDistribution::Kubernetes
                    },
                    endpoint: self.endpoint.clone(),
                    kubeconfig: cluster.kubeconfig.clone(),
                    context: cluster.context.clone(),
                    namespace: cluster.namespace.clone(),
                    authentication: cluster.authentication.clone(),
                    environment: cluster.environment.clone(),
                })
            }
            _ => {
                return Err(ConfigError::new(
                    "managed gateway settings must pair a local engine with Docker or Podman, or a cluster with Kubernetes or OpenShift and no local engine settings",
                ));
            }
        };
        Ok(ManagedGateway { target })
    }

    /// Validate the settings as their authored gateway, with the pinned image
    /// on a local engine. The acquisition policy is excluded: the provider
    /// supplies it from mutable resource attributes and the engine checks it.
    ///
    /// # Errors
    /// Returns the authored gateway's validation error, or an error for an
    /// image other than the SDK pin.
    pub fn validate_managed(&self) -> Result<(), ConfigError> {
        let identity = Self {
            image_pull_policy: None,
            ..self.clone()
        };
        identity.authored()?.validate_managed()?;
        if self.kubernetes.is_none() && self.image != DEFAULT_GATEWAY_IMAGE {
            return Err(ConfigError::new(
                "managed gateway requires the SDK-pinned gateway image",
            ));
        }
        Ok(())
    }

    /// Resolve the first address after the configured network address.
    ///
    /// # Errors
    /// Returns an error for a Kubernetes gateway, a malformed IPv4 CIDR, or an
    /// address overflow.
    pub fn bridge(&self) -> Result<String, ConfigError> {
        if self.kubernetes.is_some() {
            return Err(ConfigError::new(
                "Kubernetes gateways have no local engine bridge",
            ));
        }
        crate::config::bridge_address(&self.network_cidr)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Document;

    fn spark() -> Document {
        Document::parse(include_bytes!("../../tests/fixtures/config/spark.yaml").as_slice())
            .unwrap()
    }

    /// Service specifications and their labels serialize these settings, so
    /// a local target compiles to the layout retained resources already bind.
    #[test]
    fn local_settings_keep_the_retained_layout_with_the_pinned_image() {
        let settings = spark().spec.gateway.managed().unwrap().runtime_settings();
        assert_eq!(
            serde_json::to_string(&settings).unwrap(),
            format!(
                r#"{{"runtime":{{"provider":"docker"}},"endpoint":"http://127.0.0.1:17681","engine":"unix:///var/run/docker.sock","image":"{DEFAULT_GATEWAY_IMAGE}","networkCIDR":"172.30.110.0/24"}}"#
            )
        );
        settings.validate_managed().unwrap();
        let other = GatewaySettings {
            image: "ghcr.io/nvidia/openshell/gateway@sha256:0000".into(),
            ..settings.clone()
        };
        assert!(other.validate_managed().is_err());
        // The provider applies the acquisition policy after compilation.
        let pulled = GatewaySettings {
            image_pull_policy: Some(ImagePullPolicy::Always),
            ..settings
        };
        pulled.validate_managed().unwrap();
    }

    #[test]
    fn cluster_settings_name_the_distribution_driver_and_no_local_engine() {
        let cluster = ManagedKubernetes {
            distribution: KubernetesDistribution::OpenShift,
            endpoint: "https://127.0.0.1:17671".into(),
            kubeconfig: FileRef {
                env: "CLUSTER_KUBECONFIG".into(),
            },
            context: "explicit".into(),
            namespace: "agents".into(),
            authentication: serde_json::from_value(serde_json::json!({"profile": "development"}))
                .unwrap(),
            environment: Vec::new(),
        };
        let gateway = ManagedGateway {
            target: ManagedTarget::Kubernetes(cluster),
        };
        let settings = gateway.runtime_settings();
        assert_eq!(settings.runtime.provider, ComputeDriver::OpenShift);
        assert!(settings.image.is_empty() && settings.engine.is_empty());
        settings.validate_managed().unwrap();
        assert_eq!(settings.authored().unwrap(), gateway);
        for changed in [
            GatewaySettings {
                runtime: GatewayRuntime {
                    provider: ComputeDriver::Docker,
                },
                ..settings.clone()
            },
            GatewaySettings {
                image: DEFAULT_GATEWAY_IMAGE.into(),
                ..settings.clone()
            },
            GatewaySettings {
                network_cidr: "172.30.1.0/24".into(),
                ..settings
            },
        ] {
            assert!(changed.validate_managed().is_err(), "{changed:?}");
        }
    }
}
