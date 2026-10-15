// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! `openshell_web_search`: one resource owning a web search provider's
//! OpenShell profile and registration. It delegates to the profile and
//! registration kinds, whose creation adopts an existing object with the same
//! identity, so a failure between the two recovers on the next apply.
use nemoclaw_backend::{Backend, Error, Mutation, ObservationError, Row};
use nemoclaw_openshell::search::{SearchProvider, web_search_names};

pub(crate) const KIND: &str = "web_search";

fn value<'a>(row: &'a Row, field: &str) -> &'a str {
    row.get(field).map(String::as_str).unwrap_or_default()
}

/// The profile and registration rows a web search row owns.
fn rows(row: &Row) -> Result<(Row, Row), ObservationError> {
    let provider =
        SearchProvider::from_name(value(row, "provider_type")).ok_or(ObservationError::Query)?;
    let (profile, registration) =
        web_search_names(provider, value(row, "credential_env"), value(row, "name"));
    let mut common = Row::new();
    for field in ["workspace", "owner", "generation"]
        .into_iter()
        .chain(nemoclaw_openshell::GATEWAY_FIELDS.map(|(_, field)| field))
    {
        if let Some(value) = row.get(field) {
            common.insert(field.into(), value.clone());
        }
    }
    let mut profile_row = common.clone();
    profile_row.extend([
        ("name".into(), profile.clone()),
        ("binaries_json".into(), value(row, "binaries_json").into()),
    ]);
    let mut registration_row = common;
    registration_row.extend([
        ("name".into(), registration),
        ("endpoint".into(), provider.endpoint().into()),
        ("credential_env".into(), value(row, "credential_env").into()),
        ("provider_type".into(), provider.name().into()),
        ("profile_name".into(), profile),
    ]);
    if let Some(id) = row.get("id").filter(|id| !id.is_empty()) {
        registration_row.insert("id".into(), id.clone());
    }
    Ok((profile_row, registration_row))
}

pub(crate) async fn plan(
    backend: &(impl Backend + ?Sized),
    desired: &Row,
    prior: Option<&Row>,
) -> Result<(), Error> {
    let (profile, registration) = rows(desired)?;
    let prior = prior.map(rows).transpose()?;
    backend
        .plan(
            "provider_profile",
            &profile,
            prior.as_ref().map(|(row, _)| row),
        )
        .await?;
    backend
        .plan(
            "provider",
            &registration,
            prior.as_ref().map(|(_, row)| row),
        )
        .await
}

pub(crate) async fn read(
    backend: &(impl Backend + ?Sized),
    prior: &Row,
    removing: bool,
) -> Result<Option<Row>, ObservationError> {
    let (profile, registration) = rows(prior)?;
    let profile = backend.read("provider_profile", &profile, removing).await?;
    let registration = backend.read("provider", &registration, removing).await?;
    match (profile, registration) {
        (Some(profile), Some(registration)) => {
            let mut observed = prior.clone();
            for (field, value) in [
                ("binaries_json", value(&profile, "binaries_json")),
                ("credential_env", value(&registration, "credential_env")),
                ("id", value(&registration, "id")),
            ] {
                observed.insert(field.into(), value.into());
            }
            Ok(Some(observed))
        }
        (None, None) => Ok(None),
        // Half of the pair exists: plan its creation, which adopts the other
        // half; while removing, report it so removal deletes what remains.
        _ if removing => Ok(Some(prior.clone())),
        _ => Ok(None),
    }
}

pub(crate) async fn ensure(backend: &(impl Backend + ?Sized), desired: &Row) -> Mutation {
    let (profile, registration) = match rows(desired) {
        Ok(rows) => rows,
        Err(error) => return Mutation::failed(error),
    };
    if let (_, Some(error)) = backend
        .ensure("provider_profile", &profile)
        .await
        .into_parts()
    {
        return Mutation::failed(error);
    }
    match backend.ensure("provider", &registration).await.into_parts() {
        (_, Some(error)) => Mutation::failed(error),
        (Some(established), None) => {
            let mut state = desired.clone();
            state.insert("id".into(), value(&established, "id").into());
            Mutation::complete(state)
        }
        (None, None) => Mutation::failed(ObservationError::Incomplete),
    }
}

pub(crate) async fn remove(
    backend: &(impl Backend + ?Sized),
    prior: &Row,
    destroying: bool,
) -> Result<(), ObservationError> {
    let (profile, registration) = rows(prior)?;
    // The API refuses to delete a profile a registration still imports.
    if backend
        .read("provider", &registration, true)
        .await?
        .is_some()
    {
        backend
            .remove("provider", &registration, destroying)
            .await?;
    }
    if backend
        .read("provider_profile", &profile, true)
        .await?
        .is_some()
    {
        backend
            .remove("provider_profile", &profile, destroying)
            .await?;
    }
    Ok(())
}
