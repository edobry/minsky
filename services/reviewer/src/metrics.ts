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
    await db.insert(convergenceMetricsTable).values({
      prOwner: input.prOwner,
      prRepo: input.prRepo,
      prNumber: input.prNumber,
      headSha: input.headSha,
      iterationIndex: input.iterationIndex,
      priorBlockerCount: input.priorBlockerCount,
      newBlockerCount: input.newBlockerCount,
      acknowledgedAddressedCount: input.acknowledgedAddressedCount,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      JSON.stringify({
        event: "metric_write_error",
        error: message,
        prOwner: input.prOwner,
        prRepo: input.prRepo,
        prNumber: input.prNumber,
        iterationIndex: input.iterationIndex,
      })
    );
    // Intentionally swallow — reviews proceed regardless of metric write failures.
  }
}
