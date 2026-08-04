/**
 * Tests for per-review token-cost computation (mt#2288; cached-input mt#2721;
 * not-recorded-is-not-zero mt#3665).
 */

import { describe, it, expect } from "bun:test";
import { computeCostUsd, timingTokenFields } from "./token-cost";

// Reviewer default model, reused across cases (avoids magic-string duplication).
const SONNET = "claude-sonnet-4-6";

describe("computeCostUsd", () => {
  it("prices the reviewer default model (claude-sonnet-4-6 @ $3/$15 per MTok)", () => {
    // 1000 input + 500 output = (1000*3 + 500*15) / 1e6 = 10500/1e6 = 0.0105
    expect(computeCostUsd(SONNET, 1000, 500, 0)).toBe(0.0105);
  });

  it("prices a full MTok exactly (input + output rates sum)", () => {
    // 1e6 input + 1e6 output = $3 + $15 = $18.00
    expect(computeCostUsd(SONNET, 1_000_000, 1_000_000, 0)).toBe(18);
  });

  it("prices openai gpt-5 ($1.25/$10 per MTok — mt#2718 audit rate)", () => {
    // 1e6 input + 1e6 output = $1.25 + $10 = $11.25
    expect(computeCostUsd("gpt-5", 1_000_000, 1_000_000, 0)).toBe(11.25);
  });

  it("prices google gemini-2.5-pro ($1.25/$10 per MTok)", () => {
    expect(computeCostUsd("gemini-2.5-pro", 1_000_000, 1_000_000, 0)).toBe(11.25);
  });

  it("returns null for an unknown model (tokens still persist upstream)", () => {
    expect(computeCostUsd("some-future-model", 1000, 500, 0)).toBeNull();
  });

  it("returns null when the model is absent", () => {
    expect(computeCostUsd(null, 1000, 500, 0)).toBeNull();
    expect(computeCostUsd(undefined, 1000, 500, 0)).toBeNull();
  });

  it("returns null when both token counts are absent (skip-path row)", () => {
    expect(computeCostUsd(SONNET, null, null, 0)).toBeNull();
    expect(computeCostUsd(SONNET, undefined, undefined, 0)).toBeNull();
  });

  it("treats a single missing token count as zero, not null", () => {
    // output-only present: 500 * 15 / 1e6 = 0.0075
    expect(computeCostUsd(SONNET, null, 500, 0)).toBe(0.0075);
  });

  it("rounds to micro-dollar (6dp) granularity", () => {
    // 1 input token @ $3/MTok = 0.000003; 1 output @ $15/MTok = 0.000015 → 0.000018
    expect(computeCostUsd(SONNET, 1, 1, 0)).toBe(0.000018);
  });

  it("prices cached input at 0.1x the base rate (gpt-5)", () => {
    // 1e6 prompt all cached, 0 completion: 1e6 * $1.25 * 0.1 / 1e6 = $0.125
    expect(computeCostUsd("gpt-5", 1_000_000, 0, 1_000_000)).toBe(0.125);
  });

  it("mixes cached + uncached input at their respective rates (gpt-5)", () => {
    // 1e6 prompt, 400k cached: 600k*$1.25 + 400k*$0.125 = (750000 + 50000)/1e6 = $0.80
    expect(computeCostUsd("gpt-5", 1_000_000, 0, 400_000)).toBe(0.8);
  });

  it("clamps cached tokens to the prompt total (bad count can't go negative)", () => {
    // cached (999999) clamped to prompt (1000): 1000 * $1.25 * 0.1 / 1e6 = 0.000125
    expect(computeCostUsd("gpt-5", 1000, 0, 999_999)).toBe(0.000125);
  });

  it("prices an explicit zero-cached prompt at the full input rate", () => {
    // A provider with no caching reports 0 — a real observation, priced in full.
    expect(computeCostUsd("gpt-5", 1_000_000, 0, 0)).toBe(1.25);
  });

  // mt#3665. This case previously asserted 1.25 — i.e. it encoded the defect as
  // the correct invariant, which is why 25 days of mis-pricing passed a green
  // suite. "Not recorded" and "zero cached" are 10x apart in price and must not
  // collapse onto the expensive one.
  it("returns null (unpriceable) when the cached count was not recorded", () => {
    expect(computeCostUsd("gpt-5", 1_000_000, 0, null)).toBeNull();
  });

  it("still prices an output-only row when cached is unrecorded (no prompt to misprice)", () => {
    // The unpriceable rule is scoped to rows with real prompt tokens; with none,
    // an unrecorded cache count cannot distort anything.
    expect(computeCostUsd(SONNET, null, 500, null)).toBe(0.0075);
  });

  // Spec AT2: the discount must be visible in the PRICE, so a regression to the
  // null-clamp path is caught by cost rather than only by the field's presence.
  it("prices an 85%-cached MTok far below the same prompt uncached", () => {
    const cached = computeCostUsd("gpt-5", 1_000_000, 0, 850_000);
    const uncached = computeCostUsd("gpt-5", 1_000_000, 0, 0);
    // 150k*$1.25 + 850k*$0.125 = (187500 + 106250)/1e6 = $0.29375 — a 4.3x spread
    // against the same prompt priced uncached, which is the whole point of the
    // discount and the size of the error when the count goes unrecorded.
    expect(cached).toBe(0.29375);
    expect(uncached).toBe(1.25);
  });
});

describe("timingTokenFields", () => {
  it("maps usage onto the timing columns and computes cost", () => {
    const fields = timingTokenFields({
      model: SONNET,
      usage: { promptTokens: 1000, completionTokens: 500, reasoningTokens: 120, cachedTokens: 0 },
    });
    expect(fields).toEqual({
      inputTokens: 1000,
      outputTokens: 500,
      reasoningTokens: 120,
      cachedTokens: 0,
      costUsd: 0.0105,
    });
  });

  it("maps cached tokens and applies the cache discount to cost", () => {
    // gpt-5, 1e6 prompt / 0 completion / 400k cached → cost $0.80 (see computeCostUsd test)
    const fields = timingTokenFields({
      model: "gpt-5",
      usage: { promptTokens: 1_000_000, completionTokens: 0, cachedTokens: 400_000 },
    });
    expect(fields.cachedTokens).toBe(400_000);
    expect(fields.inputTokens).toBe(1_000_000);
    expect(fields.costUsd).toBe(0.8);
  });

  it("does NOT add reasoning tokens into cost (they are a subset of output)", () => {
    // cost must match the prompt/completion-only computation regardless of reasoning
    const withReasoning = timingTokenFields({
      model: "gpt-5",
      usage: {
        promptTokens: 1_000_000,
        completionTokens: 1_000_000,
        reasoningTokens: 400_000,
        cachedTokens: 0,
      },
    });
    expect(withReasoning.costUsd).toBe(11.25);
  });

  it("yields all-null fields when usage is absent (pre-model / no-usage path)", () => {
    expect(timingTokenFields({ model: SONNET })).toEqual({
      inputTokens: null,
      outputTokens: null,
      reasoningTokens: null,
      cachedTokens: null,
      costUsd: null,
    });
  });

  it("persists tokens but null cost for an unpriced model", () => {
    const fields = timingTokenFields({
      model: "unpriced-model",
      usage: { promptTokens: 800, completionTokens: 200, cachedTokens: 0 },
    });
    expect(fields.inputTokens).toBe(800);
    expect(fields.outputTokens).toBe(200);
    expect(fields.costUsd).toBeNull();
  });
});
