// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! JSON pointer segments, and the keys among them that name SDK definitions.

use nemoclaw_sdk::config::schema::entry_key_shown;

/// Escape `segment` for use as one JSON pointer segment.
pub(crate) fn escape(segment: &str) -> String {
    segment.replace('~', "~0").replace('/', "~1")
}

/// The text of one escaped JSON pointer segment.
pub(crate) fn unescape(segment: &str) -> String {
    segment.replace("~1", "/").replace("~0", "~")
}

/// The escaped key of the entry of `collection`, a pointer such as
/// `/spec/sandboxes`, that `pointer` addresses or lies inside.
pub(crate) fn entry_key<'a>(pointer: &'a str, collection: &str) -> Option<&'a str> {
    let rest = pointer.strip_prefix(collection)?.strip_prefix('/')?;
    Some(rest.split_once('/').map_or(rest, |(key, _)| key))
}

/// [`replace_entry_keys`], also telling `replace` whether SDK diagnostics
/// show the key.
fn map_entry_keys(pointer: &str, replace: impl Fn(&str, bool) -> String) -> String {
    let parts = pointer.split('/').collect::<Vec<_>>();
    let names = parts.iter().map(|part| unescape(part)).collect::<Vec<_>>();
    let names = names.iter().map(String::as_str).collect::<Vec<_>>();
    let mut mapped = vec![parts[0].to_owned()];
    for index in 1..parts.len() {
        mapped.push(match entry_key_shown(&names[1..index], names[index]) {
            Some(shown) => replace(parts[index], shown),
            None => parts[index].to_owned(),
        });
    }
    mapped.join("/")
}

/// `pointer` with each segment that keys a named SDK definition replaced by
/// `replace(segment)`. These keys name sandboxes and the providers, services,
/// harnesses, inferences, and integrations of the deployment or of a sandbox;
/// they are names only by position, so a name can equal a field name. A
/// prefix before the pointer's first `/`, such as `form:`, is kept.
#[doc(hidden)]
pub fn replace_entry_keys(pointer: &str, replace: impl Fn(&str) -> String) -> String {
    map_entry_keys(pointer, |key, _| replace(key))
}

/// `pointer` for display, with each definition key that SDK diagnostics hide
/// read as `[entry]`, so rejected input is never shown. A sandbox, provider,
/// service, or other definition key is shown only when it, and the key of any
/// sandbox enclosing it, is a valid name.
pub fn mask_entry_keys(pointer: &str) -> String {
    map_entry_keys(pointer, |key, shown| {
        if shown { key } else { "[entry]" }.to_owned()
    })
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

    #[test]
    fn masking_hides_the_definition_keys_that_sdk_diagnostics_hide() {
        for (pointer, expected) in [
            (
                "/spec/sandboxes/assistant/inferenceProviders/own/endpoint",
                "/spec/sandboxes/assistant/inferenceProviders/own/endpoint",
            ),
            (
                "/spec/inferenceProviders/Private Sentinel/endpoint",
                "/spec/inferenceProviders/[entry]/endpoint",
            ),
            (
                "/spec/sandboxes/Private Sentinel/harnesses/shared/kind",
                "/spec/sandboxes/[entry]/harnesses/[entry]/kind",
            ),
            (
                "form:/spec/services/a~1b/image",
                "form:/spec/services/[entry]/image",
            ),
        ] {
            assert_eq!(mask_entry_keys(pointer), expected, "{pointer}");
        }
    }
}
