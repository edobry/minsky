/**
 * Unit tests for the hosted MCP-server status widget (mt#2077).
 *
 * Exercises createMcpServerStatusWidget() with injected IO seams so the probe,
 * deployment domain, and history store are all faked — no network, no Railway.
 * Covers the v1 acceptance behaviors: healthy render (7 fields), M1 (health
 * failing >60s), M2 (failed deploy), graceful degradation.
 */

import { describe, test, expect } from "bun:test";
import {
  createMcpServerStatusWidget,
  type DeploymentData,
  type McpServerStatusDeps,
  type McpServerStatusPayload,
  type MetricsData,
  type ProbeResult,
} from "./mcp-server-status";
import type { ProbeHistory, ProbeSample } from "../mcp-probe-history";

const WIDGET_ID = "mcp-server-status";
const NOW = 1_000_000_000;
const SECOND = 1000;

function isoAt(offsetMs: number): string {
  return new Date(NOW + offsetMs).toISOString();
}

function makeDeps(over: Partial<McpServerStatusDeps> = {}): {
  deps: McpServerStatusDeps;
  written: { current: ProbeHistory };
} {
  const written = { current: { samples: [] as ProbeSample[] } as ProbeHistory };
  const deps: McpServerStatusDeps = {
    probeHealth: async (): Promise<ProbeResult> => ({ ok: true, statusCode: 200 }),
    getDeploymentData: async (): Promise<DeploymentData | null> => null,
    getMetricsData: async (): Promise<MetricsData | null> => null,
    readHistory: () => ({ samples: [] }),
    writeHistory: (h) => {
      written.current = h;
    },
    now: () => NOW,
    ...over,
  };
  return { deps, written };
}

async function run(deps: McpServerStatusDeps): Promise<McpServerStatusPayload> {
  const widget = createMcpServerStatusWidget(deps);
  const data = await widget.fetch({ id: WIDGET_ID });
  expect(data.state).toBe("ok");
  if (data.state !== "ok") throw new Error("expected ok");
  return data.payload as McpServerStatusPayload;
}

function healthyDeploy(): DeploymentData {
  return {
    commitHash: "abcdef1234567890",
    commitMessage: "feat: ship it",
    lastDeployAt: isoAt(-5 * 60 * SECOND),
    status: "SUCCESS",
    recentErrors: [],
  };
}

describe("widget identity", () => {
  test("declares id, title, and 30s polling", () => {
    const widget = createMcpServerStatusWidget(makeDeps().deps);
    expect(widget.id).toBe(WIDGET_ID);
    expect(widget.updateMode).toEqual({ type: "polling", intervalMs: 30_000 });
  });
});

describe("healthy state (acceptance test 1)", () => {
  test("renders all 7 reachable fields with no anomalies", async () => {
    const { deps } = makeDeps({
      probeHealth: async () => ({ ok: true, statusCode: 200 }),
      getDeploymentData: async () => healthyDeploy(),
    });
    const payload = await run(deps);

    // Field 1: health ping
    expect(payload.health.ok).toBe(true);
    expect(payload.health.statusCode).toBe(200);
    // Field 2: last downtime — none yet
    expect(payload.lastDowntimeAt).toBeNull();
    // Field 3: uptime — 100% (single ok sample)
    expect(payload.uptime24hPct).toBe(100);
    // Fields 4-6: deploy commit / time / outcome
    expect(payload.deploy?.commitHash).toBe("abcdef1234567890");
    expect(payload.deploy?.status).toBe("SUCCESS");
    expect(payload.deploy?.lastDeployAt).toBe(isoAt(-5 * 60 * SECOND));
    // Field 7: recent errors
    expect(payload.recentErrors).toEqual([]);
    // No anomalies
    expect(payload.anomalies).toEqual({
      m1HealthFailing: false,
      m2DeployFailed: false,
      m3RestartLoop: false,
      m4ResourceNearLimit: false,
    });
  });

  test("persists the probe sample to history", async () => {
    const { deps, written } = makeDeps({
      probeHealth: async () => ({ ok: true, statusCode: 200 }),
    });
    await run(deps);
    expect(written.current.samples.length).toBe(1);
    expect(written.current.samples[0]?.ok).toBe(true);
  });
});

describe("M1 — health-check failing (acceptance test 2)", () => {
  test("a single fresh failure does NOT fire M1 (<60s)", async () => {
    const { deps } = makeDeps({
      probeHealth: async () => ({ ok: false, statusCode: null }),
      readHistory: () => ({ samples: [] }),
    });
    const payload = await run(deps);
    expect(payload.health.ok).toBe(false);
    expect(payload.anomalies.m1HealthFailing).toBe(false);
  });

  test("fires M1 once the failing run exceeds 60s", async () => {
    const { deps } = makeDeps({
      probeHealth: async () => ({ ok: false, statusCode: 503 }),
      // Prior failures starting 70s ago; the current probe extends the run.
      readHistory: () => ({
        samples: [
          { at: isoAt(-70 * SECOND), ok: false, statusCode: 503 },
          { at: isoAt(-40 * SECOND), ok: false, statusCode: 503 },
        ],
      }),
    });
    const payload = await run(deps);
    expect(payload.anomalies.m1HealthFailing).toBe(true);
    expect(payload.health.consecutiveFailureMs).toBe(70 * SECOND);
    expect(payload.lastDowntimeAt).toBe(isoAt(0));
  });

  test("does not crash when deployment data is unavailable during an outage", async () => {
    const { deps } = makeDeps({
      probeHealth: async () => ({ ok: false, statusCode: null }),
      getDeploymentData: async () => {
        throw new Error("railway unreachable");
      },
    });
    const payload = await run(deps);
    expect(payload.deploy).toBeNull();
    expect(payload.recentErrors).toEqual([]);
    expect(payload.health.ok).toBe(false);
  });
});

