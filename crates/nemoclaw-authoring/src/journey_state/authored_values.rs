// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Primitive writes to sparse desired state. Compound journey decisions remain
//! transitions on JourneyState.

use super::*;

/// Sparse desired-state values and authoring-only memory for inactive branches.
#[derive(Clone, Debug)]
pub(super) struct AuthoredValues {
    pub(super) values: Value,
    pub(super) inactive_settings: BTreeMap<String, Value>,
    pub(super) generated_gateway_engine: bool,
}

impl AuthoredValues {
    pub(super) fn new(values: Value) -> Self {
        Self {
            values,
            inactive_settings: BTreeMap::new(),
            generated_gateway_engine: false,
        }
    }
}

impl AuthoredValues {
    pub(super) fn put_name(&mut self, value: Value) -> Result<(), Diagnostics> {
        let root = self
            .values
            .as_object_mut()
            .ok_or_else(|| diagnostic("journey", "The document root must be an object."))?;
        let metadata = root
            .entry("metadata")
            .or_insert_with(|| Value::Object(Map::new()));
        metadata
            .as_object_mut()
            .ok_or_else(|| diagnostic("journey", "Metadata must be an object."))?
            .insert("name".into(), value);
        Ok(())
    }

    /// Generate the deployment identity when the base omits it. A supplied
    /// identity is kept so editing an existing deployment preserves it.
    pub(super) fn ensure_uid(&mut self) -> Result<(), Diagnostics> {
        let root = self
            .values
            .as_object_mut()
            .ok_or_else(|| diagnostic("journey", "The document root must be an object."))?;
        let metadata = root
            .entry("metadata")
            .or_insert_with(|| Value::Object(Map::new()))
            .as_object_mut()
            .ok_or_else(|| diagnostic("journey", "Metadata must be an object."))?;
        if !metadata.contains_key("uid") {
            metadata.insert("uid".into(), Value::String(new_deployment_uid()?));
        }
        Ok(())
    }

    pub(super) fn put_harness(
        &mut self,
        position: &JourneyPosition,
        value: Value,
    ) -> Result<(), Diagnostics> {
        let next = value
            .as_str()
            .ok_or_else(|| diagnostic("journey", "Harness must be a string."))?
            .to_owned();
        let previous = harness_kind(&self.values).map(str::to_owned);
        if previous.as_deref() != Some(&next)
            && let Some(old) = &previous
            && let Some(settings) =
                settings_path(&self.values).and_then(|path| self.values.pointer(&path))
        {
            self.inactive_settings.insert(old.clone(), settings.clone());
        }
        let sandbox =
            sandbox_path(&self.values).ok_or_else(|| diagnostic("journey", ONE_SANDBOX))?;
        let inline = format!("{sandbox}/harness");
        let owner_path = harness_path(&self.values)
            .or_else(|| {
                position
                    .selected_forms
                    .get(&sandbox)
                    .filter(|form| *form == "harness")
                    .map(|_| inline.clone())
            })
            .ok_or_else(|| diagnostic("journey", "Harness is unavailable."))?;
        let harness = if owner_path == inline {
            self.values
                .pointer_mut(&sandbox)
                .and_then(Value::as_object_mut)
                .ok_or_else(|| diagnostic("journey", ONE_SANDBOX))?
                .entry("harness")
                .or_insert_with(|| Value::Object(Map::new()))
        } else {
            self.values
                .pointer_mut(&owner_path)
                .ok_or_else(|| diagnostic("journey", "Referenced harness is unavailable."))?
        };
        let harness = harness
            .as_object_mut()
            .ok_or_else(|| diagnostic("journey", "Harness must be an object."))?;
        if previous.as_deref() != Some(&next) {
            harness.remove("settings");
            if let Some(settings) = self.inactive_settings.get(&next) {
                harness.insert("settings".into(), settings.clone());
            }
        }
        harness.insert("kind".into(), Value::String(next));
        Ok(())
    }

