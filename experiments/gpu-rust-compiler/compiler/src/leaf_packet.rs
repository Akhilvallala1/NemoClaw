// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Strict whole-module GEM1 decoder shared by single-module emission and corpus replay.
//! Rejected LLVM semantics are never approximated or lowered through this schema.
use crate::{
    codegen_service::*,
    machine_codegen::{self, MachineTarget},
};
use sha2::{Digest, Sha256};
use std::sync::Arc;

pub struct DecodedPacket {
    pub batch: Arc<FlatBatch>,
    pub target: MachineTarget,
    pub llvm_target: String,
}
fn hash(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}
struct Reader<'a> {
    bytes: &'a [u8],
    position: usize,
}
impl Reader<'_> {
    fn bytes(&mut self, count: usize) -> Result<&[u8], String> {
        let end = self
            .position
            .checked_add(count)
            .ok_or("packet size overflow")?;
        let value = self
            .bytes
            .get(self.position..end)
            .ok_or("truncated GEM1 packet")?;
        self.position = end;
        Ok(value)
    }
    fn u32(&mut self) -> Result<u32, String> {
        Ok(u32::from_le_bytes(self.bytes(4)?.try_into().unwrap()))
    }
    fn i64(&mut self) -> Result<i64, String> {
        Ok(i64::from_le_bytes(self.bytes(8)?.try_into().unwrap()))
    }
    fn string(&mut self) -> Result<String, String> {
        let size = self.u32()? as usize;
        if size == 0 || size > 4096 {
            return Err("invalid packet string length".into());
        }
        String::from_utf8(self.bytes(size)?.to_vec())
            .map_err(|_| "packet string is not UTF-8".into())
    }
}
pub fn decode(bytes: &[u8]) -> Result<DecodedPacket, String> {
    decode_with_key(
        bytes,
        BatchKey {
            logical_id: "llvm-module".into(),
            generation: 1,
        },
    )
}

/// Fresh generations let a retained service replay the same captured module
/// without changing its instruction, ABI or source identity.
pub fn decode_with_key(bytes: &[u8], key: BatchKey) -> Result<DecodedPacket, String> {
    if bytes.len() > 128 * 1024 * 1024 {
        return Err("GEM1 input exceeds 128 MiB".into());
    }
    let mut reader = Reader { bytes, position: 0 };
    if reader.bytes(4)? != b"GEM1" {
        return Err("unsupported leaf packet schema".into());
    }
    let triple = reader.string()?;
    let target = if triple.starts_with("x86_64-") {
        MachineTarget::X86_64
    } else if triple.starts_with("aarch64-") || triple.starts_with("arm64-") {
        MachineTarget::Aarch64
    } else {
        return Err("unsupported machine architecture".into());
    };
    // Rust target names and LLVM's Darwin triples name the same scalar ABI.
    // Preserve the original LLVM spelling in the receipt; only the ABI key is
    // normalized. No module target or target instructions are rewritten.
    let abi_triple =
        if triple.starts_with("arm64-apple-macosx") || triple.starts_with("aarch64-apple-macosx") {
            "aarch64-apple-darwin".to_string()
        } else if triple.starts_with("x86_64-apple-macosx") {
            "x86_64-apple-darwin".to_string()
        } else {
            triple.clone()
        };
    let count = reader.u32()? as usize;
    if count == 0 || count > 65536 {
        return Err("packet function count is out of bounds".into());
    }
    let mut functions = Vec::new();
    let mut instructions = Vec::new();
    let mut symbols = Vec::new();
    let mut abis = Vec::new();
    for index in 0..count {
        let name = reader.string()?;
        let params = reader.u32()?;
        let unwind = reader.u32()?;
        let values = reader.u32()?;
        let ops = reader.u32()?;
        if params > 1 || unwind > 1 || values == 0 || values > 256 || ops == 0 || ops > 4096 {
            return Err("leaf function dimensions are out of bounds".into());
        }
        let start = u32::try_from(instructions.len()).map_err(|_| "instruction count overflow")?;
        for _ in 0..ops {
            let opcode = match reader.u32()? {
                0 => Opcode::Argument,
                1 => Opcode::Const,
                2 => Opcode::Copy,
                3 => Opcode::Add,
                4 => Opcode::Sub,
                5 => Opcode::Mul,
                6 => Opcode::Return,
                _ => return Err("unsupported leaf opcode".into()),
            };
            let result = reader.u32()?;
            let a = reader.u32()?;
            let b = reader.u32()?;
            let immediate = reader.i64()?;
            instructions.push(Instruction {
                opcode,
                result: (result != u32::MAX).then_some(result),
                operands: [a, b],
                immediate,
            });
        }
        functions.push(Function {
            symbol: index as u32,
            instruction_start: start,
            instruction_count: ops,
            value_count: values,
            abi: index as u32,
        });
        symbols.push(Symbol { name });
        abis.push(Abi {
            calling_convention: if target == MachineTarget::Aarch64 && abi_triple.contains("apple")
            {
                CallingConvention::AppleAarch64
            } else {
                CallingConvention::SystemV
            },
            parameter_count: params,
            returns_i64: true,
            requires_unwind: unwind == 1,
        });
    }
    if reader.position != bytes.len() {
        return Err("trailing bytes in GEM1 packet".into());
    }
    let batch = Arc::new(FlatBatch::new(
        BatchIdentity {
            workload_id: hash(bytes),
            toolchain_id: "rust1.98.1-llvm22.1.8-GEM1".into(),
            policy_id: "fast-leaf-fixedframe-v1".into(),
            target_abi: abi_triple,
            source_revision: hash(include_bytes!("machine_codegen.rs")),
        },
        key,
        functions,
        instructions,
        symbols,
        abis,
    )?);
    machine_codegen::pack(&batch, target)?;
    Ok(DecodedPacket {
        batch,
        target,
        llvm_target: triple,
    })
}
