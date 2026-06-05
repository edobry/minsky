/**
 * Railway implementation of `DeploymentPlatformAdapter`. v1 concrete adapter
 * for the platform-agnostic abstraction defined in
 * docs/deployment-platforms.md.
 *
 * Uses the Railway GraphQL primitives in ./graphql-client.ts (extracted from
 * scripts/railway/{status,logs}.ts in mt#1730). No fresh shell-out to the
 * `railway` CLI is introduced.
 *
 * Tracking task: mt#1730.
 */

import { injectable } from "tsyringe";

import type { DeploymentConfig, RailwayDeploymentConfig } from "../config";
import {
  type DeploymentPlatformAdapter,
  type DeploymentRecord,
  type DeploymentStatus,
  DeploymentWaitTimeoutError,
  isTerminalStatus,
  type LogLine,
  type LogType,
  type RestartCountResult,
  type ServiceMetricsSnapshot,
  type WaitForLatestOptions,
} from "../types";
import {
  fetchBuildLogs,
  fetchDeploymentById,
  fetchDeploymentLogs,
  fetchDeployments,
  fetchServiceMetrics,
  getValidRailwayToken,
  type RailwayDeploymentNode,
  type RailwayMetricDatapoint,
  type RailwayMetricSeries,
  SERVICE_METRIC_MEASUREMENTS,
} from "./graphql-client";

const DEFAULT_TIMEOUT_SECONDS = 600;
const DEFAULT_POLL_INTERVAL_SECONDS = 10;
const DEFAULT_LOG_LINES = 100;

/** Trailing window for a resource-metrics snapshot. We only need the latest
 * datapoint, but Railway requires a startDate; one hour gives a few buckets
 * of headroom so a freshly-deployed service still returns at least one sample. */
const METRICS_WINDOW_MS = 60 * 60 * 1000;
/** Sample bucket size for the metrics query (5 min — matches Railway's default granularity). */
const METRICS_SAMPLE_RATE_SECONDS = 300;
/** Default trailing window for restart counting. */
const DEFAULT_RESTART_WINDOW_HOURS = 24;
/** Upper bound on deployment records fetched for restart derivation. A
 * crash-looping service can produce many records; 100 covers a 24h window
 * with wide margin while bounding the query cost. */
const RESTART_FETCH_LIMIT = 100;

/**
 * Railway-native status → normalized DeploymentStatus.
 * See docs/deployment-platforms.md for the table.
 */
function normalizeStatus(railwayStatus: string): DeploymentStatus {
  switch (railwayStatus.toUpperCase()) {
    case "SUCCESS":
      return "SUCCESS";
    case "FAILED":
      return "FAILED";
    case "CRASHED":
      return "CRASHED";
    case "BUILDING":
    case "INITIALIZING":
    case "WAITING":
      return "BUILDING";
    case "DEPLOYING":
      return "DEPLOYING";
    case "REMOVED":
      return "CANCELLED";
    case "ERROR":
      return "FAILED";
    default:
      return "UNKNOWN";
  }
}

/**
 * Best-effort Railway deployment URL. Railway exposes a `staticUrl` on
 * deployment nodes; when absent, return null.
 */
function deploymentUrl(node: RailwayDeploymentNode): string | null {
  return node.staticUrl ?? null;
}

function toRecord(node: RailwayDeploymentNode): DeploymentRecord {
  const status = normalizeStatus(node.status);
  const createdAt = node.createdAt;
  // Railway does not currently expose a finishedAt on the node; durationMs is
  // unknown until the platform exposes it.
  return {
    id: node.id,
    status,
    commitHash: node.meta?.commitHash ?? null,
    commitMessage: node.meta?.commitMessage ?? null,
    createdAt,
    finishedAt: null,
    durationMs: null,
    url: deploymentUrl(node),
  };
}

/**
 * Latest (max-`ts`) datapoint for a measurement series, or null when the
 * series is absent or empty.
 */
