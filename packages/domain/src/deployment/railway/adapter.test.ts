import { describe, expect, test } from "bun:test";

import {
  computeMetricsSnapshot,
  deriveRestartCount,
  notifyStatusObserved,
  railwayAdapterFactory,
  RailwayDeploymentAdapter,
} from "./adapter";
import type { DeploymentConfig } from "../config";
import type { DeploymentRecord } from "../types";
import type { RailwayDeploymentNode, RailwayMetricSeries } from "./graphql-client";

describe("railwayAdapterFactory", () => {
  test("builds a RailwayDeploymentAdapter from a railway config", () => {
    const config: DeploymentConfig = {
      platform: "railway",
      railway: { projectId: "p", environmentId: "e", serviceId: "s" },
    };
    const adapter = railwayAdapterFactory(config);
    expect(adapter).toBeInstanceOf(RailwayDeploymentAdapter);
  });

  test("throws when called with a non-railway platform", () => {
    const config = {
      platform: "vercel",
      vercel: {},
    } as unknown as DeploymentConfig;

    expect(() => railwayAdapterFactory(config)).toThrow(/non-railway/);
  });
});

// ---------------------------------------------------------------------------
// computeMetricsSnapshot (mt#2296)
// ---------------------------------------------------------------------------

function series(measurement: string, values: [number, number][]): RailwayMetricSeries {
  return { measurement, values: values.map(([ts, value]) => ({ ts, value })) };
}

describe("computeMetricsSnapshot", () => {
  test("derives CPU% and memory% from usage/limit, picking the latest datapoint", () => {
    const snap = computeMetricsSnapshot([
      series("CPU_USAGE", [
        [100, 0.5],
        [200, 2], // latest
      ]),
      series("CPU_LIMIT", [
        [100, 8],
        [200, 8],
      ]),
      series("MEMORY_USAGE_GB", [[200, 0.5]]),
      series("MEMORY_LIMIT_GB", [[200, 2]]),
    ]);
    expect(snap.cpuPercent).toBeCloseTo(25); // 2 / 8 * 100
    expect(snap.memoryPercent).toBeCloseTo(25); // 0.5 / 2 * 100
    expect(snap.cpuUsageVCpu).toBe(2);
    expect(snap.cpuLimitVCpu).toBe(8);
    expect(snap.memoryUsageGb).toBe(0.5);
    expect(snap.memoryLimitGb).toBe(2);
    expect(snap.sampledAt).toBe(new Date(200 * 1000).toISOString());
  });

  test("returns null percentage when a series is missing", () => {
    const snap = computeMetricsSnapshot([
      series("CPU_USAGE", [[100, 1]]),
      series("CPU_LIMIT", [[100, 4]]),
      // no memory series
    ]);
    expect(snap.cpuPercent).toBeCloseTo(25);
    expect(snap.memoryPercent).toBeNull();
    expect(snap.memoryUsageGb).toBeNull();
    expect(snap.memoryLimitGb).toBeNull();
  });

  test("returns null percentage on a zero limit (no divide-by-zero)", () => {
    const snap = computeMetricsSnapshot([
      series("CPU_USAGE", [[100, 1]]),
      series("CPU_LIMIT", [[100, 0]]),
    ]);
    expect(snap.cpuPercent).toBeNull();
    expect(snap.cpuUsageVCpu).toBe(1);
    expect(snap.cpuLimitVCpu).toBe(0);
  });

  test("returns all-null on empty input", () => {
    const snap = computeMetricsSnapshot([]);
    expect(snap.cpuPercent).toBeNull();
    expect(snap.memoryPercent).toBeNull();
    expect(snap.sampledAt).toBeNull();
  });

  test("ignores an empty values array for a present series", () => {
    const snap = computeMetricsSnapshot([series("CPU_USAGE", []), series("CPU_LIMIT", [[100, 8]])]);
    expect(snap.cpuPercent).toBeNull();
    expect(snap.cpuUsageVCpu).toBeNull();
    expect(snap.cpuLimitVCpu).toBe(8);
  });
});

