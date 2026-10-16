// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import {
  closeSync,
  fstatSync,
  mkdtempSync,
  openSync,
  readSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";

// Compatibility boundary: existing backups are raw tar streams, so validation
// still shells out to system tar. Route listings through a bounded temp file
// instead of child-process stdout buffers; remove this path when backup
// validation moves to a native streaming tar parser or indexed manifest format.
const TAR_LISTING_STDERR_MAX_BUFFER_BYTES = 1024 * 1024;
const TAR_LISTING_MAX_OUTPUT_BYTES = 256 * 1024 * 1024;
const TAR_LISTING_READ_CHUNK_BYTES = 64 * 1024;
const TAR_LISTING_MAX_LINE_CHARS = 1024 * 1024;
const TAR_BLOCK_BYTES = 512;
const TAR_METADATA_MAX_BYTES = 1024 * 1024;
let unsupportedLiteralQuotingPath: string | null = null;

/** Stream UTF-8 lines from the bounded listing file without buffering the whole output in memory. */
function readTextLinesFromFile(filePath: string, onLine: (line: string) => void): void {
  const fd = openSync(filePath, "r");
  const decoder = new StringDecoder("utf8");
  const chunk = Buffer.alloc(TAR_LISTING_READ_CHUNK_BYTES);
  let pending = "";
  try {
    while (true) {
      const bytesRead = readSync(fd, chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      pending += decoder.write(chunk.subarray(0, bytesRead));
      if (pending.length > TAR_LISTING_MAX_LINE_CHARS) {
        throw new Error("tar listing line exceeds supported length");
      }
      let newlineIndex = pending.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = pending.slice(0, newlineIndex).replace(/\r$/, "");
        if (line.length > 0) onLine(line);
        pending = pending.slice(newlineIndex + 1);
        newlineIndex = pending.indexOf("\n");
      }
    }
    pending += decoder.end();
    if (pending.length > TAR_LISTING_MAX_LINE_CHARS) {
      throw new Error("tar listing line exceeds supported length");
    }
    const lastLine = pending.replace(/\r$/, "");
    if (lastLine.length > 0) onLine(lastLine);
  } finally {
    closeSync(fd);
  }
}

/** Normalize spawnSync exit outcomes so signal or spawn errors fail closed as non-zero. */
function tarExitStatus(result: ReturnType<typeof spawnSync>): number {
  return result.status ?? (result.error || result.signal ? 1 : 0);
}

/** Detect tar implementations such as bsdtar that reject GNU --quoting-style=literal. */
function isUnsupportedQuotingStyle(result: SpawnSyncReturns<string>): boolean {
  return tarExitStatus(result) !== 0 && /quoting-style/iu.test(result.stderr || "");
}

/** Return true when a header value contains a line break (CR or LF), which would split a line-delimited listing. */
function hasHeaderLineBreak(value: string): boolean {
  return value.includes("\n") || value.includes("\r");
}

/** Read a NUL-padded UTF-8 field from a 512-byte ustar header block. */
function tarHeaderString(header: Buffer, start: number, length: number): string {
  const end = header.indexOf(0, start);
  return header
    .subarray(start, end >= start && end < start + length ? end : start + length)
    .toString("utf8");
}