function latestDatapoint(
  series: RailwayMetricSeries[],
  measurement: string
): RailwayMetricDatapoint | null {
  const found = series.find((s) => s.measurement === measurement);
  if (!found) {
    return null;
  }
  let latest: RailwayMetricDatapoint | null = null;
  for (const v of found.values) {
    if (latest === null || v.ts >= latest.ts) {
      latest = v;
    }
  }
  return latest;
}

/**
 * Derive a normalized utilization snapshot from raw Railway metric series.
 * Pure — exported for direct unit testing without a live API. CPU% and
 * memory% are usage/limit ratios; a missing series or a zero/absent limit
 * yields null for that percentage (no divide-by-zero).
 */
export function computeMetricsSnapshot(series: RailwayMetricSeries[]): ServiceMetricsSnapshot {
  const cpuUsage = latestDatapoint(series, "CPU_USAGE");
  const cpuLimit = latestDatapoint(series, "CPU_LIMIT");
  const memUsage = latestDatapoint(series, "MEMORY_USAGE_GB");
  const memLimit = latestDatapoint(series, "MEMORY_LIMIT_GB");

  const cpuPercent =
    cpuUsage && cpuLimit && cpuLimit.value > 0 ? (cpuUsage.value / cpuLimit.value) * 100 : null;
  const memoryPercent =
    memUsage && memLimit && memLimit.value > 0 ? (memUsage.value / memLimit.value) * 100 : null;

  const usageTimestamps = [cpuUsage?.ts, memUsage?.ts].filter(
    (t): t is number => typeof t === "number"
  );
  const sampledAt =
    usageTimestamps.length > 0 ? new Date(Math.max(...usageTimestamps) * 1000).toISOString() : null;

  return {
    cpuPercent,
    memoryPercent,
    cpuUsageVCpu: cpuUsage?.value ?? null,
    cpuLimitVCpu: cpuLimit?.value ?? null,
    memoryUsageGb: memUsage?.value ?? null,
    memoryLimitGb: memLimit?.value ?? null,
    sampledAt,
  };
}

/**
 * Derive a restart count + per-status breakdown from a list of deployment
 * nodes. Pure — exported for direct unit testing. A "restart" is a deployment
 * record created within the trailing window (see {@link RestartCountResult}
 * for the coverage boundary). `nowMs` is injected so tests are deterministic.
 */
export function deriveRestartCount(
  nodes: RailwayDeploymentNode[],
  windowHours: number,
  nowMs: number
): RestartCountResult {
  const sinceMs = nowMs - windowHours * 60 * 60 * 1000;
  const since = new Date(sinceMs).toISOString();
  const byStatus: Partial<Record<DeploymentStatus, number>> = {};
  let count = 0;
  for (const node of nodes) {
    const createdMs = Date.parse(node.createdAt);
    if (Number.isNaN(createdMs) || createdMs < sinceMs) {
      continue;
    }
    count++;
    const status = normalizeStatus(node.status);
    byStatus[status] = (byStatus[status] ?? 0) + 1;
  }
  return { count, windowHours, since, byStatus };
}

@injectable()
export class RailwayDeploymentAdapter implements DeploymentPlatformAdapter {
  constructor(private readonly config: RailwayDeploymentConfig) {}

  async getLatestDeploymentStatus(): Promise<DeploymentRecord> {
    const token = await getValidRailwayToken();
    const deployments = await fetchDeployments(this.config.serviceId, 1, token);
    const latest = deployments[0];
    if (!latest) {
      throw new Error(
        `No deployments found for Railway service ${this.config.serviceId}. ` +
          "Has the service deployed at least once?"
      );
    }
    return toRecord(latest);
  }

