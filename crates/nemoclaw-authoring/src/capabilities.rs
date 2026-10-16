// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use crate::fingerprint::sha256;
use nemoclaw_sdk::config::HarnessKind;

/// The harnesses an image catalog lists, for presenting authoring choices.
/// Harness settings have no schema here: Fabric validates them when the agent
/// is configured.
#[derive(Clone, Debug)]
pub struct Capabilities {
    harnesses: Vec<HarnessKind>,
    pub(crate) fabric_revision: Option<String>,
    pub(crate) catalog_sha256: Option<String>,
}

impl Capabilities {
    pub fn available() -> Self {
        Self::from_catalog(&nemoclaw_sdk::fabric_catalog::FabricCatalog::bundled())
    }

    pub fn from_catalog(catalog: &nemoclaw_sdk::fabric_catalog::FabricCatalog) -> Self {
        let mut capabilities = Self::from_harnesses(
            catalog
                .adapters
                .iter()
                .filter_map(|adapter| adapter.adapter_id().parse().ok()),
        );
        capabilities.fabric_revision = Some(catalog.fabric_revision.clone());
        let snapshot = serde_json::to_vec(catalog).expect("Fabric catalog serializes");
        capabilities.catalog_sha256 = Some(sha256(&snapshot));
        capabilities
    }

    pub fn from_harnesses(harnesses: impl IntoIterator<Item = HarnessKind>) -> Self {
        let mut harnesses: Vec<_> = harnesses.into_iter().collect();
        harnesses.sort_by(|a, b| a.as_str().cmp(b.as_str()));
        harnesses.dedup();
        Self {
            harnesses,
            fabric_revision: None,
            catalog_sha256: None,
        }
    }

    pub fn harnesses(&self) -> &[HarnessKind] {
        &self.harnesses
    }
}
