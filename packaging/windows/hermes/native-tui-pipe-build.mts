// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type * as TypeScript from "typescript";

export const gatewaySourceSha256 =
  "86a0259975e1515d46d6e50939c2756dfbda135d585a5e03cd12c0763f4d4d2c";

export const dashboardSocketHelper = String.raw`
function __nemoDashboardSocket(url: string, fallback: typeof WebSocket): WebSocket {
  const declared = process.env.NEMOCLAW_HERMES_DASHBOARD_PIPE_PORT;
  if (declared === undefined) return new fallback(url);
  if (process.platform !== "win32" || !/^[1-9][0-9]{0,4}$/.test(declared) || Number(declared) > 65535)
    throw new Error("The Hermes dashboard pipe declaration is invalid.");
  const target = new URL(url);
  if (target.protocol !== "ws:" || target.hostname !== "127.0.0.1" || target.port !== declared ||
      target.username || target.password || target.hash || !["/api/ws", "/api/pub"].includes(target.pathname))
    throw new Error("The Hermes dashboard connection escaped its declared endpoint.");
  const dispatcher = new __nemoDashboardAgent({
    connect: { socketPath: "\\\\.\\pipe\\LOCAL\\OpenShell-Loopback-" + declared },
  });
  let retiring = false;
  const retire = () => {
    if (retiring) return;
    retiring = true;
    void dispatcher.destroy().catch(() => {
      console.error("The Hermes dashboard connection did not close cleanly.");
      process.exitCode = 1;
    });
  };
  try {
    const socket = new UndiciWebSocket(url, { dispatcher });
    socket.addEventListener("close", retire, { once: true });
    socket.addEventListener("error", retire, { once: true });
    return socket as unknown as WebSocket;
  } catch (error) {
    retire();
    throw error;
  }
}
`;

export function compileNativeTuiPipe(source: string, syntax: typeof TypeScript): string {
  if (createHash("sha256").update(source).digest("hex") !== gatewaySourceSha256)
    throw new Error("The pinned Hermes gateway client source changed.");
  const tree = syntax.createSourceFile(
    "gatewayClient.ts",
    source,
    syntax.ScriptTarget.Latest,
    true,
    syntax.ScriptKind.TS,
  );
  const edits: { start: number; end: number; value: string }[] = [];
  const targets = new Set<string>();
  const visit = (node: TypeScript.Node) => {
    if (syntax.isNewExpression(node) && node.expression.getText(tree) === "WebSocketCtor") {
      const argument = node.arguments?.length === 1 ? node.arguments[0].getText(tree) : "";
      if (!["this.sidecarUrl", "attachUrl"].includes(argument) || targets.has(argument))
        throw new Error("The pinned Hermes dashboard WebSocket call sites changed.");
      targets.add(argument);
      edits.push({
        start: node.getStart(tree),
        end: node.end,
        value: `__nemoDashboardSocket(${argument}, WebSocketCtor)`,
      });
    }
    syntax.forEachChild(node, visit);
  };
  visit(tree);
  if (targets.size !== 2)
    throw new Error("The pinned Hermes dashboard WebSocket call sites are incomplete.");
  let result = source;
  for (const edit of edits.sort((a, b) => b.start - a.start))
    result = result.slice(0, edit.start) + edit.value + result.slice(edit.end);
  return (
    'import { Agent as __nemoDashboardAgent } from "undici";\n' + dashboardSocketHelper + result
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3 || !path.isAbsolute(process.argv[2]))
    throw new Error("The Hermes TUI build directory must be an absolute path.");
  const root = fs.realpathSync(process.argv[2]);
  const target = path.join(root, "ui-tui", "src", "gatewayClient.ts");
  if (fs.realpathSync(target) !== target || !fs.lstatSync(target).isFile())
    throw new Error("The Hermes TUI source is not an ordinary build input.");
  const require = createRequire(path.join(root, "package.json"));
  const original = fs.readFileSync(target, "utf8");
  const result = compileNativeTuiPipe(original, require("typescript"));
  fs.writeFileSync(target, result, "utf8");
  process.stdout.write(
    JSON.stringify({
      schemaVersion: 1,
      classification: "build-time-hermes-dashboard-pipe-client",
      path: "ui-tui/src/gatewayClient.ts",
      sourceSha256: gatewaySourceSha256,
      adaptedSha256: createHash("sha256").update(fs.readFileSync(target)).digest("hex"),
      adapterSha256: createHash("sha256")
        .update(fs.readFileSync(fileURLToPath(import.meta.url)))
        .digest("hex"),
      callSites: 2,
      nativeExecutionQualified: false,
    }) + "\n",
  );
}