    pub(super) fn put_setting(
        &mut self,
        pointer: &str,
        value: Option<Value>,
    ) -> Result<(), Diagnostics> {
        let harness = self
            .values
            .pointer_mut(
                &harness_path(&self.values)
                    .ok_or_else(|| diagnostic("journey", "Harness is unavailable."))?,
            )
            .and_then(Value::as_object_mut)
            .ok_or_else(|| diagnostic("journey", "Harness must be an object."))?;
        let settings = harness
            .entry("settings")
            .or_insert_with(|| Value::Object(Map::new()));
        crate::settings::put(settings, pointer, value)
    }

    pub(super) fn put_native_field(
        &mut self,
        owner: NativeSettingOwner,
        path: &str,
        value: Option<Value>,
    ) -> Result<(), Diagnostics> {
        let root = match owner {
            NativeSettingOwner::Workflow => harness_path(&self.values)
                .ok_or_else(|| diagnostic("journey", "Harness is unavailable."))?,
            NativeSettingOwner::Model(route) => format!(
                "{}/{}",
                routes_path(&self.values)
                    .ok_or_else(|| diagnostic("journey", "Inference routes are unavailable."))?,
                route
            ),
        };
        let owner_object = self
            .values
            .pointer_mut(&root)
            .and_then(Value::as_object_mut)
            .ok_or_else(|| diagnostic("journey", "The native setting owner is unavailable."))?;
        let settings = if owner == NativeSettingOwner::Workflow {
            owner_object
                .entry("config")
                .or_insert_with(|| Value::Object(Map::new()))
                .as_object_mut()
                .ok_or_else(|| diagnostic("journey", "Harness config must be an object."))?
                .entry("workflow")
                .or_insert_with(|| Value::Object(Map::new()))
        } else {
            owner_object
                .entry("overrides")
                .or_insert_with(|| Value::Object(Map::new()))
                .as_object_mut()
                .ok_or_else(|| diagnostic("journey", "Route overrides must be an object."))?
                .entry("settings")
                .or_insert_with(|| Value::Object(Map::new()))
        };
        crate::settings::put(settings, path, value)
    }

    pub(super) fn put_sdk_field(
        &mut self,
        pointer: &str,
        value: Option<Value>,
    ) -> Result<(), Diagnostics> {
        let (parent, property) = pointer
            .rsplit_once('/')
            .ok_or_else(|| diagnostic("journey", "Invalid SDK field path."))?;
        let property = unescape(property);
        if value.is_none() && self.values.pointer(parent).is_none() {
            return Ok(());
        }
        // The journey edits its one sandbox; a write never adds another.
        let sandbox = entry_key(pointer, "/spec/sandboxes");
        if value.is_some()
            && let Some(key) = sandbox
            && self
                .values
                .pointer(&format!("/spec/sandboxes/{key}"))
                .is_none()
        {
            return Err(diagnostic(
                "journey",
                "The v1 journey cannot add a sandbox.",
            ));
        }
        let mut current = &mut self.values;
        for segment in parent.split('/').skip(1) {
            let key = unescape(segment);
            current = match current {
                Value::Array(items) => {
                    let index = key
                        .parse::<usize>()
                        .map_err(|_| diagnostic("journey", "Invalid SDK array index."))?;
                    items
                        .get_mut(index)
                        .ok_or_else(|| diagnostic("journey", "SDK array index is unavailable."))?
                }
                Value::Object(object) => object
                    .entry(key)
                    .or_insert_with(|| Value::Object(Map::new())),
                _ => {
                    return Err(diagnostic(
                        "journey",
                        "The SDK field's parent is not an object.",
                    ));
                }
            };
        }
        let object = current
            .as_object_mut()
            .ok_or_else(|| diagnostic("journey", "The SDK field's parent is not an object."))?;
        if let Some(value) = value {
            object.insert(property, value);
        } else {
            object.remove(&property);
        }
        Ok(())
    }

    /// Remove sibling fields that the SDK schema defined before a write but no
    /// longer defines, such as fields of the previous gateway form. Objects
    /// that both forms define lose the nested fields only the previous one did,
    /// such as a managed target's network under an external gateway.
    pub(super) fn remove_inactive_siblings(&mut self, pointer: &str, before: &Value) {
        let Some((parent, _)) = pointer.rsplit_once('/') else {
            return;
        };
        self.remove_inactive_fields(parent, pointer, before, 0);
    }

