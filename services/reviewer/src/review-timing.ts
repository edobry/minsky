/**
 * Per-review timing persistence.
 *
 * Writes one row to review_timing per completed review.
 * Errors are swallowed — timing write failures MUST NOT propagate to the
 * review path (same fire-and-forget pattern as convergence metrics, mt#1306).
 *
 * Also emits a per-review LLM cost event to Braintrust (mt#2723) — the single
 * per-review choke — fire-and-forget, independent of the Postgres write.
 *
 * mt#2088.
 */

import type { ReviewerDb } from "./db/client";
import { reviewTimingTable } from "./db/schemas/review-timing-schema";
import { extractPgErrorContext } from "./webhook-events";
import { log } from "./logger";
import { emitReviewCostEvent } from "./review-cost-event";

export interface ReviewTimingInput {
  prOwner: string;
  prRepo: string;
  prNumber: number;
  headSha: string;
  iterationIndex: number;
  totalWallClockMs: number;
  perRoundLatenciesMs: number[];
  timeoutCount: number;
  retryCount: number;
  retryOutcomes: string[];
  scopeClassification: string | null;
  toolUseActive: boolean;
  provider: string;
  model: string;
  // mt#2288: per-review token spend + computed USD cost. Optional — the two
  // pre-model skip paths omit them, so they persist as NULL.
  inputTokens?: number | null;
  outputTokens?: number | null;
  reasoningTokens?: number | null;
  cachedTokens?: number | null;
  costUsd?: number | null;
}

export async function recordReviewTiming(db: ReviewerDb, input: ReviewTimingInput): Promise<void> {
  // mt#2723: emit per-review cost to Braintrust (fire-and-forget; no-op on the
  // pre-model skip paths where inputTokens is null; independent of the Postgres
  // write below so it lands even if the DB is unavailable). Never blocks.
  void emitReviewCostEvent(input);
  try {
    await db.insert(reviewTimingTable).values({
      prOwner: input.prOwner,
      prRepo: input.prRepo,
      prNumber: input.prNumber,
      headSha: input.headSha,
      iterationIndex: input.iterationIndex,
      totalWallClockMs: input.totalWallClockMs,
      perRoundLatenciesMs: input.perRoundLatenciesMs,
      timeoutCount: input.timeoutCount,
      retryCount: input.retryCount,
      retryOutcomes: input.retryOutcomes,
      scopeClassification: input.scopeClassification,
      toolUseActive: input.toolUseActive,
      provider: input.provider,
      model: input.model,
      inputTokens: input.inputTokens ?? null,
      outputTokens: input.outputTokens ?? null,
      reasoningTokens: input.reasoningTokens ?? null,
      cachedTokens: input.cachedTokens ?? null,
      // numeric(12,6) drizzle column takes a string; fixed 6dp avoids float
      // representation surprises. null when unpriced.
      costUsd: input.costUsd == null ? null : input.costUsd.toFixed(6),
    });
  } catch (err: unknown) {
    log.error("review_timing_write_error", {
      event: "review_timing_write_error",
      ...extractPgErrorContext(err),
      prOwner: input.prOwner,
      prRepo: input.prRepo,
      prNumber: input.prNumber,
      iterationIndex: input.iterationIndex,
    });
  }
}
