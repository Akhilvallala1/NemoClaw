// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import type { OpenShellGatewayReuseObservation } from "../../../src/lib/adapters/openshell/gateway-reuse.ts";
export function canonicalObservedGatewayRegistration(
  observation: OpenShellGatewayReuseObservation,
  gatewayName: string,
): string | null {
  return observation.namedMetadata &&
    observation.namedEndpoint &&
    typeof observation.namedActive === "boolean"
    ? JSON.stringify({
        name: gatewayName,
        endpoint: observation.namedEndpoint,
        active: observation.namedActive,
      })
    : null;
}
