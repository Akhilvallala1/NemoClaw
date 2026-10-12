// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Image observations need platform and startup contracts, not process identity.
use crate::{
    Error,
    config::{constraints, validate_engine_endpoint},
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ImageRequirements {
    pub engine: String,
    pub image: String,
    pub architecture: String,
    pub contract: ImageContract,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub enum ImageContract {
    Runtime { labels: BTreeMap<String, String> },
    Application,
    Inputs,
}
impl ImageRequirements {
    pub fn from_spec(spec: &super::Spec) -> Result<Self, Error> {
        spec.validate_runtime()?;
        let process = spec
            .process
            .as_ref()
            .ok_or(Error::State("missing runtime process"))?;
        let contract = match spec.kind.as_str() {
            "container_service" => ImageContract::Application,
            "inference_service" | "ollama_service" => ImageContract::Runtime {
                labels: process.image_labels.clone(),
            },
            _ => return Err(Error::State("unsupported image contract")),
        };
        Ok(Self {
            engine: spec.engine().into(),
            image: process.image.clone(),
            architecture: process.architecture.clone(),
            contract,
        })
    }
    pub fn validate(&self) -> Result<(), Error> {
        validate_engine_endpoint(&self.engine)?;
        if (matches!(
            self.contract,
            ImageContract::Application | ImageContract::Inputs
        ) && !self.engine.starts_with("unix:///"))
            || !regex::Regex::new(constraints::IMAGE)
                .unwrap()
                .is_match(&self.image)
            || self.image.contains(['\0', '\r', '\n'])
            || !matches!(self.architecture.as_str(), "arm64" | "amd64")
        {
            return Err(Error::State("invalid runtime image requirements"));
        }
        Ok(())
    }
    pub fn json(&self) -> Result<String, Error> {
        self.validate()?;
        serde_json::to_string(self).map_err(|_| Error::State("invalid runtime image requirements"))
    }
}
