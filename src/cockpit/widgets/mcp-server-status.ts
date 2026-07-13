/**
 * Hosted MCP-server status widget (mt#2077).
 *
 * Answers: "Is the hosted MCP server serving the mesh, and at what cost?"
 *
 * Data-access is hybrid (per the mt#2075 design doc):
 *   - HTTPS probe to the hosted `/health` endpoint → liveness, uptime %,
 *     last-downtime, and the M1 anomaly.
 *   - First-party `@minsky/domain/deployment` (the code behind the
 *     `mcp__minsky__deployment_status` / `deployment_logs` tools) → current
 *     commit, last-deploy time/outcome (M2), and recent error log lines.
 *   - First-party Railway service-metrics (`getServiceMetrics()` /
 *     `getRestartCount()`, added by mt#2296) → CPU %, memory %, restart count,
 *     and anomalies M3 (restart loop) / M4 (resource near limit).
 *
 * History (mt#2077 → mt#2317): mt#2077 shipped the 7 reachable fields + M1–M2
 * and deferred the three Railway resource-metric fields (CPU %, memory %,
 * restart count) + M3/M4 because no domain-layer source existed (a local
 * cockpit process cannot invoke the external Railway MCP plugin). mt#2296
 * added first-party Railway service-metrics queries; mt#2317 (this change)
 * wires them in, filling those slots.
 *
 * Follows the `agents` widget's testable-factory pattern: pure logic lives in
 * `createMcpServerStatusWidget(deps)` with injectable IO; the real-wired export
 * `mcpServerStatusWidget` binds the live probe + deployment domain.
 */

import type { WidgetModule, WidgetContext, WidgetData } from "../types";
import type { DeploymentStatus } from "@minsky/domain/deployment";
import {
  PROBE_HISTORY_WINDOW_MS,
  appendSample,
  consecutiveFailureMs,
  healthFailing,
  lastDowntime,
  readProbeHistory,
  uptimePct,
  writeProbeHistory,
  type ProbeHistory,
} from "../mcp-probe-history";

/** Hosted MCP server health endpoint (verified during mt#2075 planning). */
export const HOSTED_MCP_HEALTH_URL = "https://minsky-mcp-production.up.railway.app/health";

/** Service name whose deploy.config.ts declares the hosted MCP deployment. */
export const HOSTED_MCP_SERVICE = "minsky-mcp";

/** Probe request timeout. */
const PROBE_TIMEOUT_MS = 5000;

/** How many recent error log lines to surface. */
const RECENT_ERRORS_LIMIT = 5;

/**
 * M3 (restart loop): restart count in the last 1 hour exceeding this fires the
 * anomaly. Source: mt#2075 design doc ("Restart count >3 in last hour").
 */
const M3_RESTART_1H_THRESHOLD = 3;
const M3_RESTART_WINDOW_HOURS = 1;

/** Window (hours) for the displayed restart-count field. */
const RESTART_DISPLAY_WINDOW_HOURS = 24;

/**
 * M4 (resource near limit): latest CPU % or memory % at/above this fires the
 * anomaly. Source: mt#2075 design doc ("CPU >80% ... OR memory >80%"). The
 * design doc specifies CPU "sustained 5 min"; v1 uses point-in-time (latest
 * sample) — sustained-window tracking is a documented follow-up (mt#2317 spec).
 */
const M4_RESOURCE_PCT_THRESHOLD = 80;

// ---------------------------------------------------------------------------
// Payload shape (consumed by McpServerStatus.tsx)
// ---------------------------------------------------------------------------

export interface McpServerStatusPayload {
  health: {
    ok: boolean;
    statusCode: number | null;
    lastProbeAt: string;
    /** ms the hosted /health has been continuously non-200 (0 when healthy). */
    consecutiveFailureMs: number;
  };
  lastDowntimeAt: string | null;
  uptime24hPct: number | null;
  deploy: {
    commitHash: string | null;
    commitMessage: string | null;
    lastDeployAt: string | null;
    status: DeploymentStatus;
  } | null;
  recentErrors: string[];
  /**
   * Railway resource snapshot (mt#2317). Null when the metrics source is
   * unavailable (cockpit outside the repo, Railway auth missing, adapter
   * without metric support) — degrades independently of `deploy`.
   */
  metrics: {
    /** Latest CPU utilization, 0..100, or null. */
    cpuPercent: number | null;
    /** Latest memory utilization, 0..100, or null. */
    memoryPercent: number | null;
    /** Restart count over the last 24h (displayed field). */
    restartCount24h: number | null;
  } | null;
  anomalies: {
    /** M1 — hosted /health non-200 for >60s. */
    m1HealthFailing: boolean;
    /** M2 — latest deploy outcome is not SUCCESS. */
    m2DeployFailed: boolean;
    /** M3 — restart count in the last 1h exceeds the threshold (crash loop). */
    m3RestartLoop: boolean;
    /** M4 — latest CPU % or memory % at/above the near-limit threshold. */
    m4ResourceNearLimit: boolean;
  };
}

