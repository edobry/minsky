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
import type { ReviewerConfig } from "./config";
import { fingerprintForReview } from "./config-fingerprint";
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
  /**
   * The configuration arm this review ran under (mt#4556). Built by
   * `fingerprintForReview` in `config-fingerprint.ts`, which also documents the
   * format.
   *
   * REQUIRED, deliberately. SC1 asks for it on every write path and there are
   * four — the model-invoking tail, the two pre-model skip paths, and the
   * unrecovered-failure path. A required field makes the compiler enumerate
   * them; an optional one would leave that to a test remembering all four,
   * which is the mt#4281 failure mode (a write site nobody enumerated wrote
   * nothing for 30 days, and nothing about that looked wrong from outside).
   */
  configFingerprint: string;
  // mt#2288: per-review token spend + computed USD cost. Optional — the two
  // pre-model skip paths omit them, so they persist as NULL.
  inputTokens?: number | null;
  outputTokens?: number | null;
  reasoningTokens?: number | null;
  cachedTokens?: number | null;
  costUsd?: number | null;
}

/**
 * The timing row a PRE-MODEL SKIP path writes (mt#2088; fingerprint mt#4556).
 *
 * Both skip paths — routing-skip and concurrent-inflight — wrote byte-identical
 * literals inline in `runReview`. Extracted here as a pure function for two
 * reasons: the duplication was real, and the reviewer suite's no-`mock.module`
 * convention means `runReview` cannot be driven end-to-end in a unit test, so
 * an inline literal is a write site no test can observe. Returning the row
 * makes the value checkable without patching anything.
 *
 * `modelCalled: false` is the whole point of the distinction: these paths
 * return before the model is reached, so no `reasoning_effort` was sent and the
 * fingerprint records `effort=none`. The configuration dimensions are still
 * recorded — the row is evidence about what the reviewer was configured to do
 * when it declined to review.
 *
 * Token fields are omitted, so they persist as NULL: a review that never called
 * the model has UNKNOWN token spend, and zeroes would understate cost in the
 * aggregates that read this table.
 */
export function buildSkipPathTiming(args: {
  prOwner: string;
  prRepo: string;
  prNumber: number;
  headSha: string;
  totalWallClockMs: number;
  scopeClassification: string | null;
  config: Pick<ReviewerConfig, "provider" | "providerModel" | "tier2Enabled">;
  /** Env source for the fingerprint's flag reads. Injected in tests. */
  env?: Record<string, string | undefined>;
}): ReviewTimingInput {
  return {
    prOwner: args.prOwner,
    prRepo: args.prRepo,
    prNumber: args.prNumber,
    headSha: args.headSha,
    iterationIndex: 0,
    totalWallClockMs: args.totalWallClockMs,
    perRoundLatenciesMs: [],
    timeoutCount: 0,
    retryCount: 0,
    retryOutcomes: [],
    scopeClassification: args.scopeClassification,
    toolUseActive: false,
    provider: args.config.provider,
    model: args.config.providerModel,
    configFingerprint: fingerprintForReview(args.config, {
      toolUseActive: false,
      modelCalled: false,
      ...(args.env ? { env: args.env } : {}),
    }),
  };
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
  /** The configuration arm (mt#4556). A model call WAS attempted on this path. */
  configFingerprint: string;
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
    configFingerprint: input.configFingerprint,
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
      configFingerprint: input.configFingerprint,
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
