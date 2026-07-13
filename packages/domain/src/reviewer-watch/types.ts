/**
 * Local reviewer-bot watcher — types.
 *
 * Implements mt#1310 (Option A — local watcher). Mirrors the Railway sweeper
 * (mt#1260, services/reviewer/src/sweeper.ts) detection logic but lives in the
 * main monorepo so it can fire `SystemOperatorNotify` on the operator's
 * desktop. The Railway sweeper continues to retrigger missed reviews; this
 * watcher owns the alerting half mt#1260 deferred.
 */

/**
 * Reason values for `MissingReviewPR.reason`. Exported so callers (and tests)
 * can reference them by name rather than duplicating the string literal.
 */
export const REASON_NO_REVIEW_BY_BOT = "no_review_by_bot" as const;
export const REASON_COMMIT_ID_MISMATCH = "commit_id_mismatch" as const;

export type MissedReviewReason = typeof REASON_NO_REVIEW_BY_BOT | typeof REASON_COMMIT_ID_MISMATCH;

/**
 * A PR detected as missing a non-dismissed review by the configured reviewer
 * bot at its current HEAD SHA.
 */
export interface MissingReviewPR {
  /** PR number. */
  number: number;
  /** Current HEAD commit SHA. */
  headSha: string;
  /** PR author login (used for log/audit, not currently for routing). */
  authorLogin: string;
  /** Why the PR is flagged. */
  reason: MissedReviewReason;
  /** Click-through URL for the PR. */
  htmlUrl: string;
}

/**
 * Summary of one watcher cycle. Returned from `runReviewerWatchCycle` so the
 * CLI / daemon can structure its log output and so tests can assert on it.
 */
export interface ReviewerWatchCycleResult {
  /** ISO 8601 cycle-start timestamp. */
  startedAt: string;
  /** Number of open PRs scanned. */
  prsScanned: number;
  /** PRs detected as missing a review at HEAD. */
  missing: MissingReviewPR[];
  /** Whether the cycle fired an operator notification this pass. */
  alerted: boolean;
  /**
   * The dedup decision:
   *   - `"new-condition"`     — alert fired because the set of misses changed
   *   - `"unchanged"`         — alert suppressed; same misses already alerted
   *   - `"below-threshold"`   — alert suppressed; missing.length < threshold
   *   - `"none-missing"`      — alert suppressed; nothing missing
   */
  decision: "new-condition" | "unchanged" | "below-threshold" | "none-missing";
}

/**
 * Configuration for one watcher cycle. Defaults are read from environment
 * variables at the CLI/composition layer; the domain function takes an
 * already-resolved config to keep it pure.
 */
export interface ReviewerWatchConfig {
  /** Owner of the GitHub repo to scan. */
  owner: string;
  /** Repo name. */
  repo: string;
  /**
   * Login of the reviewer bot whose presence/absence determines the alert.
   * Typically `"minsky-reviewer[bot]"`.
   */
  botLogin: string;
  /**
   * Minimum number of missed reviews required to fire an alert.
   * Default at the CLI layer: 1 (alert on any missed). Tuneable via env var.
   */
  threshold: number;
}
