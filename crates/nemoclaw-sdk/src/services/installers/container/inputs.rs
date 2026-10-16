// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Nonsecret inputs of `protected_files`. Application connection settings are
//! ordinary environment values, not a special resource or descriptor.
use crate::{
    Error,
    backend::Row,
    config::{ConfigError, validation::require},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

pub const FILES_KIND: &str = "protected_files";
pub const ROOT: &str = "/run/nemoclaw";
pub const MARKER: &str = ".complete";
pub const FIELDS: &[&str] = &[
    "engine",
    "name",
    "owner",
    "generation",
    "image",
    "user",
    "credentials_json",
];

pub fn credential_file(name: &str) -> String {
    format!("secrets/{name}")
}

pub fn structured_inputs() -> Vec<nemoclaw_tofu::Structured> {
    vec![nemoclaw_tofu::Structured {
        attribute: "credentials",
        field: "credentials_json",
        shape: nemoclaw_tofu::shape::Shape::Map(Box::new(nemoclaw_tofu::shape::Shape::String)),
    }]
}

/// Only environment references are retained. Values are resolved by the provider.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Files {
    pub engine: String,
    pub name: String,
    pub owner: String,
    pub generation: String,
    pub image: String,
    pub user: String,
    pub credentials: BTreeMap<String, String>,
}
impl Files {
    pub fn from_row(row: &Row) -> Result<Self, Error> {
        let text = |field: &str| row.get(field).cloned().unwrap_or_default();
        Ok(Self {
            engine: text("engine"),
            name: text("name"),
            owner: text("owner"),
            generation: text("generation"),
            image: text("image"),
            user: text("user"),
            credentials: serde_json::from_str(&text("credentials_json"))
                .map_err(|_| Error::State("invalid protected credential references"))?,
        })
    }
    pub fn row(&self) -> Row {
        [
            ("engine", self.engine.clone()),
            ("name", self.name.clone()),
            ("owner", self.owner.clone()),
            ("generation", self.generation.clone()),
            ("image", self.image.clone()),
            ("user", self.user.clone()),
            (
                "credentials_json",
                serde_json::to_string(&self.credentials).expect("nonsecret references"),
            ),
        ]
        .map(|(name, value)| (name.into(), value))
        .into()
    }
    pub fn validate(&self) -> Result<(), ConfigError> {
        let storage = crate::managed::Storage {
            name: self.helper_name(),
            engine: self.engine.clone(),
            owner: self.owner.clone(),
            generation: self.generation.clone(),
        };
        require(
            storage.validate().is_ok() && self.engine.starts_with("unix:///"),
            "protected files require owned local Docker storage",
        )?;
        let matches = |pattern: &str, value: &str| {
            !value.contains(['\0', '\r', '\n'])
                && regex::Regex::new(pattern).unwrap().is_match(value)
        };
        require(
            matches(crate::config::constraints::IMAGE, &self.image)
                && matches(crate::config::constraints::APPLICATION_USER, &self.user),
            "protected files require a pinned image and numeric UID:GID",
        )?;
        require(
            !self.credentials.is_empty()
                && self.credentials.iter().all(|(name, env)| {
                    matches(crate::config::constraints::SLUG, name)
                        && matches(crate::config::constraints::ENV, env)
                }),
            "protected files require valid credential names and environment references",
        )
    }
    pub fn helper_name(&self) -> String {
        format!("{}-inputs", self.name)
    }
    /// Public input intent only: never the credential values or their hashes.
    pub fn revision(&self) -> String {
        Sha256::digest(
            serde_json::to_vec(&(&self.owner, &self.user, &self.credentials))
                .expect("nonsecret references"),
        )
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
    }
}
