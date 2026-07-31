/**
 * Tests for context-window resolution in the generate command (mt#3390).
 *
 * The defect these cover: `getModelContextWindow` used to be a hardcoded table
 * ending in `includes()` fall-through branches. Current Claude model ids matched
 * no entry and no branch, so `claude-opus-5` took the 100,000 "conservative
 * fallback" against a real 1,000,000-token window and the operator-facing
 * utilization percentage was inflated tenfold.
 */

import { describe, expect, test } from "bun:test";
import {
  analyzeGeneratedContext,
  formatContextWindowSize,
  formatContextWindowUtilization,
  getModelContextWindow,
  UNKNOWN_CONTEXT_WINDOW_LABEL,
  UNKNOWN_UTILIZATION_LABEL,
  type CachedModelLimitSource,
} from "./generate-analysis";
import { displayAnalysisResults } from "./generate-display";
import { displayContextVisualization } from "./generate-visualization";
import { getFallbackModels, getPrimaryModels } from "@minsky/domain/ai/model-catalog";
import type { AnalysisResult, GenerateResult } from "./generate-types";

/** Limits as returned by the live Anthropic listing, measured in mt#3379. */
const LIVE_ANTHROPIC_CONTEXT_WINDOW = 1_000_000;

/** What the deleted hardcoded table would have reported for `claude-opus-5`. */
const OLD_FALLTHROUGH_VALUE = 100_000;

function stubCache(
  byProvider: Record<string, { id: string; contextWindow: number }[]>
): CachedModelLimitSource {
  return { getAllCachedModels: async () => byProvider };
}

const anthropicCache = stubCache({
  anthropic: [
    { id: "claude-opus-5", contextWindow: LIVE_ANTHROPIC_CONTEXT_WINDOW },
    { id: "claude-haiku-4-5-20251001", contextWindow: 200_000 },
  ],
  openai: [{ id: "gpt-4o", contextWindow: 128_000 }],
});

function resultWithTokens(totalTokens: number): GenerateResult {
  return {
    content: "",
    components: [],
    metadata: { generationTime: 1, totalTokens, skipped: [], errors: [] },
  };
}

describe("getModelContextWindow", () => {
  // AT1: the reported window matches the model's live value, not 200,000.
  test("AT1: resolves a current Claude model to its live window, not a hardcoded default", async () => {
    const window = await getModelContextWindow("claude-opus-5", anthropicCache);

    expect(window).toBe(LIVE_ANTHROPIC_CONTEXT_WINDOW);
    // The two values the deleted table would have produced for this id.
    expect(window).not.toBe(200_000);
    expect(window).not.toBe(OLD_FALLTHROUGH_VALUE);
  });

  test("resolves a model under a non-first provider by searching every provider", async () => {
    expect(await getModelContextWindow("gpt-4o", anthropicCache)).toBe(128_000);
  });

  // Success criterion 5: an absent model gets no plausible-looking number.
  test("returns null for a model absent from the cache rather than guessing", async () => {
    expect(await getModelContextWindow("claude-not-a-real-model", anthropicCache)).toBeNull();
    // A prefix that the old `includes("claude")` branch would have caught.
    expect(await getModelContextWindow("claude-opus-6", anthropicCache)).toBeNull();
    expect(await getModelContextWindow("gpt-5-turbo", anthropicCache)).toBeNull();
  });

  test("returns null when the cache cannot be read", async () => {
    const broken: CachedModelLimitSource = {
      getAllCachedModels: async () => {
        throw new Error("cache directory unreadable");
      },
    };

    expect(await getModelContextWindow("claude-opus-5", broken)).toBeNull();
  });

  test("resolves an id present under two providers deterministically", async () => {
    const duplicated = stubCache({
      zeta: [{ id: "shared-model", contextWindow: 2 }],
      alpha: [{ id: "shared-model", contextWindow: 1 }],
    });

    // Sorted provider order means "alpha" wins on every run.
    expect(await getModelContextWindow("shared-model", duplicated)).toBe(1);
    expect(await getModelContextWindow("shared-model", duplicated)).toBe(1);
  });
});

describe("analyzeGeneratedContext context-window reporting", () => {
  // AT2: utilization changes by the expected ratio once the window is correct.
  test("AT2: utilization for a fixed token count reflects the corrected window", async () => {
    const totalTokens = 50_000;

    const analysis = await analyzeGeneratedContext(
      resultWithTokens(totalTokens),
      { model: "claude-opus-5" },
      anthropicCache
    );

    expect(analysis.metadata.contextWindowSize).toBe(LIVE_ANTHROPIC_CONTEXT_WINDOW);
    expect(analysis.summary.contextWindowUtilization).toBeCloseTo(5, 5);

    // The old table's fall-through would have divided by 100,000 instead, so the
    // reported figure was 10x too high for the same token count.
    const utilizationUnderOldValue = (totalTokens / OLD_FALLTHROUGH_VALUE) * 100;
    expect(utilizationUnderOldValue).toBeCloseTo(50, 5);
    expect(utilizationUnderOldValue / (analysis.summary.contextWindowUtilization as number)).toBe(
      10
    );
  });

  test("reports unknown rather than a percentage when the model is not cached", async () => {
    const analysis = await analyzeGeneratedContext(
      resultWithTokens(50_000),
      { model: "claude-opus-6" },
      anthropicCache
    );

    expect(analysis.metadata.contextWindowSize).toBeNull();
    expect(analysis.summary.contextWindowUtilization).toBeNull();
  });
});

