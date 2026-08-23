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

/**
 * Everything the failure path knows at the moment the model call throws.
 *
 * Deliberately NOT `ReviewRunContext`: that context is built AFTER the model
 * call returns, so the path this covers can never have one.
 */
export interface UnrecoveredTimingInput {
  db: ReviewerDb | undefined;
  timingRecorder?: (db: ReviewerDb, input: ReviewTimingInput) => Promise<void>;
  prOwner: string;
  prRepo: string;
  prNumber: number;
  headSha: string;
  iterationIndex: number;
  totalWallClockMs: number;
  /** Partial timing salvaged off the thrown error; absent when the error carried none. */
  partialTiming?: {
    roundLatenciesMs: number[];
    timeoutCount: number;
    retryOutcomes: string[];
  };
  scopeClassification: string | null;
  toolUseActive: boolean;
  provider: string;
  model: string;
}

/**
 * Persist one `review_timing` row for a review that THREW before producing
 * output (mt#4281) — the third timing shape, alongside the two pre-model skip
 * writes in `runReview` and the post-model `writeMainPathTiming`.
 *
 * Token fields are omitted rather than zeroed: a review that never returned
 * usage has UNKNOWN token spend, and zeroes would understate cost in exactly
 * the aggregate the July 2026 audit reads. NULL is the honest value.
 *
 * Like `recordReviewTiming`, this must never affect the review path — the
 * caller rethrows the original error immediately after. Failures here are
 * swallowed by `recordReviewTiming` itself.
 */
export async function recordUnrecoveredReviewTiming(input: UnrecoveredTimingInput): Promise<void> {
  if (input.db === undefined) return;
  await (input.timingRecorder ?? recordReviewTiming)(input.db, {
    prOwner: input.prOwner,
    prRepo: input.prRepo,
    prNumber: input.prNumber,
    headSha: input.headSha,
    iterationIndex: input.iterationIndex,
    totalWallClockMs: input.totalWallClockMs,
    perRoundLatenciesMs: input.partialTiming?.roundLatenciesMs ?? [],
    timeoutCount: input.partialTiming?.timeoutCount ?? 0,
    // The mt#1969 in-round retry is accounted for inside `retryOutcomes`; this
    // path never completed the whole-review retry that `retryCount` counts.
    retryCount: 0,
    retryOutcomes: input.partialTiming?.retryOutcomes ?? [],
    scopeClassification: input.scopeClassification,
    toolUseActive: input.toolUseActive,
    provider: input.provider,
    model: input.model,
  });
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
