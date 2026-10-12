// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

export type HistoryFixture = {
  home: string;
  sessionId: string;
  sessionKey: string;
  store: string;
  transcript: string;
  storeText: string;
  transcriptText: string;
};

function ordinaryFile(file: string) {
  const info = fs.lstatSync(file);
  assert(info.isFile() && !info.isSymbolicLink() && info.nlink === 1);
  assert(info.size <= 16 * 1024 * 1024, "The history fixture exceeds its bound.");
  return fs.readFileSync(file);
}

function filesBelow(directory: string): string[] {
  const files: string[] = [];
  let entries = 0;
  const visit = (current: string) => {
    const info = fs.lstatSync(current);
    assert(info.isDirectory() && !info.isSymbolicLink());
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      assert(++entries <= 10000, "The history inventory exceeds its bound.");
      assert(!entry.isSymbolicLink());
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) visit(file);
      else {
        assert(entry.isFile());
        files.push(file);
      }
    }
  };
  visit(directory);
  return files;
}

export function verifyInstalledHistory(fixture: HistoryFixture) {
  assert(path.isAbsolute(fixture.home));
  assert.match(fixture.sessionId, /^migration-[a-f0-9]{32}$/u);
  assert.equal(fixture.sessionKey, `agent:main:${fixture.sessionId}`);
  const sessions = path.join(fixture.home, ".openclaw", "agents", "main", "sessions");
  assert.equal(fixture.store, path.join(sessions, "sessions.json"));
  assert.equal(fixture.transcript, path.join(sessions, `${fixture.sessionId}.jsonl`));
  for (const file of [fixture.store, fixture.transcript])
    assert.throws(() => fs.lstatSync(file), { code: "ENOENT" });
  const archiveRoot = path.join(path.dirname(sessions), "session-sqlite-import-archive");
  const archives = filesBelow(archiveRoot);
  const storeArchives = archives.filter((file) =>
    /^legacy-store\.sessions\.json\.imported-[0-9]+(?:\.[0-9]+)?$/u.test(path.basename(file)),
  );
  assert.equal(storeArchives.length, 1);
  assert.equal(ordinaryFile(storeArchives[0]).toString("utf8"), fixture.storeText);
  assert.equal(
    archives.filter((file) => ordinaryFile(file).toString("utf8") === fixture.transcriptText)
      .length,
    1,
  );
  const databases = filesBelow(path.join(fixture.home, ".openclaw")).filter((file) => {
    if (!file.endsWith(".sqlite")) return false;
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      return Boolean(
        db
          .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='session_nodes'")
          .get(),
      );
    } finally {
      db.close();
    }
  });
  assert.equal(databases.length, 1);
  const db = new DatabaseSync(databases[0], { readOnly: true });
  const expected = fixture.transcriptText
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line));
  try {
    assert.equal(
      db
        .prepare("SELECT current_session_id FROM session_nodes WHERE session_key = ?")
        .get(fixture.sessionKey)?.current_session_id,
      fixture.sessionId,
    );
    const actual = db
      .prepare("SELECT event_json FROM transcript_events WHERE session_id = ? ORDER BY seq")
      .all(fixture.sessionId)
      .map((row) => JSON.parse(String(row.event_json)));
    assert.deepEqual(actual, expected);
    assert.deepEqual(
      db
        .prepare("PRAGMA integrity_check")
        .all()
        .map((row) => Object.values(row)[0]),
      ["ok"],
    );
  } finally {
    db.close();
  }
  return {
    classification: "installed-openclaw-history-observation",
    importedEvents: expected.length,
    archives: archives
      .map((file) => ({
        file: path.relative(archiveRoot, file),
        sha256: createHash("sha256").update(ordinaryFile(file)).digest("hex"),
      }))
      .sort((left, right) => left.file.localeCompare(right.file)),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.equal(process.argv.length, 4);
  const fixture = JSON.parse(ordinaryFile(process.argv[2]).toString("utf8"));
  fs.writeFileSync(process.argv[3], JSON.stringify(verifyInstalledHistory(fixture)) + "\n", {
    flag: "wx",
  });
}
