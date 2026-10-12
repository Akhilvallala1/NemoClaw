// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createHash } from "node:crypto";
import vm from "node:vm";
import {
  CONTROL_UI_STARTUP_ENTRY,
  deferControlUiStartup,
  resourceInventory,
  stagePublishedResources,
} from "./openclaw-app-resources.mts";

const originalStartup = 'import{t as e}from"./control-ui-foundation-Cydpkyqa.js";e();';

function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sidecar-graph-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const inputs = path.join(root, "inputs");
  const source = path.join(inputs, "node_modules/openclaw");
  const app = path.join(root, "app");
  fs.mkdirSync(source, { recursive: true });
  fs.mkdirSync(app);
  const write = (relative: string, content: string) => {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, { flag: "wx" });
  };
  return { root, inputs, source, app, write };
}

function resourceFixture(t: test.TestContext) {
  const result = fixture(t);
  const { write } = result;
  write(
    "inputs/node_modules/openclaw/package.json",
    JSON.stringify({ name: "openclaw", version: "2026.9.2" }),
  );
  write("inputs/node_modules/openclaw/" + CONTROL_UI_STARTUP_ENTRY, originalStartup);
  write(
    "inputs/node_modules/openclaw/dist/control-ui/index.html",
    '<script type="module" src="./assets/index-1fvEwqai.js"></script>',
  );
  for (const file of [
    "LICENSE",
    "THIRD_PARTY_NOTICES.md",
    "skills/fixture/SKILL.md",
    "docs/reference/templates/AGENTS.md",
    "docs/reference/templates/BOOTSTRAP.md",
    "docs/not-a-runtime-input.md",
  ])
    write("inputs/node_modules/openclaw/" + file, "published fixture: " + file);
  for (const name of [
    "@emnapi/core",
    "@emnapi/runtime",
    "@lydell/node-pty",
    "@openclaw/fs-safe",
    "@silvia-odwyer/photon-node",
    "clawpdf",
    "rastermill",
    "quickjs-wasi",
    "web-tree-sitter",
    "tree-sitter-bash",
    "playwright-core",
    "typescript",
    "jiti",
    "@homebridge/ciao",
    "undici",
    "ws",
    "libopus-wasm",
    "@discordjs/voice",
  ])
    write(
      "inputs/node_modules/" + name + "/package.json",
      JSON.stringify({ name, version: "1.0.0" }),
    );
  for (const [id, name] of [
    ["brave", "@openclaw/brave-plugin"],
    ["discord", "@openclaw/discord"],
    ["slack", "@openclaw/slack"],
    ["tavily", "@openclaw/tavily-plugin"],
  ])
    write("inputs/plugins/" + id + "/package.json", JSON.stringify({ name, version: "2026.9.2" }));
  return result;
}

test("published workspace templates retain their canonical paths, bytes and inventory identities", (t) => {
  const { source, app } = resourceFixture(t);
  stagePublishedResources(source, app);
  const inventory = resourceInventory(app, []);
  for (const name of ["AGENTS.md", "BOOTSTRAP.md"]) {
    const relative = "node_modules/openclaw/docs/reference/templates/" + name;
    const original = fs.readFileSync(path.join(source, "docs/reference/templates", name));
    assert.deepEqual(fs.readFileSync(path.join(app, relative)), original);
    assert.deepEqual(
      inventory.find((row) => row.path === relative),
      {
        path: relative,
        bytes: original.length,
        sha256: createHash("sha256").update(original).digest("hex"),
        role: "runtime-sidecar",
      },
    );
  }
  assert.equal(
    fs.existsSync(path.join(app, "node_modules/openclaw/docs/not-a-runtime-input.md")),
    false,
  );
});

test("missing published workspace templates stop resource composition", (t) => {
  const { source, app } = resourceFixture(t);
  const templates = path.join(source, "docs/reference/templates");
  for (const name of ["AGENTS.md", "BOOTSTRAP.md"]) fs.unlinkSync(path.join(templates, name));
  fs.rmdirSync(templates);
  assert.throws(() => stagePublishedResources(source, app), { code: "ENOENT" });
});

test("linked workspace templates are rejected without copying or changing the linked data", (t) => {
  const { root, source, app, write } = resourceFixture(t);
  write("outside-template.txt", "must remain unchanged");
  const original = path.join(root, "outside-template.txt");
  fs.linkSync(original, path.join(source, "docs/reference/templates/linked.md"));
  assert.throws(() => stagePublishedResources(source, app), /single-link input files/);
  assert.equal(fs.readFileSync(original, "utf8"), "must remain unchanged");
  assert.equal(
    fs.existsSync(path.join(app, "node_modules/openclaw/docs/reference/templates/linked.md")),
    false,
  );
});