describe("context-window display formatting", () => {
  test("renders an unknown window and utilization without inventing a number", () => {
    expect(formatContextWindowSize(null)).toBe(UNKNOWN_CONTEXT_WINDOW_LABEL);
    expect(formatContextWindowSize(null)).not.toMatch(/\d/);

    expect(formatContextWindowUtilization(null)).toBe(UNKNOWN_UTILIZATION_LABEL);
    expect(formatContextWindowUtilization(null, { compact: true })).toBe("unknown");
    expect(formatContextWindowUtilization(null)).not.toMatch(/\d/);
  });

  test("renders known values", () => {
    // Asserted structurally rather than against a literal "1,000,000": the
    // separator toLocaleString emits is locale-dependent and CI need not run
    // under en-US.
    const rendered = formatContextWindowSize(LIVE_ANTHROPIC_CONTEXT_WINDOW);
    expect(rendered).toBe(`${LIVE_ANTHROPIC_CONTEXT_WINDOW.toLocaleString()} tokens`);
    expect(rendered.replace(/\D/g, "")).toBe("1000000");

    expect(formatContextWindowUtilization(5)).toBe("5.0%");
    expect(formatContextWindowUtilization(5, { compact: true })).toBe("5.0%");
  });

  // The comparison table pads this cell to 12 characters; a longer value would
  // silently break the column alignment.
  test("compact utilization fits the comparison table's 12-character column", () => {
    const COMPARISON_COLUMN_WIDTH = 12;

    expect(formatContextWindowUtilization(null, { compact: true }).length).toBeLessThanOrEqual(
      COMPARISON_COLUMN_WIDTH
    );
    expect(formatContextWindowUtilization(100, { compact: true }).length).toBeLessThanOrEqual(
      COMPARISON_COLUMN_WIDTH
    );
  });
});

describe("display paths tolerate an unknown context window", () => {
  // Before mt#3390 these three call sites formatted with .toLocaleString() /
  // .toFixed() directly, so a null window would have thrown at render time.
  // This is the regression class the nullability change introduced.
  const unknownAnalysis: AnalysisResult = {
    metadata: {
      model: "claude-opus-6",
      tokenizer: { name: "tiktoken", encoding: "cl100k_base", description: "OpenAI tokenizer" },
      interface: "cli",
      contextWindowSize: null,
      analysisTimestamp: new Date(0).toISOString(),
      generationTime: 1,
    },
    summary: {
      totalTokens: 50_000,
      totalComponents: 1,
      averageTokensPerComponent: 50_000,
      largestComponent: "environment",
      contextWindowUtilization: null,
    },
    componentBreakdown: [
      { component: "environment", tokens: 50_000, percentage: "100.0", content_length: 10 },
    ],
    optimizations: [],
    fullResult: resultWithTokens(50_000),
  };

  test("the analysis display renders without throwing", () => {
    expect(() => displayAnalysisResults(unknownAnalysis, {})).not.toThrow();
  });

  test("the visualization display renders without throwing", () => {
    expect(() =>
      displayContextVisualization(unknownAnalysis, { chartType: "bar", maxWidth: "80" })
    ).not.toThrow();
  });
});

describe("fallback model catalog", () => {
  const providerConfig: Parameters<typeof getPrimaryModels>[1] = {
    provider: "anthropic",
    supportedCapabilities: [],
  };

  // AT3: the cache-unavailable path yields correct limits for a current model.
  test("AT3: primary catalog reports a current Claude model with its real limits", () => {
    const models = getPrimaryModels("anthropic", providerConfig);
    const opus = models?.find((m) => m.id === "claude-opus-5");

    expect(opus).toBeDefined();
    expect(opus?.contextWindow).toBe(LIVE_ANTHROPIC_CONTEXT_WINDOW);
    expect(opus?.maxOutputTokens).toBe(128_000);
  });

  test("AT3: minimal fallback catalog reports the same corrected limits", () => {
    const models = getFallbackModels("anthropic", providerConfig);

    expect(models[0]?.id).toBe("claude-opus-5");
    expect(models[0]?.contextWindow).toBe(LIVE_ANTHROPIC_CONTEXT_WINDOW);
    expect(models[0]?.maxOutputTokens).toBe(128_000);
  });

  test("carries no retired Anthropic model ids", () => {
    const ids = [
      ...(getPrimaryModels("anthropic", providerConfig) ?? []),
      ...getFallbackModels("anthropic", providerConfig),
    ].map((m) => m.id);

    // Absent from the live Anthropic listing as of 2026-07-31 (mt#3379/mt#3389).
    expect(ids).not.toContain("claude-3-5-sonnet-20241022");
    expect(ids).not.toContain("claude-3-5-haiku-20241022");
  });

  test("omits cost for Anthropic models, which the API does not publish", () => {
    const models = getPrimaryModels("anthropic", providerConfig) ?? [];

    expect(models.length).toBeGreaterThan(0);
    for (const model of models) {
      expect(model.costPer1kTokens).toBeUndefined();
    }
  });
});