  async waitForLatestDeployment(options?: WaitForLatestOptions): Promise<DeploymentRecord> {
    const timeoutSeconds = options?.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
    const pollIntervalSeconds = options?.pollIntervalSeconds ?? DEFAULT_POLL_INTERVAL_SECONDS;
    const deadline = Date.now() + timeoutSeconds * 1000;

    // Identify the deployment we're waiting on at start time. If a new
    // deployment kicks off mid-wait (e.g., another push) we will still be
    // tracking the one that was latest at call time — by design, since the
    // caller's intent is "the deploy I just pushed."
    const token = await getValidRailwayToken();
    const initial = await fetchDeployments(this.config.serviceId, 1, token);
    const initialNode = initial[0];
    if (!initialNode) {
      throw new Error(
        `No deployments found for Railway service ${this.config.serviceId}. ` +
          "Cannot wait — has the service deployed at least once?"
      );
    }
    const targetId = initialNode.id;

    let lastRecord: DeploymentRecord = toRecord(initialNode);
    if (isTerminalStatus(lastRecord.status)) {
      return lastRecord;
    }

    while (Date.now() < deadline) {
      await sleep(pollIntervalSeconds * 1000);

      // Fetch the targeted deployment by ID directly, so we don't depend on
      // it remaining in the service's most-recent-N deployments window —
      // high-frequency deploys would otherwise cause it to fall out of view
      // while still in progress and trip a false-CANCELLED.
      const found = await fetchDeploymentById(targetId, token);
      if (!found) {
        // Railway returned no record for this deployment ID. This is genuinely
        // unusual (deletion / retention) — surface as a typed error rather
        // than silently masking as CANCELLED. Caller can inspect lastRecord
        // for the last known state.
        throw new Error(
          `Railway deployment ${targetId} disappeared during waitForLatestDeployment. ` +
            `Last observed status: ${lastRecord.status}. The deployment may have been ` +
            `deleted; check the Railway dashboard.`
        );
      }
      lastRecord = toRecord(found);
      if (isTerminalStatus(lastRecord.status)) {
        return lastRecord;
      }
    }

    throw new DeploymentWaitTimeoutError(timeoutSeconds, lastRecord.status, lastRecord);
  }

  async getDeploymentLogs(
    deploymentId: string,
    type: LogType,
    lines: number = DEFAULT_LOG_LINES
  ): Promise<LogLine[]> {
    const token = await getValidRailwayToken();
    const entries =
      type === "build"
        ? await fetchBuildLogs(deploymentId, lines, token)
        : await fetchDeploymentLogs(deploymentId, lines, token);
    return entries.map((e) => ({
      timestamp: e.timestamp,
      severity: e.severity,
      message: e.message,
      attributes: e.attributes ?? [],
    }));
  }

  async getServiceMetrics(): Promise<ServiceMetricsSnapshot> {
    const token = await getValidRailwayToken();
    const startDate = new Date(Date.now() - METRICS_WINDOW_MS).toISOString();
    const series = await fetchServiceMetrics(
      this.config.serviceId,
      startDate,
      SERVICE_METRIC_MEASUREMENTS,
      token,
      METRICS_SAMPLE_RATE_SECONDS
    );
    return computeMetricsSnapshot(series);
  }

  async getRestartCount(
    windowHours: number = DEFAULT_RESTART_WINDOW_HOURS
  ): Promise<RestartCountResult> {
    const token = await getValidRailwayToken();
    const nodes = await fetchDeployments(this.config.serviceId, RESTART_FETCH_LIMIT, token);
    return deriveRestartCount(nodes, windowHours, Date.now());
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Adapter factory used by the registry. `config` is the discriminated union;
 * we narrow on the `platform` field and forward the railway-specific block.
 */
export function railwayAdapterFactory(config: DeploymentConfig): RailwayDeploymentAdapter {
  if (config.platform !== "railway") {
    throw new Error(
      `railwayAdapterFactory invoked with non-railway config (platform="${config.platform}")`
    );
  }
  return new RailwayDeploymentAdapter(config.railway);
}
