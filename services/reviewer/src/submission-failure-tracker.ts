/**
 * Non-retryable review-submission-failure tracking + circuit breaker (mt#2350).
 *
 * GitHub rejects a review POST with a 422 when an inline-comment anchor can't be
 * resolved (and with other 4xx for self-review / closed-PR / malformed payload
 * constraints). These are CLIENT errors — re-running the identical review on the
 * identical HEAD produces the identical failure. The sweeper (mt#1260) treats a
 * PR with no review on record as a "missed review" and retriggers it, so without
 * a circuit breaker a non-retryable submission failure loops forever: each
 * sweeper cycle pays another OpenAI review cycle only to 422 again on submit.
 *
 * This module records each non-retryable failure durably (so the count survives
 * the reviewer process's frequent restarts) and exposes the predicates the
 * sweeper uses to stop retriggering an open-circuit (PR, head_sha) and emit a
 * one-shot operator alert.
 *
 * Owned by the reviewer service. No imports from src/.
 */

import { sql, eq } from "drizzle-orm";
import { safeTruncate } from "@minsky/shared/safe-truncate";
import type { ReviewerDb } from "./db/client";
import {
  submissionFailuresTable,
  type SubmissionFailureRecord,
} from "./db/schemas/submission-failures-schema";
import { log } from "./logger";

/**
 * Consecutive identical-HEAD-SHA submission failures after which the circuit
 * opens and the sweeper stops retriggering that PR.
 *
 * Grounded in observed cadence (mt#2350 burn analysis): the loop is already
 * bounded to ~2 review cycles per HEAD by sibling guards (the mt#1907 inflight
 * marker, review_timing recording max ~2/HEAD, deploy churn). N=2 means a PR
 * gets at most two review attempts on a HEAD before the breaker trips — enough
 * to absorb a genuinely transient first failure, tight enough to stop the loop.
 * Per `decision-defaults §Thresholds` (calibrate to cadence, not round numbers).
 */
export const CIRCUIT_BREAKER_THRESHOLD = 2;

/** Max stored length for the last-failure message (log/DB safety). */
const MAX_MESSAGE_LENGTH = 500;

/** Classification of a review-submission error. */
export interface SubmissionErrorClassification {
  /** True when retrying the identical submission could plausibly succeed. */
  retryable: boolean;
  /** HTTP status code, when the error carried one. */
  status?: number;
  /** Short class label for triage/alerting (e.g. "non_retryable_4xx"). */
  class: string;
  /** Human-readable message (truncated). */
  message: string;
}

/**
 * Extract a numeric HTTP status from an Octokit/HTTP error shape.
 *
 * Octokit's RequestError exposes `.status`; some wrappers expose
 * `.response.status`. Returns undefined when no numeric status is present.
 */
function extractStatus(err: unknown): number | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const obj = err as Record<string, unknown>;
  if (typeof obj.status === "number") return obj.status;
  const response = obj.response;
  if (typeof response === "object" && response !== null) {
    const rstatus = (response as Record<string, unknown>).status;
    if (typeof rstatus === "number") return rstatus;
  }
  return undefined;
}

function extractMessage(err: unknown): string {
  if (typeof err === "object" && err !== null) {
    const m = (err as Record<string, unknown>).message;
    if (typeof m === "string") return safeTruncate(m, MAX_MESSAGE_LENGTH, "head");
  }
  return safeTruncate(String(err), MAX_MESSAGE_LENGTH, "head");
}

/**
 * Classify a review-submission error as retryable vs. non-retryable.
 *
 * - 4xx (except 408 Request Timeout and 429 Too Many Requests) → non-retryable
 *   client error. This is the 422 "Line could not be resolved" class plus
 *   self-review / closed-PR / malformed-payload constraints.
 * - 408 / 429 / 5xx → retryable (transient: timeout, rate limit, server error).
 * - No numeric status (network error, unknown shape) → returns null so callers
 *   do NOT trip the breaker on errors that aren't recognizable submission
 *   failures (these get the normal best-effort retry behavior).
 */
export function classifySubmissionError(err: unknown): SubmissionErrorClassification | null {
  const status = extractStatus(err);
  if (status === undefined) return null;

  const message = extractMessage(err);

  if (status >= 400 && status < 500) {
    if (status === 408 || status === 429) {
      return { retryable: true, status, class: `retryable_${status}`, message };
    }
    return { retryable: false, status, class: "non_retryable_4xx", message };
  }

  if (status >= 500 && status < 600) {
    return { retryable: true, status, class: "retryable_5xx", message };
  }

  // 1xx/2xx/3xx reaching an error path is unexpected; treat as unknown.
  return null;
}

/** Pure helper: does this consecutive-failure count open the circuit? */
export function shouldOpenCircuit(consecutiveCount: number): boolean {
  return consecutiveCount >= CIRCUIT_BREAKER_THRESHOLD;
}

/** Coordinates identifying a single (PR, head_sha) submission attempt. */
export interface SubmissionFailureCoords {
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
}

/** Coordinates plus the classified-failure detail to record. */
export interface RecordSubmissionFailureInput extends SubmissionFailureCoords {
  errorClass: string;
  status?: number;
  message: string;
}

/**
 * Stable key for correlating an open circuit with a missing-review PR in the
 * sweeper. Matches the inflight-marker `markerKey` format intentionally.
 */
export function submissionFailureKey(
  owner: string,
  repo: string,
  prNumber: number,
  headSha: string
): string {
  return `${owner}/${repo}#${prNumber}@${headSha}`;
}