/** Decode an octal or base-256 tar member size field. */
function tarHeaderSize(header: Buffer): number | null {
  const field = header.subarray(124, 136);
  if ((field[0] ?? 0) & 0x80) {
    let value = BigInt((field[0] ?? 0) & 0x7f);
    for (const byte of field.subarray(1)) value = (value << 8n) | BigInt(byte);
    return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;
  }
  const text = field.toString("ascii").replace(/\0.*$/su, "").trim();
  if (!/^[0-7]*$/u.test(text)) return null;
  const value = text.length === 0 ? 0 : Number.parseInt(text, 8);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

type TarHeaderLineBreakInspection = "clean" | "line-break" | "uninspectable";

/** Detect a PAX path or linkpath record that contains a line break; report malformed records as uninspectable. */
function inspectPaxHeaderForLineBreaks(payload: Buffer): TarHeaderLineBreakInspection {
  let cursor = 0;
  while (cursor < payload.byteLength) {
    const separator = payload.indexOf(0x20, cursor);
    if (separator < 0) return "uninspectable";
    const length = Number.parseInt(payload.subarray(cursor, separator).toString("ascii"), 10);
    if (!Number.isSafeInteger(length) || length <= 0 || cursor + length > payload.byteLength) {
      return "uninspectable";
    }
    if (payload[cursor + length - 1] !== 0x0a) return "uninspectable";
    const record = payload.subarray(separator + 1, cursor + length - 1).toString("utf8");
    const equals = record.indexOf("=");
    if (equals <= 0) return "uninspectable";
    const key = record.slice(0, equals);
    if ((key === "path" || key === "linkpath") && hasHeaderLineBreak(record.slice(equals + 1))) {
      return "line-break";
    }
    cursor += length;
  }
  return "clean";
}

/**
 * Inspect every tar header before a literal listing. Return a failure when a
 * member path or link target contains a line break, or when a header or its
 * metadata cannot be inspected within TAR_METADATA_MAX_BYTES.
 */
function inspectArchiveHeadersForLineBreaks(
  readRange: (position: number, length: number) => Buffer | null,
  archiveSize: number,
): TarHeaderLineBreakInspection {
  let offset = 0;
  while (offset < archiveSize) {
    if (offset + TAR_BLOCK_BYTES > archiveSize) return "uninspectable";
    const header = readRange(offset, TAR_BLOCK_BYTES);
    if (!header) return "uninspectable";
    if (header.every((byte) => byte === 0)) return "clean";
    if (
      hasHeaderLineBreak(tarHeaderString(header, 0, 100)) ||
      hasHeaderLineBreak(tarHeaderString(header, 157, 100)) ||
      hasHeaderLineBreak(tarHeaderString(header, 345, 155))
    ) {
      return "line-break";
    }
    const size = tarHeaderSize(header);
    if (size === null) return "uninspectable";
    const dataOffset = offset + TAR_BLOCK_BYTES;
    const nextOffset = dataOffset + Math.ceil(size / TAR_BLOCK_BYTES) * TAR_BLOCK_BYTES;
    if (!Number.isSafeInteger(nextOffset) || nextOffset > archiveSize) return "uninspectable";
    const type = String.fromCharCode(header[156] ?? 0);
    if (type === "x" || type === "g" || type === "L" || type === "K") {
      if (size > TAR_METADATA_MAX_BYTES) return "uninspectable";
      const metadata = readRange(dataOffset, size);
      if (!metadata) return "uninspectable";
      if (type === "x" || type === "g") {
        const paxResult = inspectPaxHeaderForLineBreaks(metadata);
        if (paxResult !== "clean") return paxResult;
      } else {
        const longValue = metadata.toString("utf8").replace(/\0.*$/su, "");
        if (!longValue) return "uninspectable";
        if (hasHeaderLineBreak(longValue)) return "line-break";
      }
    }
    offset = nextOffset;
  }
  return "clean";
}

/** Read the full byte range from an open archive descriptor, or return null at EOF; the file offset is unchanged. */
function readDescriptorRange(descriptor: number, position: number, length: number): Buffer | null {
  const result = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    const count = readSync(descriptor, result, read, length - read, position + read);
    if (count === 0) return null;
    read += count;
  }
  return result;
}

export type TarArchiveSource = Buffer | { filePath: string };
export type TarListingSource = TarArchiveSource | { fileDescriptor: number };

/** Stage a caller-supplied file descriptor into a private temporary archive at offset 0. */
function copyDescriptorToPrivateArchive(fileDescriptor: number, tempDir: string): string {
  const source = fstatSync(fileDescriptor);
  if (!source.isFile() || !Number.isSafeInteger(source.size) || source.size < 0) {
    throw new Error("tar archive descriptor must reference a regular file");
  }
  const archivePath = path.join(tempDir, "archive.tar");
  const archiveFd = openSync(archivePath, "wx", 0o600);
  const chunk = Buffer.alloc(TAR_LISTING_READ_CHUNK_BYTES);
  let position = 0;
  try {
    while (position < source.size) {
      const requested = Math.min(chunk.byteLength, source.size - position);
      const bytesRead = readSync(fileDescriptor, chunk, 0, requested, position);
      if (bytesRead === 0) throw new Error("tar archive descriptor became truncated");
      let written = 0;
      while (written < bytesRead) {
        const count = writeSync(archiveFd, chunk, written, bytesRead - written, position + written);
        if (count === 0) throw new Error("could not stage tar archive descriptor");
        written += count;
      }
      position += bytesRead;
    }
  } finally {
    closeSync(archiveFd);
  }
  return archivePath;
}

/** Open a descriptor at offset 0 so repeated tar passes do not share a consumed file position. */
function openIndependentTarDescriptor(
  tarArchive: Exclude<TarListingSource, Buffer>,
  tempDir: string,
  stagedArchivePath: { current: string | null },
) {
  if ("filePath" in tarArchive) return openSync(tarArchive.filePath, "r");
  // Linux reopens the underlying inode with an independent file offset, even
  // after its original pathname is unlinked. Other platforms' /dev/fd clones
  // share the offset, so use a private positional copy there instead.
  if (process.platform === "linux") {
    try {
      return openSync(`/proc/self/fd/${tarArchive.fileDescriptor}`, "r");
    } catch {
      // Fall back for Linux environments without procfs mounted.
    }
  }
  if (stagedArchivePath.current === null) {
    stagedArchivePath.current = copyDescriptorToPrivateArchive(tarArchive.fileDescriptor, tempDir);
  }
  return openSync(stagedArchivePath.current, "r");
}

