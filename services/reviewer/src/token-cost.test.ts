/**
 * Tests for per-review token-cost computation (mt#2288; cached-input mt#2721).
 */

import { describe, it, expect } from "bun:test";
import { computeCostUsd, timingTokenFields } from "./token-cost";

// Reviewer default model, reused across cases (avoids magic-string duplication).
const SONNET = "claude-sonnet-4-6";

describe("computeCostUsd", () => {
  it("prices the reviewer default model (claude-sonnet-4-6 @ $3/$15 per MTok)", () => {
    // 1000 input + 500 output = (1000*3 + 500*15) / 1e6 = 10500/1e6 = 0.0105
    expect(computeCostUsd(SONNET, 1000, 500)).toBe(0.0105);
  });

  it("prices a full MTok exactly (input + output rates sum)", () => {
    // 1e6 input + 1e6 output = $3 + $15 = $18.00
    expect(computeCostUsd(SONNET, 1_000_000, 1_000_000)).toBe(18);
  });

  it("prices openai gpt-5 ($1.25/$10 per MTok — mt#2718 audit rate)", () => {
    // 1e6 input + 1e6 output = $1.25 + $10 = $11.25
    expect(computeCostUsd("gpt-5", 1_000_000, 1_000_000)).toBe(11.25);
  });

  it("prices google gemini-2.5-pro ($1.25/$10 per MTok)", () => {
    expect(computeCostUsd("gemini-2.5-pro", 1_000_000, 1_000_000)).toBe(11.25);
  });

  it("returns null for an unknown model (tokens still persist upstream)", () => {
    expect(computeCostUsd("some-future-model", 1000, 500)).toBeNull();
  });

  it("returns null when the model is absent", () => {
    expect(computeCostUsd(null, 1000, 500)).toBeNull();
    expect(computeCostUsd(undefined, 1000, 500)).toBeNull();
  });

  it("returns null when both token counts are absent (skip-path row)", () => {
    expect(computeCostUsd(SONNET, null, null)).toBeNull();
    expect(computeCostUsd(SONNET, undefined, undefined)).toBeNull();
  });

  it("treats a single missing token count as zero, not null", () => {
    // output-only present: 500 * 15 / 1e6 = 0.0075
    expect(computeCostUsd(SONNET, null, 500)).toBe(0.0075);
  });

  it("rounds to micro-dollar (6dp) granularity", () => {
    // 1 input token @ $3/MTok = 0.000003; 1 output @ $15/MTok = 0.000015 → 0.000018
    expect(computeCostUsd(SONNET, 1, 1)).toBe(0.000018);
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

  it("treats absent cached tokens as zero (all input at full rate)", () => {
    // no cached arg: 1e6 * $1.25 / 1e6 = $1.25
    expect(computeCostUsd("gpt-5", 1_000_000, 0)).toBe(1.25);
    expect(computeCostUsd("gpt-5", 1_000_000, 0, null)).toBe(1.25);
  });
});

describe("timingTokenFields", () => {
  it("maps usage onto the timing columns and computes cost", () => {
    const fields = timingTokenFields({
      model: SONNET,
      usage: { promptTokens: 1000, completionTokens: 500, reasoningTokens: 120 },
    });
    expect(fields).toEqual({
      inputTokens: 1000,
      outputTokens: 500,
      reasoningTokens: 120,
      cachedTokens: null,
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
      usage: { promptTokens: 1_000_000, completionTokens: 1_000_000, reasoningTokens: 400_000 },
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
      usage: { promptTokens: 800, completionTokens: 200 },
    });
    expect(fields.inputTokens).toBe(800);
    expect(fields.outputTokens).toBe(200);
    expect(fields.costUsd).toBeNull();
  });
});