export interface ProbeResult {
  ok: boolean;
  statusCode: number | null;
}

export interface DeploymentData {
  commitHash: string | null;
  commitMessage: string | null;
  lastDeployAt: string | null;
  status: DeploymentStatus;
  recentErrors: string[];
}

/**
 * Raw metric bits the widget needs: the latest CPU/memory snapshot plus restart
 * counts for the display window (24h) and the M3 anomaly window (1h). Produced
 * by the metrics dep seam; reduced to the payload `metrics` shape + M3/M4.
 */
export interface MetricsData {
  cpuPercent: number | null;
  memoryPercent: number | null;
  restartCount24h: number | null;
  restartCount1h: number | null;
}

/** Injectable IO seams — real implementations wired in the export below. */
export interface McpServerStatusDeps {
  /** Probe the hosted /health endpoint. Must resolve (never reject). */
  probeHealth: () => Promise<ProbeResult>;
  /** Fetch deploy state + recent errors, or null when unavailable. */
  getDeploymentData: () => Promise<DeploymentData | null>;
  /** Fetch Railway resource metrics + restart counts, or null when unavailable. */
  getMetricsData: () => Promise<MetricsData | null>;
  readHistory: () => ProbeHistory;
  writeHistory: (history: ProbeHistory) => void;
  now: () => number;
}

// ---------------------------------------------------------------------------
// Widget factory
// ---------------------------------------------------------------------------

