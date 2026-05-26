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

export interface LogLine {
  /** ISO8601 timestamp. */
  timestamp: string;
  /** Platform-specific severity ("info" / "warn" / "error" common). */
  severity: string;
  /** Log message. */
  message: string;
}

export interface WaitForLatestOptions {
  /** Maximum time to block before throwing a timeout error. Default 600s. */
  timeoutSeconds?: number;
  /** Poll interval in seconds. Default 10s. May be ignored by adapters with a stream primitive. */
  pollIntervalSeconds?: number;
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
}

/**
 * Thrown when waitForLatestDeployment exceeds its timeout. Carries the
 * last observed status so the caller can decide whether to keep waiting or
 * surface the partial state.
 */
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
