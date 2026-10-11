// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use gpu_rust_compiler::leaf_packet;

fn word(bytes: &mut Vec<u8>, value: u32) {
    bytes.extend_from_slice(&value.to_le_bytes());
}
fn string(bytes: &mut Vec<u8>, value: &str) {
    word(bytes, value.len() as u32);
    bytes.extend_from_slice(value.as_bytes());
}
fn packet() -> Vec<u8> {
    let mut bytes = b"GEM1".to_vec();
    string(&mut bytes, "arm64-apple-macosx15.0.0");
    word(&mut bytes, 1);
    string(&mut bytes, "rust_leaf");
    for value in [1, 1, 1, 2] {
        word(&mut bytes, value);
    }
    for value in [0, 0, 0, 0] {
        word(&mut bytes, value);
    }
    bytes.extend_from_slice(&0i64.to_le_bytes());
    for value in [6, u32::MAX, 0, 0] {
        word(&mut bytes, value);
    }
    bytes.extend_from_slice(&0i64.to_le_bytes());
    bytes
}

#[test]
fn shared_decoder_preserves_the_llvm_target_and_required_unwind() {
    let decoded = leaf_packet::decode(&packet()).expect("valid strict LLVM leaf packet");
    assert_eq!(decoded.llvm_target, "arm64-apple-macosx15.0.0");
    assert_eq!(decoded.batch.identity().target_abi, "aarch64-apple-darwin");
    assert!(decoded.batch.abis()[0].requires_unwind);
    assert_eq!(decoded.batch.symbols()[0].name, "rust_leaf");
}

#[test]
fn trailing_or_truncated_packets_cannot_be_replayed() {
    let mut bytes = packet();
    bytes.push(0);
    assert!(leaf_packet::decode(&bytes).is_err());
    bytes.truncate(bytes.len() - 2);
    assert!(leaf_packet::decode(&bytes).is_err());
}
