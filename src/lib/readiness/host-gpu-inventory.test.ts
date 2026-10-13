// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { HostAssessment } from "../onboard/preflight";
import {
  collectHostObservations,
  projectHostReadiness,
  type HostObservationSnapshot,
} from "./host";
import { createPublicHostProbeReadinessReport, renderReadinessReport } from "./presentation";

const NOW = new Date("2026-10-13T00:00:00.000Z");
const MIB = 1024 ** 2;
const GPUS = [
  { name: "NVIDIA RTX PRO 6000 Blackwell Workstation Edition", memoryMB: 97887 },
  { name: "NVIDIA GB300", memoryMB: 256703 },
];
const HOST: HostAssessment = {
  platform: "linux",
  isWsl: false,
  runtime: "docker",
  dockerInstalled: true,
  dockerRunning: true,
  dockerReachable: true,
  nodeInstalled: true,
  openshellInstalled: true,
  isContainerRuntimeUnderProvisioned: false,
  hasNestedOverlayConflict: false,
  requiresHostCgroupnsFix: false,
  isUnsupportedRuntime: false,
  isHeadlessLikely: false,
  hasNvidiaGpu: true,
  dockerCdiSpecDirs: [],
  cdiNvidiaGpuSpecMissing: false,
  nvidiaContainerToolkitInstalled: true,
  notes: [],
};

function collect(gpus: typeof GPUS | null = GPUS, hasNvidiaGpu = true) {
  return collectHostObservations({
    assess: () => ({ ...HOST, hasNvidiaGpu }),
    architecture: "arm64",
    detectGpu: () =>
      hasNvidiaGpu
        ? {
            count: gpus?.length ?? 2,
            gpus: gpus ?? undefined,
            totalMemoryMB: gpus?.reduce((total, gpu) => total + gpu.memoryMB, 0) ?? 354590,
            perGpuMB: 97887,
          }
        : null,
    detectNvidiaDriverVersion: () => "580.65.06",
    detectHostGpuPlatform: () => "linux",
    collectPlatformIdentity: () => ({
      productName: null,
      nvidiaPlatform: null,
      stationProfile: null,
      stationGb300PciGpu: null,
    }),
    now: () => NOW,
  });
}

function present(snapshot: HostObservationSnapshot) {
  return createPublicHostProbeReadinessReport(
    projectHostReadiness(snapshot, {
      nemoclawVersion: "0.1.0",
      sourceRevision: "697289aec2e0c5a1a2b8d2ed5a714b31bb5df4b4",
      now: () => NOW,
    }),
  );
}

function devices(report: ReturnType<typeof present>) {
  return report.evidence.filter(({ id }) => id.startsWith("host.gpu.device."));
}

describe("host probe GPU inventory (#13019)", () => {
  it("reports both GPU names and memory sizes on an asymmetric host", () => {
    const report = present(collect());
    const json = JSON.parse(JSON.stringify(report)) as typeof report;

    expect(devices(json).map(({ details }) => details)).toEqual([
      { index: 0, name: GPUS[0]!.name, memoryBytes: 97887 * MIB },
      { index: 1, name: GPUS[1]!.name, memoryBytes: 256703 * MIB },
    ]);
    const total = devices(json).reduce((sum, gpu) => sum + Number(gpu.details?.memoryBytes), 0);
    expect(json.observations).toContainEqual({
      id: "host.gpu.memory_total_bytes",
      state: "present",
      value: total,
    });
    expect(json.observations).toContainEqual({
      id: "host.gpu.memory_per_device_bytes",
      state: "present",
      value: 97887 * MIB,
    });
    expect(json.mutated).toBe(false);
  });

  it("prints each GPU name and memory size in the text report", () => {
    const text = renderReadinessReport(present(collect()));

    expect(text).toContain(`GPU 0: ${GPUS[0]!.name} (97887 MiB)`);
    expect(text).toContain(`GPU 1: ${GPUS[1]!.name} (256703 MiB)`);
  });

  it("distinguishes GPUs that have the same model name", () => {
    const report = present(collect(GPUS.map((gpu) => ({ ...gpu, name: "NVIDIA GPU" }))));

    expect(devices(report).map(({ details }) => details?.index)).toEqual([0, 1]);
    expect(renderReadinessReport(report)).toContain("GPU 0: NVIDIA GPU (97887 MiB)");
    expect(renderReadinessReport(report)).toContain("GPU 1: NVIDIA GPU (256703 MiB)");
  });

  it("does not invent GPU devices when the detector only reports a count", () => {
    const report = present(collect(null));

    expect(devices(report)).toEqual([]);
    expect(report.observations).toContainEqual({
      id: "host.gpu.memory_per_device_bytes",
      state: "present",
      value: 97887 * MIB,
    });
    expect(renderReadinessReport(report)).not.toContain("GPU 0:");
  });

  it("omits GPU inventory on a CPU-only host", () => {
    const report = present(collect([], false));

    expect(devices(report)).toEqual([]);
    expect(renderReadinessReport(report)).not.toContain("GPUs:");
  });

  it.each([
    ["stale", { completedAt: new Date(NOW.getTime() - 30001).toISOString() }],
    ["failed", { failure: "GPU probe failed" }],
  ])("omits GPU inventory when collection is %s", (_state, overrides) => {
    const report = present({ ...collect(), ...overrides });

    expect(devices(report)).toEqual([]);
    expect(renderReadinessReport(report)).not.toContain(GPUS[1]!.name);
  });

  it("makes terminal controls in GPU names inert", () => {
    const report = present(collect([{ name: "NVIDIA\nGPU\u001b[31m", memoryMB: 97887 }]));

    expect(devices(report)[0]?.details?.name).toBe("NVIDIA\\u000aGPU\\u001b[31m");
    expect(renderReadinessReport(report)).toContain("NVIDIA\\u000aGPU\\u001b[31m");
    expect(renderReadinessReport(report)).not.toContain("\u001b");
  });

  it("keeps the memory size visible when a GPU name exceeds the report limit", () => {
    const report = present(collect([{ name: "NVIDIA ".repeat(200), memoryMB: 97887 }]));

    expect(String(devices(report)[0]?.details?.name).length).toBeLessThanOrEqual(512);
    expect(renderReadinessReport(report)).toContain("(97887 MiB)");
  });

  it("preserves the collected GPU inventory when detector objects change", () => {
    const gpus = GPUS.map((gpu) => ({ ...gpu }));
    const snapshot = collect(gpus);
    gpus[1]!.name = "changed";
    gpus[1]!.memoryMB = 1;

    expect(devices(present(snapshot))[1]?.details).toEqual({
      index: 1,
      name: GPUS[1]!.name,
      memoryBytes: 256703 * MIB,
    });
  });
});