test("packaged UI startup waits for initial fragment navigation before capturing its landing URL", () => {
  let hash = "#token=fixture";
  let landing: string | undefined;
  let calls = 0;
  const window = new EventTarget();
  const initialize = () => {
    calls++;
    hash = "";
    landing = hash;
  };
  const entry = deferControlUiStartup(Buffer.from(originalStartup)).toString("utf8");
  vm.runInNewContext(entry.replace(/^import[^;]+;/u, "const e=initialize;"), {
    document: { readyState: "interactive" },
    window,
    initialize,
  });
  assert.equal(calls, 0);
  hash = "#token=fixture"; // Initial navigation completes before the load event.
  window.dispatchEvent(new Event("load"));
  assert.equal(calls, 1);
  assert.equal(hash, "");
  assert.equal(landing, hash);
  window.dispatchEvent(new Event("load"));
  assert.equal(calls, 1);
  hash = "#user-navigation";
  assert.notEqual(landing, hash); // Later navigation still differs from the captured landing.
});

test("an already loaded document starts the original UI immediately and propagates its failure", () => {
  const entry = deferControlUiStartup(Buffer.from(originalStartup))
    .toString("utf8")
    .replace(/^import[^;]+;/u, "const e=initialize;");
  let calls = 0;
  const failure = new Error("upstream initializer failure");
  assert.throws(
    () =>
      vm.runInNewContext(entry, {
        document: { readyState: "complete" },
        window: {
          addEventListener: () => assert.fail("No load listener after document completion."),
        },
        initialize: () => {
          calls++;
          throw failure;
        },
      }),
    (error) => error === failure,
  );
  assert.equal(calls, 1);
});

test("UI startup adaptation rejects changed source and inventories the staged bytes without modifying upstream", (t) => {
  assert.throws(
    () => deferControlUiStartup(Buffer.from(originalStartup + "e();")),
    /entry changed/,
  );
  const { source, app } = resourceFixture(t);
  const { controlUiStartup } = stagePublishedResources(source, app);
  const relative = "node_modules/openclaw/" + controlUiStartup.stagedEntry;
  const staged = fs.readFileSync(path.join(app, relative));
  assert.deepEqual(staged, deferControlUiStartup(Buffer.from(originalStartup)));
  assert.equal(
    fs.readFileSync(path.join(source, CONTROL_UI_STARTUP_ENTRY), "utf8"),
    originalStartup,
  );
  assert.equal(
    fs.readFileSync(path.join(app, "node_modules/openclaw", CONTROL_UI_STARTUP_ENTRY), "utf8"),
    originalStartup,
  );
  const index = fs.readFileSync(
    path.join(app, "node_modules/openclaw/dist/control-ui/index.html"),
    "utf8",
  );
  assert.equal(
    index,
    `<script type="module" src="./assets/${path.basename(controlUiStartup.stagedEntry)}"></script>`,
  );
  assert.equal(controlUiStartup.stagedSha256, createHash("sha256").update(staged).digest("hex"));
  assert.ok(controlUiStartup.stagedEntry.includes(controlUiStartup.stagedSha256));
  assert.equal(
    resourceInventory(app, []).find((row) => row.path === relative)?.sha256,
    createHash("sha256").update(staged).digest("hex"),
  );
});

test("startup adaptation rejects missing and duplicated entry references before staging", (t) => {
  const { source, app } = resourceFixture(t);
  const index = path.join(source, "dist/control-ui/index.html");
  const original = fs.readFileSync(index);
  fs.writeFileSync(index, "<html></html>");
  assert.throws(() => stagePublishedResources(source, app), /startup reference changed/);
  assert.deepEqual(fs.readdirSync(app), []);
  fs.writeFileSync(index, Buffer.concat([original, original]));
  assert.throws(() => stagePublishedResources(source, app), /startup reference changed/);
  assert.deepEqual(fs.readdirSync(app), []);
  fs.writeFileSync(index, original);
  fs.unlinkSync(path.join(source, CONTROL_UI_STARTUP_ENTRY));
  assert.throws(() => stagePublishedResources(source, app), { code: "ENOENT" });
  assert.deepEqual(fs.readdirSync(app), []);
});

test("derived startup URL cannot select the original compressed script or change its manifest", (t) => {
  const { source, app, write } = resourceFixture(t);
  write(
    "inputs/node_modules/openclaw/" + CONTROL_UI_STARTUP_ENTRY + ".br",
    "original brotli fixture",
  );
  write(
    "inputs/node_modules/openclaw/" + CONTROL_UI_STARTUP_ENTRY + ".gz",
    "original gzip fixture",
  );
  const manifest = "dist/control-ui/asset-manifest.json";
  write(
    "inputs/node_modules/openclaw/" + manifest,
    JSON.stringify({ entry: CONTROL_UI_STARTUP_ENTRY }),
  );
  const { controlUiStartup } = stagePublishedResources(source, app);
  const core = path.join(app, "node_modules/openclaw");
  for (const relative of [
    CONTROL_UI_STARTUP_ENTRY + ".br",
    CONTROL_UI_STARTUP_ENTRY + ".gz",
    manifest,
  ])
    assert.deepEqual(
      fs.readFileSync(path.join(core, relative)),
      fs.readFileSync(path.join(source, relative)),
    );
  assert.equal(fs.existsSync(path.join(core, controlUiStartup.stagedEntry + ".br")), false);
  assert.equal(fs.existsSync(path.join(core, controlUiStartup.stagedEntry + ".gz")), false);
});
