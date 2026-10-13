// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { DockerDriverGatewayLocalTlsBundle } from "../../../src/lib/onboard/docker-driver-gateway-local-tls.ts";

/** Public health uses server TLS; guest credentials configure the Docker driver, not client authentication. */
export function externalGatewayHealthConfig(
  address: string,
  port: number,
  tls: DockerDriverGatewayLocalTlsBundle,
): string {
  return [
    "[openshell]",
    "version = 2",
    "",
    "[openshell.gateway]",
    `bind_address = ${JSON.stringify(`${address}:${String(port)}`)}`,
    'compute_driver = "docker"',
    "disable_tls = false",
    `guest_tls_ca = ${JSON.stringify(tls.caPath)}`,
    `guest_tls_cert = ${JSON.stringify(tls.clientCertPath)}`,
    `guest_tls_key = ${JSON.stringify(tls.clientKeyPath)}`,
    "",
    "[openshell.gateway.tls]",
    `cert_path = ${JSON.stringify(tls.serverCertPath)}`,
    `key_path = ${JSON.stringify(tls.serverKeyPath)}`,
    "",
    "[openshell.gateway.auth]",
    "allow_unauthenticated_users = true",
    "",
  ].join("\n");
}
