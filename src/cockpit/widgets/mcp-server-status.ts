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
 *
 * Scope note (mt#2077 v1): the three Railway resource-metric fields (CPU %,
 * memory %, restart count) and anomaly indicators M3/M4 are deferred to mt#2296,
 * which adds first-party Railway service-metrics queries to the domain client.
 * Those data points have no domain-layer source today — a local cockpit process
 * cannot invoke the external Railway MCP plugin. This widget ships the 7
 * reachable fields + M1–M2.
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
  anomalies: {
    /** M1 — hosted /health non-200 for >60s. */
    m1HealthFailing: boolean;
    /** M2 — latest deploy outcome is not SUCCESS. */
    m2DeployFailed: boolean;
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

/** Injectable IO seams — real implementations wired in the export below. */
export interface McpServerStatusDeps {
  /** Probe the hosted /health endpoint. Must resolve (never reject). */
  probeHealth: () => Promise<ProbeResult>;
  /** Fetch deploy state + recent errors, or null when unavailable. */
  getDeploymentData: () => Promise<DeploymentData | null>;
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
          anomalies: { m1HealthFailing, m2DeployFailed },
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

export const mcpServerStatusWidget: WidgetModule = createMcpServerStatusWidget({
  probeHealth: probeHostedHealth,
  getDeploymentData: fetchHostedDeploymentData,
  readHistory: readProbeHistory,
  writeHistory: writeProbeHistory,
  now: () => Date.now(),
});
