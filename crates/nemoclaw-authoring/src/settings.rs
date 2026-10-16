// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use serde_json::Value;

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct SettingQuestion {
    pub path: String,
    pub title: Option<String>,
    pub description: Option<String>,
    pub required: bool,
    pub schema: Value,
    pub choices: Vec<Value>,
    pub suggestion: Option<Value>,
}
