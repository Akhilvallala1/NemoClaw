// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createHash } from "node:crypto";
import { resourceInventory, stagePublishedResources } from "./openclaw-app-resources.mts";

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
  for (const file of [
    "LICENSE",
    "THIRD_PARTY_NOTICES.md",
    "dist/control-ui/index.html",
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