export function createMcpServerStatusWidget(deps: McpServerStatusDeps): WidgetModule {
  return {
    id: "mcp-server-status",
    title: "MCP Server",
    updateMode: { type: "polling", intervalMs: 30_000 },
    async fetch(_ctx: WidgetContext): Promise<WidgetData> {
      try {
        const now = deps.now();
        const nowIso = new Date(now).toISOString();

        // 1. Liveness probe → update + persist rolling history.
        const probe = await deps.probeHealth();
        const history = appendSample(
          deps.readHistory(),
          { at: nowIso, ok: probe.ok, statusCode: probe.statusCode },
          PROBE_HISTORY_WINDOW_MS,
          now
        );
        deps.writeHistory(history);

        const m1HealthFailing = healthFailing(history, now);

        // 2. Deploy state + recent errors (degrades to null on any failure).
        let deployment: DeploymentData | null = null;
        try {
          deployment = await deps.getDeploymentData();
        } catch {
          deployment = null;
        }

        const m2DeployFailed = deployment !== null && deployment.status !== "SUCCESS";

        // 3. Railway resource metrics + restart counts (degrades to null on any
        //    failure, independently of deploy state — a metrics outage must not
        //    blank health/deploy or crash the widget).
        let metrics: MetricsData | null = null;
        try {
          metrics = await deps.getMetricsData();
        } catch {
          metrics = null;
        }

        // M3 — crash loop: restart count in the last 1h exceeds the threshold.
        const m3RestartLoop =
          metrics !== null &&
          metrics.restartCount1h !== null &&
          metrics.restartCount1h > M3_RESTART_1H_THRESHOLD;

        // M4 — resource near limit: latest CPU % or memory % at/above threshold.
        // Finite-guard the percentages: a non-finite value from the adapter must
        // not trip a false anomaly (it renders as "—", not NaN%).
        const m4ResourceNearLimit =
          metrics !== null &&
          ((metrics.cpuPercent !== null &&
            Number.isFinite(metrics.cpuPercent) &&
            metrics.cpuPercent >= M4_RESOURCE_PCT_THRESHOLD) ||
            (metrics.memoryPercent !== null &&
              Number.isFinite(metrics.memoryPercent) &&
              metrics.memoryPercent >= M4_RESOURCE_PCT_THRESHOLD));

        const payload: McpServerStatusPayload = {
          health: {
            ok: probe.ok,
            statusCode: probe.statusCode,
            lastProbeAt: nowIso,
            consecutiveFailureMs: consecutiveFailureMs(history, now),
          },
          lastDowntimeAt: lastDowntime(history),
          uptime24hPct: uptimePct(history, PROBE_HISTORY_WINDOW_MS, now),
          deploy: deployment
            ? {
                commitHash: deployment.commitHash,
                commitMessage: deployment.commitMessage,
                lastDeployAt: deployment.lastDeployAt,
                status: deployment.status,
              }
            : null,
          recentErrors: deployment?.recentErrors ?? [],
          metrics: metrics
            ? {
                cpuPercent: metrics.cpuPercent,
                memoryPercent: metrics.memoryPercent,
                restartCount24h: metrics.restartCount24h,
              }
            : null,
          anomalies: { m1HealthFailing, m2DeployFailed, m3RestartLoop, m4ResourceNearLimit },
        };

        return { state: "ok", payload };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { state: "degraded", reason: `mcp-server status error: ${message}` };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Real-wired implementations
// ---------------------------------------------------------------------------

/** HTTPS GET to the hosted /health with an abort timeout. Never rejects. */
async function probeHostedHealth(): Promise<ProbeResult> {
  try {
    const res = await fetch(HOSTED_MCP_HEALTH_URL, {
      method: "GET",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    return { ok: res.status === 200, statusCode: res.status };
  } catch {
    // Network failure / timeout / DNS — treat as a failed probe (drives M1).
    return { ok: false, statusCode: null };
  }
}

/**
 * Resolve the hosted MCP deployment via the first-party deployment domain and
 * project it onto the widget's DeploymentData shape. Returns null when the
 * deployment can't be resolved (e.g. cockpit running outside the repo, or
 * Railway auth unavailable).
 */
async function fetchHostedDeploymentData(): Promise<DeploymentData | null> {
  // Imported lazily so the cockpit doesn't pay the deployment-domain import cost
  // unless this (default-disabled) widget is actually enabled and polling.
  const deployment = await import("@minsky/domain/deployment");
  const { config } = await deployment.resolveDeploymentConfig(HOSTED_MCP_SERVICE);
  const adapter = deployment.resolveAdapter(config);

  const record = await adapter.getLatestDeploymentStatus();

  let recentErrors: string[] = [];
  try {
    const logs = await adapter.getDeploymentLogs(record.id, "deploy", 100);
    recentErrors = logs
      .filter((line) => line.severity.toLowerCase() === "error")
      .slice(-RECENT_ERRORS_LIMIT)
      .map((line) => line.message);
  } catch {
    // Logs are best-effort; deploy state still renders without them.
    recentErrors = [];
  }

  return {
    commitHash: record.commitHash,
    commitMessage: record.commitMessage,
    lastDeployAt: record.finishedAt ?? record.createdAt,
    status: record.status,
    recentErrors,
  };
}

/**
 * Resolve the hosted MCP service's Railway resource metrics + restart counts via
 * the first-party deployment domain (mt#2296). Returns null when the deployment
 * can't be resolved, or when the resolved adapter doesn't implement the optional
 * metric methods (they're optional on `DeploymentPlatformAdapter` because
 * resource-metric availability is platform-dependent).
 */
async function fetchHostedServiceMetrics(): Promise<MetricsData | null> {
  const deployment = await import("@minsky/domain/deployment");
  const { config } = await deployment.resolveDeploymentConfig(HOSTED_MCP_SERVICE);
  const adapter = deployment.resolveAdapter(config);

  // Optional adapter methods (mt#2296) — feature-detect before calling.
  if (!adapter.getServiceMetrics || !adapter.getRestartCount) {
    return null;
  }

  // Parallel (no waterfall): snapshot + both restart windows.
  const [snapshot, restarts24h, restarts1h] = await Promise.all([
    adapter.getServiceMetrics(),
    adapter.getRestartCount(RESTART_DISPLAY_WINDOW_HOURS),
    adapter.getRestartCount(M3_RESTART_WINDOW_HOURS),
  ]);

  return {
    cpuPercent: snapshot.cpuPercent,
    memoryPercent: snapshot.memoryPercent,
    restartCount24h: restarts24h.count,
    restartCount1h: restarts1h.count,
  };
}

export const mcpServerStatusWidget: WidgetModule = createMcpServerStatusWidget({
  probeHealth: probeHostedHealth,
  getDeploymentData: fetchHostedDeploymentData,
  getMetricsData: fetchHostedServiceMetrics,
  readHistory: readProbeHistory,
  writeHistory: writeProbeHistory,
  now: () => Date.now(),
});