    fn remove_inactive_fields(
        &mut self,
        parent: &str,
        written: &str,
        before: &Value,
        depth: usize,
    ) {
        let Some(fields) = self.values.pointer(parent).and_then(Value::as_object) else {
            return;
        };
        let mut inactive = Vec::new();
        let mut active_objects = Vec::new();
        for (key, value) in fields {
            let field = format!("{parent}/{}", escape(key));
            if field == written || sdk_field_schema_for(before, &field).is_none() {
                continue;
            }
            if sdk_field_schema_for(&self.values, &field).is_none() {
                inactive.push(key.clone());
            } else if value.is_object() && depth < 16 {
                active_objects.push(field);
            }
        }
        if let Some(fields) = self
            .values
            .pointer_mut(parent)
            .and_then(Value::as_object_mut)
        {
            for key in inactive {
                fields.remove(&key);
            }
        }
        for object in active_objects {
            self.remove_inactive_fields(&object, written, before, depth + 1);
        }
    }

    /// Select `key` of the externally tagged union at `pointer`, or omit the
    /// union. Settings of the previous key carry over when the new key's
    /// schema defines and accepts them, such as the engine field both targets
    /// define.
    pub(super) fn put_variant_key(
        &mut self,
        pointer: &str,
        key: Option<&str>,
    ) -> Result<(), Diagnostics> {
        let Some(key) = key else {
            return self.put_sdk_field(pointer, None);
        };
        let previous = self
            .values
            .pointer(pointer)
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        if previous.len() == 1 && previous.get(key).is_some_and(Value::is_object) {
            return Ok(());
        }
        let settings = previous
            .get(key)
            .or_else(|| {
                (previous.len() == 1)
                    .then(|| previous.values().next())
                    .flatten()
            })
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        self.put_sdk_field(pointer, Some(serde_json::json!({ key: {} })))?;
        let selected = format!("{pointer}/{}", escape(key));
        let carried = settings
            .into_iter()
            .filter(|(name, value)| {
                sdk_field_schema_for(&self.values, &format!("{selected}/{}", escape(name)))
                    .is_some_and(|(schema, _)| schema_accepts(&schema, value) == Some(true))
            })
            .collect::<Map<_, _>>();
        self.put_sdk_field(&selected, Some(Value::Object(carried)))
    }

    /// Point a managed gateway's target at the local engine that answered for
    /// it. Without one, a generated engine is withdrawn rather than left
    /// pointing at another target's engine.
    pub(super) fn sync_gateway_engine_for_target(
        &mut self,
        answered_engines: &[DiscoveryRequest],
    ) -> Result<(), Diagnostics> {
        let Some((target, path)) = managed_target_engine(&self.values) else {
            return Ok(());
        };
        if self.values.pointer(&path).is_some() && !self.generated_gateway_engine {
            return Ok(());
        }
        let engine = answered_engines
            .iter()
            .find(|request| request.compute_driver.as_str() == target)
            .map(|request| Value::String(request.engine.clone()));
        if engine.is_none() && !self.generated_gateway_engine {
            return Ok(());
        }
        self.generated_gateway_engine = engine.is_some();
        self.put_sdk_field(&path, engine)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn an_sdk_field_write_never_adds_a_sandbox() {
        let original = json!({"spec": {"sandboxes": {"assistant": {"agent": {}}}}});
        let mut authored = AuthoredValues::new(original.clone());
        for pointer in ["/spec/sandboxes/other/agent/name", "/spec/sandboxes/other"] {
            let error = authored
                .put_sdk_field(pointer, Some(json!("main")))
                .unwrap_err()
                .to_string();
            assert_eq!(error, "journey: The v1 journey cannot add a sandbox.");
            assert_eq!(authored.values, original);
        }
        authored
            .put_sdk_field("/spec/sandboxes/assistant/agent/name", Some(json!("main")))
            .unwrap();
        assert_eq!(
            authored.values,
            json!({"spec": {"sandboxes": {"assistant": {"agent": {"name": "main"}}}}})
        );
    }
}
