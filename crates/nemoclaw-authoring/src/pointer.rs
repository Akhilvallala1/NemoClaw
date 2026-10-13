// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! JSON pointer segments, and the keys among them that name SDK definitions.

/// Escape `segment` for use as one JSON pointer segment.
pub(crate) fn escape(segment: &str) -> String {
    segment.replace('~', "~0").replace('/', "~1")
}

/// `pointer` with each segment that keys a named SDK definition replaced by
/// `replace(segment)`. These keys name sandboxes and the providers, services,
/// harnesses, inferences, and integrations of the deployment or of a sandbox;
/// they are names only by position, so a name can equal a field name. A
/// prefix before the pointer's first `/`, such as `form:`, is kept.
pub fn replace_entry_keys(pointer: &str, replace: impl Fn(&str) -> String) -> String {
    let mut parts = pointer.split('/').map(str::to_owned).collect::<Vec<_>>();
    for index in 1..parts.len() {
        let before = parts[1..index]
            .iter()
            .map(String::as_str)
            .collect::<Vec<_>>();
        if matches!(
            before.as_slice(),
            [
                "spec",
                "sandboxes"
                    | "inferenceProviders"
                    | "services"
                    | "harnesses"
                    | "inferences"
                    | "integrations"
            ] | [
                "spec",
                "sandboxes",
                _,
                "inferenceProviders" | "harnesses" | "inferences" | "integrations"
            ] | ["spec", "sandboxes", _, "agent", "integrations"]
        ) {
            parts[index] = replace(&parts[index]);
        }
    }
    parts.join("/")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_keys_in_named_definition_positions_are_replaced() {
        let star = |_: &str| "*".to_owned();
        for (pointer, expected) in [
            (
                "/spec/sandboxes/routes/agent/inference/routes/0/name",
                "/spec/sandboxes/*/agent/inference/routes/0/name",
            ),
            (
                "form:/spec/sandboxes/settings/agent",
                "form:/spec/sandboxes/*/agent",
            ),
            (
                "/spec/sandboxes/a/inferenceProviders/services/endpoint",
                "/spec/sandboxes/*/inferenceProviders/*/endpoint",
            ),
            (
                "/spec/sandboxes/a/agent/integrations/search/kind",
                "/spec/sandboxes/*/agent/integrations/*/kind",
            ),
            ("/spec/services/config/recipe", "/spec/services/*/recipe"),
            (
                "/spec/harnesses/execution/execution/timeoutSeconds",
                "/spec/harnesses/*/execution/timeoutSeconds",
            ),
            ("/spec/sandboxes", "/spec/sandboxes"),
            ("/spec/gateway/target/docker", "/spec/gateway/target/docker"),
            ("adapter:x:/services/port", "adapter:x:/services/port"),
        ] {
            assert_eq!(replace_entry_keys(pointer, star), expected, "{pointer}");
        }
    }
}
