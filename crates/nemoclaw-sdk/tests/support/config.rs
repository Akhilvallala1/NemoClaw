// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Configuration inputs shared by the SDK integration tests.

use serde_json::Value;
use std::path::Path;

/// A maintained example, relative to the repository's `examples/` directory.
pub fn example(name: &str) -> Value {
    load(
        &Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../examples")
            .join(name),
    )
}

/// A test fixture, relative to `tests/fixtures/config/`.
pub fn fixture(name: &str) -> Value {
    load(
        &Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/config")
            .join(name),
    )
}

/// Document text that authors each map at `pointers` in reverse key order, so
/// a test can show that the order of named entries carries no intent.
pub fn reversed(value: &Value, pointers: &[&str]) -> String {
    let mut text = value.to_string();
    for pointer in pointers {
        let map = value.pointer(pointer).unwrap();
        let entries = map.as_object().unwrap();
        assert!(entries.len() > 1, "{pointer} has nothing to reorder");
        let authored = map.to_string();
        assert_eq!(text.matches(&authored).count(), 1, "{pointer} is ambiguous");
        let reversed: Vec<_> = entries
            .iter()
            .rev()
            .map(|(key, entry)| format!("{}:{entry}", Value::from(key.as_str())))
            .collect();
        text = text.replace(&authored, &format!("{{{}}}", reversed.join(",")));
    }
    text
}

fn load(path: &Path) -> Value {
    let text =
        std::fs::read_to_string(path).unwrap_or_else(|error| panic!("{}: {error}", path.display()));
    serde_saphyr::from_str(&text).unwrap_or_else(|error| panic!("{}: {error}", path.display()))
}
