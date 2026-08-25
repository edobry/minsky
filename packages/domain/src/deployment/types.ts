/**
 * Platform-neutral types for the deployment-platform abstraction.
 *
 * See docs/deployment-platforms.md for the full design. Railway is the v1
 * concrete adapter; the same interface accepts Vercel, Cloudflare Pages,
 * AWS Amplify, Fly.io, etc.
 *
 * Tracking task: mt#1730.
 */

// PlatformName is re-exported from @minsky/shared via ./config.ts — see that
// module for the canonical definition. Importers should pull it from
// "../deployment" (the package barrel) or from "./config" directly.

/**
 * Normalized deployment status. Each platform's native status set maps into
 * this union — see the adapter implementation for the platform-specific
 * mapping table.
 *
 * Terminal: SUCCESS, FAILED, CANCELLED, CRASHED. waitForLatestDeployment
 * returns when the current deployment's status enters this set.
 */
export type DeploymentStatus =
  | "BUILDING"
  | "DEPLOYING"
  | "SUCCESS"
  | "FAILED"
  | "CANCELLED"
  | "CRASHED"
  | "UNKNOWN";

export function isTerminalStatus(status: DeploymentStatus): boolean {
  return (
    status === "SUCCESS" || status === "FAILED" || status === "CANCELLED" || status === "CRASHED"
  );
}

/**
 * Platform-neutral deployment record. Adapters normalize their native
 * representation into this shape.
 */
export interface DeploymentRecord {
  /** Platform-specific deployment ID (used to fetch logs). */
  id: string;
  /** Normalized status. */
  status: DeploymentStatus;
  /** Commit hash deployed, when known. */
  commitHash: string | null;
  /** Commit message deployed, when known. */
  commitMessage: string | null;
  /**
   * Container image digest deployed, when the platform reports one (mt#4583).
   *
   * Present for image-source services, which are exactly the ones where
   * `commitHash` is null — the platform deploys a pushed image and never sees
   * the commit. It does NOT identify which commit produced the image, so it is
   * not a substitute for `commitHash`; it distinguishes a genuine release from
   * a redeploy of the SAME image (mem#551), which is a different question.
   *
   * Railway already returns this inside the deployment's `meta` object; it was
   * being dropped at the mapping boundary rather than being unavailable.
   */
  imageDigest: string | null;
  /** ISO8601 timestamp the deployment was created. */
  createdAt: string;
  /** ISO8601 timestamp the deployment reached a terminal state, when known. */
  finishedAt: string | null;
  /** Duration from createdAt to finishedAt in milliseconds, when known. */
  durationMs: number | null;
  /** Platform-specific URL pointing at the deployment, when the platform exposes one. */
  url: string | null;
}

/**
 * Log channel selector.
 *   - "build" → build-phase logs (compile / Docker build / etc.)
 *   - "deploy" → runtime/container logs after the deploy lands.
 */
export type LogType = "build" | "deploy";

export interface LogAttribute {
  key: string;
  value: string;
}

export interface LogLine {
  /** ISO8601 timestamp. */
  timestamp: string;
  /** Platform-specific severity ("info" / "warn" / "error" common). */
  severity: string;
  /** Log message. */
  message: string;
  /** Structured attributes parsed from JSON log output (Railway). Empty when unavailable. */
  attributes: LogAttribute[];
}

