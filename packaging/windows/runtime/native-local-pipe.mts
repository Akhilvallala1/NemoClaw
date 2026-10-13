// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import http from "node:http";

export function nativeLocalPipeName(port: number): string {
  if (process.platform !== "win32" || !Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("The native local pipe requires Windows and a valid declared port.");
  return String.raw`\\.\pipe\LOCAL\OpenShell-Loopback-${port}`;
}

export async function readNativeBrokerBootstrap(port: number, token: string): Promise<unknown> {
  const socketPath = nativeLocalPipeName(port);
  if (!/^[A-Za-z0-9_-]{32,128}$/u.test(token))
    throw new Error("The native broker bootstrap identity is invalid.");
  return await new Promise((resolve, reject) => {
    const request = http.request({
      socketPath,
      path: "/native/bootstrap",
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    const timer = setTimeout(
      () => request.destroy(new Error("The native broker bootstrap timed out.")),
      15_000,
    );
    request.once("close", () => clearTimeout(timer));
    request.once("error", reject);
    request.once("response", (response) => {
      const chunks: Buffer[] = [];
      let length = 0;
      response.on("data", (chunk: Buffer) => {
        length += chunk.length;
        if (length > 1024 * 1024)
          request.destroy(new Error("The native broker bootstrap reply is too large."));
        else chunks.push(chunk);
      });
      response.once("error", reject);
      response.once("end", () => {
        if (response.statusCode !== 200) {
          reject(new Error("The native broker bootstrap request failed."));
          return;
        }
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch {
          reject(new Error("The native broker bootstrap reply is invalid."));
        }
      });
    });
    request.end();
  });
}