/** Run one tar listing pass into listingPath, closing descriptors before returning. */
function spawnTarListingPass(
  tarArchive: TarListingSource,
  tempDir: string,
  listingPath: string,
  stagedArchivePath: { current: string | null },
  args: string[],
  timeoutMs: number,
): SpawnSyncReturns<string> {
  let listingFd: number | null = null;
  let archiveFd: number | null = null;
  try {
    listingFd = openSync(listingPath, "w");
    if (Buffer.isBuffer(tarArchive)) {
      return spawnSync("tar", args, {
        input: tarArchive,
        encoding: "utf-8",
        stdio: ["pipe", listingFd, "pipe"],
        timeout: timeoutMs,
        maxBuffer: TAR_LISTING_STDERR_MAX_BUFFER_BYTES,
      });
    }
    archiveFd = openIndependentTarDescriptor(tarArchive, tempDir, stagedArchivePath);
    return spawnSync("tar", args, {
      encoding: "utf-8",
      stdio: [archiveFd, listingFd, "pipe"],
      timeout: timeoutMs,
      maxBuffer: TAR_LISTING_STDERR_MAX_BUFFER_BYTES,
    });
  } finally {
    if (listingFd !== null) closeSync(listingFd);
    if (archiveFd !== null) closeSync(archiveFd);
  }
}

/**
 * List tar entries through a temporary file so large archives do not overflow
 * spawnSync buffers. GNU tar runs with --quoting-style=literal so backslashes
 * stay literal; tar implementations without that option, such as bsdtar, keep
 * their default escaping.
 */
export function runTarListing(
  tarArchive: TarListingSource,
  args: string[],
  failureLabel: string,
  onLine: (line: string) => void,
  timeoutMs = 60_000,
): string | null {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "nemoclaw-tar-listing-"));
  const listingPath = path.join(tempDir, "listing.txt");
  const stagedArchivePath = { current: null as string | null };
  let headerFd: number | null = null;
  try {
    const headerInspection = Buffer.isBuffer(tarArchive)
      ? inspectArchiveHeadersForLineBreaks(
          (position, length) =>
            position + length <= tarArchive.byteLength
              ? tarArchive.subarray(position, position + length)
              : null,
          tarArchive.byteLength,
        )
      : (() => {
          headerFd = openIndependentTarDescriptor(tarArchive, tempDir, stagedArchivePath);
          const size = fstatSync(headerFd).size;
          return inspectArchiveHeadersForLineBreaks(
            (position, length) => readDescriptorRange(headerFd!, position, length),
            size,
          );
        })();
    if (headerFd !== null) {
      closeSync(headerFd);
      headerFd = null;
    }
    if (headerInspection === "line-break") {
      return `${failureLabel} failed: archive entry contains a line break`;
    }
    if (headerInspection === "uninspectable") {
      return `${failureLabel} failed: archive header cannot be inspected for line breaks`;
    }

    const currentPath = process.env.PATH ?? "";
    const tryLiteralQuoting = unsupportedLiteralQuotingPath !== currentPath;
    let result = spawnTarListingPass(
      tarArchive,
      tempDir,
      listingPath,
      stagedArchivePath,
      tryLiteralQuoting ? ["--quoting-style=literal", ...args] : args,
      timeoutMs,
    );
    if (tryLiteralQuoting && isUnsupportedQuotingStyle(result)) {
      unsupportedLiteralQuotingPath = currentPath;
      result = spawnTarListingPass(
        tarArchive,
        tempDir,
        listingPath,
        stagedArchivePath,
        args,
        timeoutMs,
      );
    }

    const status = tarExitStatus(result);
    if (status !== 0) {
      return `${failureLabel} failed (exit ${status}): ${(result.stderr || "").substring(0, 200)}`;
    }

    if (statSync(listingPath).size > TAR_LISTING_MAX_OUTPUT_BYTES) {
      return `${failureLabel} exceeded ${TAR_LISTING_MAX_OUTPUT_BYTES} bytes`;
    }

    readTextLinesFromFile(listingPath, onLine);
    return null;
  } catch (error) {
    return `${failureLabel} failed: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    if (headerFd !== null) closeSync(headerFd);
    rmSync(tempDir, { recursive: true, force: true });
  }
}
