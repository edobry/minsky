/**
 * Tests for per-review Braintrust cost emission (mt#2723).
 */

import { describe, it, expect } from "bun:test";
import {
  buildReviewCostEvent,
  emitReviewCostEvent,
  REVIEW_COST_SOURCE,
  type EmitFn,
} from "./review-cost-event";
import type { ReviewTimingInput } from "./review-timing";

/** A base model-invoking review-timing input; override per case. */
function timingInput(overrides: Partial<ReviewTimingInput> = {}): ReviewTimingInput {
  return {
    prOwner: "edobry",
    prRepo: "minsky",
    prNumber: 1867,
    headSha: "abc123",
    iterationIndex: 2,
    totalWallClockMs: 90_000,
    perRoundLatenciesMs: [90_000],
    timeoutCount: 0,
    retryCount: 0,
    retryOutcomes: [],
    scopeClassification: "code",
    toolUseActive: true,
    provider: "openai",
    model: "gpt-5",
    inputTokens: 30_000,
    outputTokens: 3_000,
    reasoningTokens: 500,
    cachedTokens: 20_000,
    costUsd: 0.045,
    ...overrides,
  };
}

describe("buildReviewCostEvent", () => {
  it("builds a cost event with token/cost metadata + cache-hit ratio for a model-invoking review", () => {
    const event = buildReviewCostEvent(timingInput());
    expect(event).not.toBeNull();
    expect(event?.input).toEqual({
      pr_owner: "edobry",
      pr_repo: "minsky",
      pr_number: 1867,
      head_sha: "abc123",
      model: "gpt-5",
      provider: "openai",
    });
    expect(event?.metadata).toEqual({
      source: REVIEW_COST_SOURCE,
      input_tokens: 30_000,
      output_tokens: 3_000,
      reasoning_tokens: 500,
      cached_tokens: 20_000,
      cache_hit_ratio: 20_000 / 30_000,
      cost_usd: 0.045,
      iteration_index: 2,
      scope_classification: "code",
    });
  });

  it("returns null for a pre-model skip-path input (no input tokens)", () => {
    expect(buildReviewCostEvent(timingInput({ inputTokens: null }))).toBeNull();
    expect(buildReviewCostEvent(timingInput({ inputTokens: undefined }))).toBeNull();
  });

  it("sets cache_hit_ratio null when cached tokens are absent", () => {
    const event = buildReviewCostEvent(timingInput({ cachedTokens: null }));
    expect(event?.metadata?.["cache_hit_ratio"]).toBeNull();
    expect(event?.metadata?.["cached_tokens"]).toBeNull();
  });
});

describe("emitReviewCostEvent", () => {
  it("emits exactly one event for a model-invoking review", async () => {
    const calls: unknown[] = [];
    const emit: EmitFn = async (e) => {
      calls.push(e);
    };
    await emitReviewCostEvent(timingInput(), emit);
    expect(calls).toHaveLength(1);
    expect((calls[0] as { metadata?: { source?: string } }).metadata?.source).toBe(
      REVIEW_COST_SOURCE
    );
  });

  it("does NOT emit for a skip-path input", async () => {
    const calls: unknown[] = [];
    const emit: EmitFn = async (e) => {
      calls.push(e);
    };
    await emitReviewCostEvent(timingInput({ inputTokens: null }), emit);
    expect(calls).toHaveLength(0);
  });

  it("never throws even when the emitter fails (instrumentation must not break reviews)", async () => {
    const emit: EmitFn = async () => {
      throw new Error("braintrust down");
    };
    // Must resolve, not reject.
    await expect(emitReviewCostEvent(timingInput(), emit)).resolves.toBeUndefined();
  });
});