export interface WaitForLatestOptions {
  /** Maximum time to block before throwing a timeout error. Default 600s. */
  timeoutSeconds?: number;
  /** Poll interval in seconds. Default 10s. May be ignored by adapters with a stream primitive. */
  pollIntervalSeconds?: number;
  /**
   * Optional progress callback (mt#2599). Adapters invoke this with EVERY
   * observed `DeploymentRecord` — once for the initial poll and once per
   * subsequent poll iteration — including non-terminal statuses (BUILDING,
   * DEPLOYING), not just the final terminal record `waitForLatestDeployment`
   * resolves with.
   *
   * This is the seam `deployment.wait-for-latest`'s execute handler
   * (`src/adapters/shared/commands/deployment.ts`) uses to emit a best-effort
   * `deploy.build` system event the first time a `BUILDING` status is
   * observed, without adding a separate poller — see the mt#2599 spec's
   * "option 1" (progress-callback) design.
   *
   * Adapters MUST treat this as best-effort: a throwing callback must never
   * abort the wait, so implementations wrap the call in try/catch. Callers
   * that don't need progress observation simply omit the option.
   */
  onStatusObserved?: (record: DeploymentRecord) => void | Promise<void>;
  /**
   * ISO8601 lower bound on the deployment's `createdAt` (mt#3890). When set,
   * a deployment created BEFORE this instant is not accepted as the one being
   * waited for — the wait keeps polling for a newer one and throws
   * {@link NoDeploymentSinceError} if none appears before the timeout.
   *
   * Without it, this method's contract is "whatever is latest at call time,"
   * which silently succeeds against an ARBITRARILY OLD deployment. That is not
   * hypothetical: for ~4.5 days `minsky-mcp`'s redeploy call was returning
   * `Not Authorized` while the workflow treated it as non-fatal, so no new
   * deployment was ever created — and this method dutifully returned the
   * 2026-08-05 SUCCESS record to every post-merge deploy gate that asked. The
   * gate passed on a deploy that never happened.
   *
   * Callers verifying a specific merge should pass that merge's timestamp.
   * Note the check is on TIME, not commit: an image-source Railway deploy
   * carries no `commitHash` (verified on the reviewer service, whose working
   * deploys have a null hash while its older repo-source builds have one), so
   * commit comparison is not available on the path that matters.
   *
   * **That caveat is necessary and was not sufficient (mt#4583).** Bounding
   * time does not identify WHICH change deployed, so on a busy branch a
   * NEIGHBOURING merge's deployment lands inside the window and satisfies this
   * bound — observed 2026-08-25: a deployment created ten seconds after a merge
   * returned SUCCESS and belonged to the previous merge's workflow run. Pass
   * {@link WaitForLatestOptions.expectCommitSha} as well, and read the returned
   * `buildIdentity`; this bound alone cannot tell you whose deploy you got.
   */
  notBefore?: string;
  /**
   * The commit this caller is verifying deployed (mt#4583).
   *
   * When set, the result carries a `buildIdentity` verdict rather than leaving
   * the caller to infer identity from a bare SUCCESS. When the deployment
   * record cannot answer — the image-source case named above — the verdict is
   * `indeterminate` WITH a reason, which is deliberately not the same value as
   * `confirmed`. Collapsing those two is the defect this exists to remove.
   */
  expectCommitSha?: string;
}

/**
 * Adapter interface every deployment platform implements.
 *
 * Adapters are constructed via `AdapterFactory` from a `DeploymentConfig`
 * and register themselves with the registry at module-load time. Resolution
 * goes through the registry, not direct construction, so the MCP tools stay
 * platform-neutral.
 */
export interface DeploymentPlatformAdapter {
  /**
   * Block until the latest deployment for the configured service reaches a
   * terminal state. Returns the final record. Throws
   * `DeploymentWaitTimeoutError` on timeout.
   */
  waitForLatestDeployment(options?: WaitForLatestOptions): Promise<DeploymentRecord>;

  /**
   * Read-only snapshot of the latest deployment. Does not block.
   */
  getLatestDeploymentStatus(): Promise<DeploymentRecord>;

  /**
   * Fetch logs for a specific deployment. v1 returns the last `lines`
   * entries (default 100); streaming (`follow`) is out of scope for v1 —
   * see mt#1725 for the notification-path discussion.
   */
  getDeploymentLogs(deploymentId: string, type: LogType, lines?: number): Promise<LogLine[]>;

  /**
   * Read-only snapshot of current resource utilization (CPU %, memory %) for
   * the configured service. **Optional** on the platform-neutral interface:
   * resource-metric availability is platform-dependent — not every platform
   * exposes a Railway-style metrics surface. Adapters that cannot serve
   * metrics omit this method (callers feature-detect with `if (adapter.getServiceMetrics)`).
   *
   * Added mt#2296 (consumer: mt#2077 cockpit MCP-server page CPU%/memory% fields).
   */
  getServiceMetrics?(): Promise<ServiceMetricsSnapshot>;