describe("M2 — recent deploy failed (acceptance test 3)", () => {
  test("fires M2 when the latest deploy outcome is not SUCCESS", async () => {
    const { deps } = makeDeps({
      probeHealth: async () => ({ ok: true, statusCode: 200 }),
      getDeploymentData: async () => ({ ...healthyDeploy(), status: "FAILED" }),
    });
    const payload = await run(deps);
    expect(payload.anomalies.m2DeployFailed).toBe(true);
    expect(payload.deploy?.status).toBe("FAILED");
  });

  test("does not fire M2 when there is no deployment data", async () => {
    const { deps } = makeDeps({ getDeploymentData: async () => null });
    const payload = await run(deps);
    expect(payload.anomalies.m2DeployFailed).toBe(false);
    expect(payload.deploy).toBeNull();
  });

  test("surfaces recent error log lines from the deployment", async () => {
    const { deps } = makeDeps({
      getDeploymentData: async () => ({
        ...healthyDeploy(),
        recentErrors: ["boom one", "boom two"],
      }),
    });
    const payload = await run(deps);
    expect(payload.recentErrors).toEqual(["boom one", "boom two"]);
  });
});

describe("graceful degradation", () => {
  test("returns degraded (not a throw) when an injected seam throws unexpectedly", async () => {
    const { deps } = makeDeps({
      readHistory: () => {
        throw new Error("disk gone");
      },
    });
    const widget = createMcpServerStatusWidget(deps);
    const data = await widget.fetch({ id: WIDGET_ID });
    expect(data.state).toBe("degraded");
    if (data.state !== "degraded") throw new Error("expected degraded");
    expect(data.reason).toContain("disk gone");
  });
});

// ---------------------------------------------------------------------------
// Railway metrics + M3/M4 (mt#2317)
// ---------------------------------------------------------------------------

function metrics(over: Partial<MetricsData> = {}): MetricsData {
  return {
    cpuPercent: 1,
    memoryPercent: 2,
    restartCount24h: 0,
    restartCount1h: 0,
    ...over,
  };
}

describe("Railway metrics fields + M3/M4 (mt#2317)", () => {
  test("M3 fires when the 1h restart count exceeds 3; M4 fires on memory >=80", async () => {
    const { deps } = makeDeps({
      getMetricsData: async () =>
        metrics({ cpuPercent: 50, memoryPercent: 90, restartCount24h: 5, restartCount1h: 4 }),
    });
    const payload = await run(deps);

    expect(payload.metrics).toEqual({
      cpuPercent: 50,
      memoryPercent: 90,
      restartCount24h: 5,
    });
    expect(payload.anomalies.m4ResourceNearLimit).toBe(true); // memory 90 >= 80
    expect(payload.anomalies.m3RestartLoop).toBe(true); // 1h count 4 > 3
  });

  test("M4 fires on CPU >=80; M3 stays off when the 1h count is within bound", async () => {
    const { deps } = makeDeps({
      getMetricsData: async () =>
        metrics({ cpuPercent: 85, memoryPercent: 10, restartCount24h: 6, restartCount1h: 2 }),
    });
    const payload = await run(deps);

    expect(payload.anomalies.m4ResourceNearLimit).toBe(true); // CPU 85 >= 80
    // 1h count 2 <= 3 even though the 24h display count is 6.
    expect(payload.anomalies.m3RestartLoop).toBe(false);
    expect(payload.metrics?.restartCount24h).toBe(6);
  });

  test("neither M3 nor M4 fires on low metrics, but the fields still populate", async () => {
    const { deps } = makeDeps({
      getMetricsData: async () =>
        metrics({ cpuPercent: 1, memoryPercent: 2, restartCount24h: 0, restartCount1h: 0 }),
    });
    const payload = await run(deps);

    expect(payload.anomalies.m3RestartLoop).toBe(false);
    expect(payload.anomalies.m4ResourceNearLimit).toBe(false);
    expect(payload.metrics).toEqual({ cpuPercent: 1, memoryPercent: 2, restartCount24h: 0 });
  });

  test("metrics degrade to null independently — deploy + health still render", async () => {
    const { deps } = makeDeps({
      probeHealth: async () => ({ ok: true, statusCode: 200 }),
      getDeploymentData: async () => healthyDeploy(),
      getMetricsData: async () => {
        throw new Error("railway metrics unreachable");
      },
    });
    const payload = await run(deps);

    expect(payload.metrics).toBeNull();
    expect(payload.anomalies.m3RestartLoop).toBe(false);
    expect(payload.anomalies.m4ResourceNearLimit).toBe(false);
    // Independent degradation: deploy + health are intact.
    expect(payload.deploy?.status).toBe("SUCCESS");
    expect(payload.health.ok).toBe(true);
  });

  test("null percentages do not fire M4 (no datapoints)", async () => {
    const { deps } = makeDeps({
      getMetricsData: async () =>
        metrics({
          cpuPercent: null,
          memoryPercent: null,
          restartCount24h: null,
          restartCount1h: null,
        }),
    });
    const payload = await run(deps);

    expect(payload.anomalies.m4ResourceNearLimit).toBe(false);
    expect(payload.anomalies.m3RestartLoop).toBe(false);
    expect(payload.metrics).toEqual({
      cpuPercent: null,
      memoryPercent: null,
      restartCount24h: null,
    });
  });

  test("non-finite percentages do not trip a false M4", async () => {
    const { deps } = makeDeps({
      getMetricsData: async () =>
        metrics({ cpuPercent: Number.NaN, memoryPercent: Number.POSITIVE_INFINITY }),
    });
    const payload = await run(deps);

    expect(payload.anomalies.m4ResourceNearLimit).toBe(false);
  });
});
