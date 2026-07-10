/**
 * Per-review timing persistence.
 *
 * Writes one row to review_timing per completed review.
 * Errors are swallowed — timing write failures MUST NOT propagate to the
 * review path (same fire-and-forget pattern as convergence metrics, mt#1306).
 *
 * mt#2088.
 */

import type { ReviewerDb } from "./db/client";
import { reviewTimingTable } from "./db/schemas/review-timing-schema";
import { extractPgErrorContext } from "./webhook-events";
import { log } from "./logger";

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
  costUsd?: number | null;
}

export async function recordReviewTiming(db: ReviewerDb, input: ReviewTimingInput): Promise<void> {
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
      // numeric(12,6) drizzle column takes a string; null when unpriced.
      costUsd: input.costUsd == null ? null : input.costUsd.toString(),
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
