// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";

const script = path.resolve("test/e2e/e2e-cloud-experimental/checks/02-inference-local-http.sh");
const endpoint = "https://native.example/v1";
const reference = "openshell:resolve:env:v3_COMPATIBLE_API_KEY";

it.each([
  { endpoint: "", credential: "", http: "200", curlExit: 0, exit: 0, invoked: true },
  { endpoint, credential: reference, http: "200", curlExit: 0, exit: 0, invoked: true },
  { endpoint, credential: reference, http: "401", curlExit: 0, exit: 1, invoked: true },
  { endpoint, credential: reference, http: "000", curlExit: 7, exit: 1, invoked: true },
  { endpoint, credential: "raw-secret", http: "200", curlExit: 0, exit: 1, invoked: false },
  { endpoint, credential: "", http: "200", curlExit: 0, exit: 1, invoked: false },
])("preserves the cloud models probe contract: %j", (scenario) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cloud-models-probe-"));
  try {
    const capture = path.join(directory, "curl-args.json");
    fs.writeFileSync(path.join(directory, "openshell"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    fs.writeFileSync(path.join(directory, "ssh"), '#!/bin/bash\nexec bash -c "${!#}"\n', {
      mode: 0o700,
    });
    fs.writeFileSync(
      path.join(directory, "curl"),
      `#!${process.execPath}\nconst fs = require('node:fs'); fs.writeFileSync(process.env.CAPTURE, JSON.stringify(process.argv.slice(2))); process.stdout.write(process.env.HTTP); process.exit(Number(process.env.CURL_EXIT));\n`,
      { mode: 0o700 },
    );
    const result = spawnSync("bash", [script], {
      encoding: "utf8",
      env: {
        PATH: `${directory}:/usr/bin:/bin`,
        CAPTURE: capture,
        HTTP: scenario.http,
        CURL_EXIT: String(scenario.curlExit),
        COMPATIBLE_API_KEY: scenario.credential,
        NEMOCLAW_E2E_NATIVE_CUSTOM_ENDPOINT: scenario.endpoint,
      },
    });
    expect({
      exit: result.status,
      args: fs.existsSync(capture) ? JSON.parse(fs.readFileSync(capture, "utf8")) : null,
      leaked: `${result.stdout}${result.stderr}`.includes("raw-secret"),
    }).toEqual({
      exit: scenario.exit,
      args: scenario.invoked
        ? [
            "-sS",
            "-o",
            "/dev/null",
            "-w",
            "%{http_code}",
            "--max-time",
            "60",
            ...(scenario.endpoint ? ["-H", `Authorization: Bearer ${reference}`] : []),
            `${scenario.endpoint || "https://inference.local/v1"}/models`,
          ]
        : null,
      leaked: false,
    });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