// ---------------------------------------------------------------------------
// deriveRestartCount (mt#2296)
// ---------------------------------------------------------------------------

function node(id: string, status: string, createdAt: string): RailwayDeploymentNode {
  return { id, status, createdAt };
}

describe("deriveRestartCount", () => {
  const now = Date.parse("2026-06-04T12:00:00.000Z");

  test("counts deployments created within the window and breaks down by status", () => {
    const nodes = [
      node("a", "SUCCESS", "2026-06-04T11:00:00.000Z"), // in window
      node("b", "FAILED", "2026-06-04T10:00:00.000Z"), // in window
      node("c", "FAILED", "2026-06-04T09:00:00.000Z"), // in window
      node("d", "SUCCESS", "2026-06-02T09:00:00.000Z"), // outside 24h
    ];
    const result = deriveRestartCount(nodes, 24, now);
    expect(result.count).toBe(3);
    expect(result.windowHours).toBe(24);
    expect(result.since).toBe(new Date(now - 24 * 3600 * 1000).toISOString());
    expect(result.byStatus.SUCCESS).toBe(1);
    expect(result.byStatus.FAILED).toBe(2);
  });

  test("respects a custom window", () => {
    const nodes = [
      node("a", "SUCCESS", "2026-06-04T11:30:00.000Z"), // within 1h
      node("b", "FAILED", "2026-06-04T10:30:00.000Z"), // outside 1h
    ];
    const result = deriveRestartCount(nodes, 1, now);
    expect(result.count).toBe(1);
    expect(result.byStatus.SUCCESS).toBe(1);
    expect(result.byStatus.FAILED).toBeUndefined();
  });

  test("ignores nodes with an unparseable createdAt", () => {
    const nodes = [
      node("a", "SUCCESS", "not-a-date"),
      node("b", "SUCCESS", "2026-06-04T11:00:00.000Z"),
    ];
    const result = deriveRestartCount(nodes, 24, now);
    expect(result.count).toBe(1);
  });

  test("returns an empty breakdown when nothing is in window", () => {
    const result = deriveRestartCount([node("a", "SUCCESS", "2020-01-01T00:00:00.000Z")], 24, now);
    expect(result.count).toBe(0);
    expect(result.byStatus).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// notifyStatusObserved (mt#2599) — best-effort onStatusObserved invocation
// ---------------------------------------------------------------------------

function deploymentRecord(status: DeploymentRecord["status"]): DeploymentRecord {
  return {
    id: "dep-1",
    status,
    commitHash: "abc123",
    commitMessage: "test commit",
    createdAt: "2026-01-01T00:00:00Z",
    finishedAt: null,
    durationMs: null,
    url: null,
  };
}

describe("notifyStatusObserved", () => {
  test("is a no-op when onStatusObserved is undefined", async () => {
    await expect(
      notifyStatusObserved(undefined, deploymentRecord("BUILDING"))
    ).resolves.toBeUndefined();
  });

  test("invokes the callback with the observed record", async () => {
    const seen: DeploymentRecord[] = [];
    await notifyStatusObserved((record) => {
      seen.push(record);
    }, deploymentRecord("BUILDING"));
    expect(seen).toHaveLength(1);
    expect(seen[0]?.status).toBe("BUILDING");
  });

  test("awaits an async callback", async () => {
    let resolved = false;
    await notifyStatusObserved(async () => {
      await Promise.resolve();
      resolved = true;
    }, deploymentRecord("DEPLOYING"));
    expect(resolved).toBe(true);
  });

  test("swallows a synchronously-thrown callback error (best-effort)", async () => {
    await expect(
      notifyStatusObserved(() => {
        throw new Error("boom");
      }, deploymentRecord("BUILDING"))
    ).resolves.toBeUndefined();
  });

  test("swallows a rejected async callback (best-effort)", async () => {
    await expect(
      notifyStatusObserved(async () => {
        throw new Error("async boom");
      }, deploymentRecord("SUCCESS"))
    ).resolves.toBeUndefined();
  });
});
