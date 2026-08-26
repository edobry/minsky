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

import { log } from "@minsky/shared/logger";
import type { DeploymentConfig, RailwayDeploymentConfig } from "../config";
import {
  type DeploymentPlatformAdapter,
  type DeploymentRecord,
  type DeploymentStatus,
  DeploymentWaitTimeoutError,
  NoDeploymentSinceError,
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

/**
 * Map a Railway node to the platform-neutral record.
 *
 * Exported for tests (mt#4583): this mapping is where `meta.imageDigest` was
 * being dropped, and a mapping with no test seam is a mapping whose omissions
 * are unobservable. Pure — no I/O — so testing it needs no patching.
 */
export function toRecord(node: RailwayDeploymentNode): DeploymentRecord {
  const status = normalizeStatus(node.status);
  const createdAt = node.createdAt;
  // Railway does not currently expose a finishedAt on the node; durationMs is
  // unknown until the platform exposes it.
  return {
    id: node.id,
    status,
    commitHash: node.meta?.commitHash ?? null,
    commitMessage: node.meta?.commitMessage ?? null,
    // mt#4583: already on the wire — the deployments query selects `meta` as a
    // whole JSON scalar, so the digest arrived and was discarded here. Typed
    // through the meta index signature; `unknown` is narrowed rather than cast
    // blind, because a platform that changes the field's shape should read as
    // absent rather than surface a non-string as an identity.
    imageDigest: typeof node.meta?.imageDigest === "string" ? node.meta.imageDigest : null,
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

  // Freshest datapoint across every series that fed this snapshot (usage and
  // limit are sampled on the same buckets in practice, but including all four
  // is robust to any series lagging).
  const sampleTimestamps = [cpuUsage?.ts, cpuLimit?.ts, memUsage?.ts, memLimit?.ts].filter(
    (t): t is number => typeof t === "number"
  );
  const sampledAt =
    sampleTimestamps.length > 0
      ? new Date(Math.max(...sampleTimestamps) * 1000).toISOString()
      : null;

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

/**
 * Parse a `notBefore` bound into epoch-ms, or null when unset (mt#3890).
 * Throws on a malformed value rather than degrading to "unset" — silently
 * dropping the bound would restore the exact hole it closes.
 */
export function parseNotBefore(value: string | undefined): number | null {
  if (value === undefined) return null;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    throw new Error(
      `waitForLatestDeployment: notBefore is not a valid ISO8601 timestamp: ${value}`
    );
  }
  return parsed;
}

export interface AcquireDeploymentOptions {
  /** Returns the service's newest deployment node, or undefined when it has none. */
  fetchNewest: () => Promise<RailwayDeploymentNode | undefined>;
  /** Epoch-ms lower bound; null disables the check (legacy "whatever is latest"). */
  notBeforeMs: number | null;
  /** The original ISO string, for the error message. */
  notBefore: string | undefined;
  timeoutSeconds: number;
  /** Epoch-ms deadline. */
  deadlineMs: number;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  pollIntervalMs: number;
}

/**
 * Acquire the deployment a wait should track.
 *
 * With `notBeforeMs` set, a deployment created before the bound does NOT
 * qualify — the caller is verifying that a specific merge deployed, and a
 * pre-existing record is evidence of the opposite. Polls until one appears or
 * the deadline passes, then throws {@link NoDeploymentSinceError} carrying the
 * newest record actually seen so the caller can say how stale the service is.
 *
 * Extracted with injected fetch/clock/sleep so the loop is testable without
 * patching module imports (`testing-standards.mdc §Testable Design`).
 */
export async function acquireDeploymentAtOrAfter(
  options: AcquireDeploymentOptions
): Promise<RailwayDeploymentNode | undefined> {
  let node = await options.fetchNewest();
  if (options.notBeforeMs === null) return node;

  let newestSeen = node;
  while (!node || Date.parse(node.createdAt) < options.notBeforeMs) {
    if (options.now() >= options.deadlineMs) {
      throw new NoDeploymentSinceError(
        options.notBefore as string,
        options.timeoutSeconds,
        newestSeen ? toRecord(newestSeen) : null
      );
    }
    await options.sleep(options.pollIntervalMs);
    node = await options.fetchNewest();
    if (node) newestSeen = node;
  }
  return node;
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

    // mt#3890: with `notBefore`, "latest at call time" is not good enough —
    // an old deployment must not satisfy a wait for a NEW one. Parsed up
    // front so a malformed value fails loudly instead of silently disabling
    // the bound (which would restore the very hole this closes).
    const notBefore = options?.notBefore;
    const notBeforeMs = parseNotBefore(notBefore);

    // Identify the deployment we're waiting on at start time. If a new
    // deployment kicks off mid-wait (e.g., another push) we will still be
    // tracking the one that was latest at call time — by design, since the
    // caller's intent is "the deploy I just pushed."
    const token = await getValidRailwayToken();
    const initialNode = await acquireDeploymentAtOrAfter({
      fetchNewest: async () => (await fetchDeployments(this.config.serviceId, 1, token))[0],
      notBeforeMs,
      notBefore,
      timeoutSeconds,
      deadlineMs: deadline,
      now: () => Date.now(),
      sleep,
      pollIntervalMs: pollIntervalSeconds * 1000,
    });

    if (!initialNode) {
      throw new Error(
        `No deployments found for Railway service ${this.config.serviceId}. ` +
          "Cannot wait — has the service deployed at least once?"
      );
    }
    const targetId = initialNode.id;

    let lastRecord: DeploymentRecord = toRecord(initialNode);
    await notifyStatusObserved(options?.onStatusObserved, lastRecord);
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
      await notifyStatusObserved(options?.onStatusObserved, lastRecord);
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
 * Best-effort invocation of `WaitForLatestOptions.onStatusObserved` (mt#2599).
 * The callback is caller-supplied (crosses a trust boundary from this
 * adapter's perspective) and MUST NOT be able to abort the wait loop — a
 * throwing or rejecting callback is caught and logged, never rethrown.
 * Exported for direct unit testing (the full poll loop requires mocking the
 * GraphQL client + timers; this isolates the best-effort contract instead).
 */
export async function notifyStatusObserved(
  onStatusObserved: WaitForLatestOptions["onStatusObserved"],
  record: DeploymentRecord
): Promise<void> {
  if (!onStatusObserved) return;
  try {
    await onStatusObserved(record);
  } catch (err) {
    log.warn("railway adapter: onStatusObserved callback threw (swallowed, best-effort)", {
      error: err instanceof Error ? err.message : String(err),
      status: record.status,
    });
  }
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
