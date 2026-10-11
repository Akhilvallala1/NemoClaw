// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Inject only into the synthetic inspect process, after its package-manager trap.
// Do not propagate a preload to workers or change their arguments or environment.
export const choiceInspectChildDiagnostics = String.raw`
(() => {
  const cp = require("node:child_process");
  const started = performance.now();
  let sequence = 0, records = 0;
  const emit = (id, method, category, stage) => {
    if (records++ >= 128) return;
    try {
      process.stderr.write("[nemoclaw-choice-child] " + JSON.stringify({
        id, method, category, stage, elapsedMs: Math.round(performance.now() - started)
      }) + "\n");
    } catch {}
  };
  for (const method of ["spawn", "spawnSync", "execFile", "execFileSync"]) {
    const original = cp[method];
    cp[method] = function(...args) {
      const id = ++sequence;
      const executable = typeof args[0] === "string" ? args[0] : "";
      const category = executable === process.execPath
        ? (Array.isArray(args[1]) && args[1].includes("--openclaw-sqlite-readonly-child")
          ? "node-sqlite-readonly" : "node")
        : /(?:^|[\\/])(?:powershell|pwsh)(?:\.exe)?$/i.test(executable)
          ? "powershell" : "other";
      emit(id, method, category, "start");
      try {
        const result = original.apply(this, args);
        if (method.endsWith("Sync")) emit(id, method, category, "returned");
        else result.once("close", () => emit(id, method, category, "closed"));
        return result;
      } catch (error) {
        emit(id, method, category, "threw");
        throw error;
      }
    };
  }
  require("node:module").syncBuiltinESMExports();
})();
`;

// Only the separate, synthetic readonly-worker probe loads this preload.
// Acceptance workers keep their original arguments and environment.
export const sqliteReadonlyWorkerDiagnostics =
  choiceInspectChildDiagnostics +
  String.raw`
(() => {
  const sqlite = require("node:sqlite"), original = sqlite.backup;
  const started = performance.now();
  let records = 0;
  const mark = stage => {
    if (records++ >= 128) return;
    try {
      process.stderr.write("[nemoclaw-snapshot-backup] " + JSON.stringify({
        stage, elapsedMs: Math.round(performance.now() - started)
      }) + "\n");
    } catch {}
  };
  mark("preload-started");
  sqlite.backup = function(...args) {
    mark("start");
    let result;
    try { result = original.apply(this, args); }
    catch (error) { mark("threw"); throw error; }
    result.then(() => mark("finished"), () => mark("rejected"));
    return result;
  };
  require("node:module").syncBuiltinESMExports();
})();
`;
