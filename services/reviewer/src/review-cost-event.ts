/**
 * Per-review LLM cost/token/cache emission to Braintrust (mt#2723).
 *
 * Cost observability lives on the chosen LLM-observability platform (Braintrust,
 * trace-shape doc 35e937f0; strategy parent mt#1778) rather than being
 * reconstructed from Postgres + bespoke audits (the 2026-07-09 pain). Reuses the
 * shared fire-and-forget `emitBraintrustEvent`.
 *
 * Emits ONLY for model-invoking reviews (input tokens present). The two pre-model
 * skip paths (routing-skip, concurrent-inflight) carry no token data and emit
 * nothing. Called from `recordReviewTiming` — the single per-review choke that
 * already fires exactly once per review at the right paths.
 *
 * Never throws and never blocks the review path (instrumentation discipline).
 *
 * NB (mt#2723 review): `output.outcome` + `input.tier` are intentionally NOT on
 * this event yet — threading them into the four review-worker timing sites
 * breaches review-worker.ts's 1500 max-lines ceiling. Deferred to mt#2720 (the
 * review-worker split), which can enrich these blocks. The lean event still
 * fully serves cost visibility; outcome also overlaps mt#1839 (verdict).
 */

import { emitBraintrustEvent, type BraintrustEvent } from "@minsky/domain/observability/braintrust";
import type { ReviewTimingInput } from "./review-timing";

/** Braintrust `metadata.source` tag for query filtering. */
export const REVIEW_COST_SOURCE = "minsky.reviewer.cost";

/** Injectable emitter seam for tests. */
export type EmitFn = (event: BraintrustEvent) => Promise<void>;

/**
 * Build the Braintrust cost event from a review-timing input, or null when the
 * input is not a model-invoking review (no input-token data → nothing to emit).
 */
export function buildReviewCostEvent(input: ReviewTimingInput): BraintrustEvent | null {
  if (input.inputTokens == null) return null;
  const inputTokens = input.inputTokens;
  const cachedTokens = input.cachedTokens ?? null;
  const cacheHitRatio = cachedTokens != null && inputTokens > 0 ? cachedTokens / inputTokens : null;
  return {
    input: {
      pr_owner: input.prOwner,
      pr_repo: input.prRepo,
      pr_number: input.prNumber,
      model: input.model,
      provider: input.provider,
    },
    metadata: {
      source: REVIEW_COST_SOURCE,
      input_tokens: inputTokens,
      output_tokens: input.outputTokens ?? null,
      reasoning_tokens: input.reasoningTokens ?? null,
      cached_tokens: cachedTokens,
      cache_hit_ratio: cacheHitRatio,
      cost_usd: input.costUsd ?? null,
      iteration_index: input.iterationIndex,
      scope_classification: input.scopeClassification,
    },
  };
}

/**
 * Emit the per-review cost event (fire-and-forget). No-op for non-model-invoking
 * inputs. Never throws — instrumentation must not affect the review path even if
 * the injected emitter fails.
 */
export async function emitReviewCostEvent(
  input: ReviewTimingInput,
  emit: EmitFn = emitBraintrustEvent
): Promise<void> {
  try {
    const event = buildReviewCostEvent(input);
    if (!event) return;
    await emit(event);
  } catch {
    // Instrumentation failures never affect the review path.
  }
}
