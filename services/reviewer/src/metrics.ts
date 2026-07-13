/**
 * Reviewer convergence metric persistence.
 *
 * Writes one row to reviewer_convergence_metrics per review.
 * Errors are swallowed — metric write failures MUST NOT propagate to the
 * review path (the stdout log line from mt#1189 remains the fallback).
 *
 * Sealed: no imports from src/.
 */

import type { ReviewerDb } from "./db/client";
import { convergenceMetricsTable } from "./db/schemas/convergence-metrics-schema";
import { extractPgErrorContext } from "./webhook-events";
import { log } from "./logger";

/**
 * Accepted `verdict` values (mt#2287): the GitHub review event lowercased.
 * The DB column is unconstrained `text`, so this set — not the column type — is
 * the enforced contract; `recordConvergenceMetric` coerces anything outside it
 * to NULL before the write.
 */
export type ReviewVerdict = "approve" | "request_changes" | "comment";

const VALID_VERDICTS: ReadonlySet<string> = new Set<ReviewVerdict>([
  "approve",
  "request_changes",
  "comment",
]);

/**
 * Normalize an incoming verdict to the accepted set, or NULL. Guards the DB
 * write so an unexpected string can never reach the column (the `text` type
 * does not enforce the constraint on its own — trust-boundary coverage).
 */
export function normalizeVerdict(raw: string | null | undefined): ReviewVerdict | null {
  if (raw == null) return null;
  return VALID_VERDICTS.has(raw) ? (raw as ReviewVerdict) : null;
}

/**
 * Input shape for recording a convergence metric.
 * Maps directly to reviewer_convergence_metrics columns.
 */
export interface ConvergenceMetricInput {
  prOwner: string;
  prRepo: string;
  prNumber: number;
  headSha: string;
  iterationIndex: number;
  priorBlockerCount: number;
  newBlockerCount: number;
  acknowledgedAddressedCount: number;
  /** PR head branch name (e.g. "task/mt-2076"). Nullable — omit for back-compat. (mt#2076) */
  headRef?: string | null;
  /**
   * APPROVE/REQUEST_CHANGES/COMMENT lowercased; nullable for back-compat, mt#2287.
   * Values outside the accepted set (see {@link ReviewVerdict}) are coerced to
   * NULL at write time by {@link normalizeVerdict}.
   */
  verdict?: string | null;
}

/**
 * Persist one convergence metric row.
 *
 * INSERT into reviewer_convergence_metrics. Wrapped in try/catch — logs
 * on failure but never throws. Reviews must not fail because this write fails.
 *
 * @param db    - Drizzle DB instance
 * @param input - Metric data matching schema columns
 */
export async function recordConvergenceMetric(
  db: ReviewerDb,
  input: ConvergenceMetricInput
): Promise<void> {
  try {
    const verdict = normalizeVerdict(input.verdict);
    if (input.verdict != null && verdict === null) {
      log.warn("metric_verdict_invalid", {
        event: "metric_verdict_invalid",
        verdict: input.verdict,
        prOwner: input.prOwner,
        prRepo: input.prRepo,
        prNumber: input.prNumber,
      });
    }
    await db.insert(convergenceMetricsTable).values({
      prOwner: input.prOwner,
      prRepo: input.prRepo,
      prNumber: input.prNumber,
      headSha: input.headSha,
      iterationIndex: input.iterationIndex,
      priorBlockerCount: input.priorBlockerCount,
      newBlockerCount: input.newBlockerCount,
      acknowledgedAddressedCount: input.acknowledgedAddressedCount,
      headRef: input.headRef ?? null,
      verdict,
    });
  } catch (err: unknown) {
    log.error("metric_write_error", {
      event: "metric_write_error",
      ...extractPgErrorContext(err),
      prOwner: input.prOwner,
      prRepo: input.prRepo,
      prNumber: input.prNumber,
      iterationIndex: input.iterationIndex,
    });
    // Intentionally swallow — reviews proceed regardless of metric write failures.
  }
}