/**
 * Record a non-retryable submission failure, incrementing the consecutive count
 * for the (owner, repo, pr_number, head_sha) row and opening the circuit when
 * the count reaches the threshold.
 *
 * Best-effort: a DB error is logged and swallowed — a tracking-write failure
 * must never mask the original submission error (which the caller re-throws).
 * The `alerted` flag is intentionally NOT reset on conflict so the sweeper
 * alerts at most once per open circuit.
 */
export async function recordSubmissionFailure(
  db: ReviewerDb,
  input: RecordSubmissionFailureInput
): Promise<void> {
  const { owner, repo, prNumber, headSha, errorClass, status, message } = input;
  const statusValue = status ?? null;
  const messageValue = safeTruncate(message, MAX_MESSAGE_LENGTH, "head");
  const initialOpen = shouldOpenCircuit(1);

  try {
    await db.execute(
      sql`INSERT INTO reviewer_submission_failures
            (owner, repo, pr_number, head_sha, error_class, last_status, last_message,
             consecutive_count, circuit_open, alerted, first_failure_at, last_failure_at)
          VALUES
            (${owner}, ${repo}, ${prNumber}, ${headSha}, ${errorClass}, ${statusValue},
             ${messageValue}, 1, ${initialOpen}, false, now(), now())
          ON CONFLICT (owner, repo, pr_number, head_sha) DO UPDATE SET
            error_class = EXCLUDED.error_class,
            last_status = EXCLUDED.last_status,
            last_message = EXCLUDED.last_message,
            consecutive_count = reviewer_submission_failures.consecutive_count + 1,
            circuit_open = (reviewer_submission_failures.consecutive_count + 1) >= ${CIRCUIT_BREAKER_THRESHOLD},
            last_failure_at = now()`
    );
    log.warn("reviewer.submission_failure_recorded", {
      event: "reviewer.submission_failure_recorded",
      owner,
      repo,
      pr: prNumber,
      headSha,
      errorClass,
      status: statusValue,
    });
  } catch (err: unknown) {
    log.error("reviewer.submission_failure_record_failed", {
      event: "reviewer.submission_failure_record_failed",
      owner,
      repo,
      pr: prNumber,
      headSha,
      error: extractMessage(err),
    });
  }
}

/**
 * Clear any recorded failure state for a (PR, head_sha) after a SUCCESSFUL
 * submission, so a recovered HEAD re-opens the retrigger path. Best-effort.
 */
export async function clearSubmissionFailures(
  db: ReviewerDb,
  coords: SubmissionFailureCoords
): Promise<void> {
  const { owner, repo, prNumber, headSha } = coords;
  try {
    await db.execute(
      sql`DELETE FROM reviewer_submission_failures
          WHERE owner = ${owner} AND repo = ${repo}
            AND pr_number = ${prNumber} AND head_sha = ${headSha}`
    );
  } catch (err: unknown) {
    log.warn("reviewer.submission_failure_clear_failed", {
      event: "reviewer.submission_failure_clear_failed",
      owner,
      repo,
      pr: prNumber,
      headSha,
      error: extractMessage(err),
    });
  }
}

/** An open-circuit row, as surfaced to the sweeper. */
export interface OpenCircuit {
  id: string;
  prNumber: number;
  headSha: string;
  errorClass: string;
  lastStatus: number | null;
  consecutiveCount: number;
  alerted: boolean;
}

/**
 * Bulk lookup of open circuits for the supplied PRs. Returns a Map keyed by
 * `submissionFailureKey`, containing only PRs whose circuit is currently open at
 * the supplied head_sha.
 *
 * Mirrors `listActiveMarkersForPRs`: fetches the (small) set of open-circuit
 * rows and filters to the requested (prNumber, headSha) tuples in memory.
 * Returns an empty Map on DB error (fail-open: prefer an extra retrigger over
 * blocking all retriggers).
 */
export async function listOpenCircuitsForPRs(
  db: ReviewerDb,
  prs: Array<{ owner: string; repo: string; prNumber: number; headSha: string }>
): Promise<Map<string, OpenCircuit>> {
  const result = new Map<string, OpenCircuit>();
  if (prs.length === 0) return result;

  let rows: SubmissionFailureRecord[];
  try {
    rows = await db
      .select()
      .from(submissionFailuresTable)
      .where(eq(submissionFailuresTable.circuitOpen, true));
  } catch {
    // Fail-open: proceed as if no circuit is open.
    return result;
  }

  const requested = new Set(
    prs.map((p) => submissionFailureKey(p.owner, p.repo, p.prNumber, p.headSha))
  );

  for (const row of rows) {
    const key = submissionFailureKey(row.owner, row.repo, row.prNumber, row.headSha);
    if (!requested.has(key)) continue;
    result.set(key, {
      id: row.id,
      prNumber: row.prNumber,
      headSha: row.headSha,
      errorClass: row.errorClass,
      lastStatus: row.lastStatus ?? null,
      consecutiveCount: row.consecutiveCount,
      alerted: row.alerted,
    });
  }

  return result;
}

/**
 * Mark an open-circuit row as alerted so the sweeper does not re-alert on the
 * next cycle. Best-effort.
 */
export async function markCircuitAlerted(db: ReviewerDb, id: string): Promise<void> {
  try {
    await db.execute(sql`UPDATE reviewer_submission_failures SET alerted = true WHERE id = ${id}`);
  } catch (err: unknown) {
    log.warn("reviewer.submission_failure_mark_alerted_failed", {
      event: "reviewer.submission_failure_mark_alerted_failed",
      id,
      error: extractMessage(err),
    });
  }
}