  /**
   * Count of service restarts within a trailing time window, plus a
   * per-status breakdown (restart-loop / M4 input for the cockpit). **Optional**
   * for the same platform-dependence reason as {@link getServiceMetrics}.
   *
   * See {@link RestartCountResult} for what a "restart" counts as on each
   * platform (Railway: deployment records created in the window).
   *
   * Added mt#2296 (consumer: mt#2077 cockpit MCP-server page restart-count field + M3).
   */
  getRestartCount?(windowHours?: number): Promise<RestartCountResult>;
}

/**
 * Read-only snapshot of a service's current resource utilization, normalized
 * across platforms. Percentages are 0..100; any field is `null` when the
 * platform did not return the underlying datapoint (e.g. a brand-new service
 * with no metrics yet, or a divide-by-zero on a zero limit).
 *
 * Added mt#2296.
 */
export interface ServiceMetricsSnapshot {
  /** Latest CPU utilization as a percentage of the CPU limit (0..100), or null. */
  cpuPercent: number | null;
  /** Latest memory utilization as a percentage of the memory limit (0..100), or null. */
  memoryPercent: number | null;
  /** Latest raw CPU usage in vCPU, or null. */
  cpuUsageVCpu: number | null;
  /** CPU limit in vCPU at the latest sample, or null. */
  cpuLimitVCpu: number | null;
  /** Latest raw memory usage in GB, or null. */
  memoryUsageGb: number | null;
  /** Memory limit in GB at the latest sample, or null. */
  memoryLimitGb: number | null;
  /** ISO8601 timestamp of the freshest datapoint across the series used, or null when no datapoints. */
  sampledAt: string | null;
}

/**
 * Count of service restarts within a trailing window, with a per-status
 * breakdown for restart-loop detection.
 *
 * **What counts as a "restart" (Railway v1):** a deployment record created
 * within the window. This covers redeploys, config-change deploys, and
 * crash-triggered redeploys / failed-deploy clusters — the operationally
 * visible restart-loop signal. It does NOT count in-place container restarts
 * that Railway performs under the same deployment without creating a new
 * deployment record (those are `deploymentInstanceExecutions`, out of scope
 * for the v1 derivation). `byStatus` lets a consumer threshold on FAILED
 * clusters specifically (M3 restart-loop).
 *
 * Added mt#2296.
 */
export interface RestartCountResult {
  /** Total deployment records created within the window. */
  count: number;
  /** Window length in hours. */
  windowHours: number;
  /** ISO8601 lower bound of the counted window. */
  since: string;
  /** Count per normalized DeploymentStatus within the window. */
  byStatus: Partial<Record<DeploymentStatus, number>>;
}

/**
 * Thrown when waitForLatestDeployment exceeds its timeout. Carries the
 * last observed status so the caller can decide whether to keep waiting or
 * surface the partial state.
 */
/**
 * Thrown when `waitForLatestDeployment` was given a `notBefore` bound and no
 * deployment created at or after it appeared before the timeout (mt#3890).
 *
 * Deliberately DISTINCT from {@link DeploymentWaitTimeoutError}: that one means
 * "a deployment is running and hasn't finished," this one means "no deployment
 * ever started." Those call for opposite responses — wait longer vs. go find
 * out why nothing was triggered — and collapsing them is what let a broken
 * deploy pipeline read as a slow one.
 *
 * Carries the newest record actually found (or null) so the caller can report
 * how stale the service really is.
 */
export class NoDeploymentSinceError extends Error {
  constructor(
    public readonly notBefore: string,
    public readonly timeoutSeconds: number,
    public readonly newestRecord: DeploymentRecord | null
  ) {
    const newest = newestRecord
      ? `Newest deployment is ${newestRecord.status} from ${newestRecord.createdAt}.`
      : "No deployments exist for this service at all.";
    super(
      `No deployment created at or after ${notBefore} appeared within ${timeoutSeconds}s. ` +
        `${newest} The deploy was almost certainly never triggered — check the deploy ` +
        `workflow's redeploy step rather than waiting longer.`
    );
    this.name = "NoDeploymentSinceError";
  }
}

export class DeploymentWaitTimeoutError extends Error {
  constructor(
    public readonly timeoutSeconds: number,
    public readonly lastStatus: DeploymentStatus,
    public readonly lastRecord: DeploymentRecord | null
  ) {
    super(
      `Deployment did not reach a terminal status within ${timeoutSeconds}s. ` +
        `Last observed status: ${lastStatus}.`
    );
    this.name = "DeploymentWaitTimeoutError";
  }
}
