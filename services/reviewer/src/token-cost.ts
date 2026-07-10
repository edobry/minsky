/**
 * Per-review token-cost computation (mt#2288).
 *
 * Static per-model USD pricing map keyed by the provider model id
 * (`config.providerModel`, surfaced on `ReviewOutput.model`). Cost is computed
 * at WRITE time and frozen into `review_timing.cost_usd`, so a historical spend
 * record does not retroactively change when a provider reprices.
 *
 * Prices are USD per million tokens (MTok), transcribed from official pricing
 * docs (verified 2026-07-09):
 *   - Anthropic: https://platform.claude.com/docs/en/docs/about-claude/pricing
 *   - OpenAI:    https://developers.openai.com/api/docs/pricing
 *   - Google:    https://ai.google.dev/gemini-api/docs/pricing
 *
 * Only the models the reviewer actually configures (`REVIEWER_MODEL` defaults in
 * `config.ts`) plus their near siblings are priced. An UNKNOWN model yields a
 * null cost — tokens still persist and the cockpit shows tokens even when cost
 * is unknown. Prompt caching is NOT enabled on the reviewer's Anthropic path, so
 * cache-token pricing (0.1x read / 1.25x–2x write) is not modeled here; revisit
 * if caching or a cache-priced provider is enabled.
 */

interface ModelPrice {
  /** USD per million input (prompt) tokens. */
  inputPerMTok: number;
  /** USD per million output (completion) tokens. */
  outputPerMTok: number;
}

/**
 * Per-model USD/MTok rates. Keys are the exact `providerModel` strings the
 * reviewer emits on `ReviewOutput.model`.
 */
const USD_PER_MTOK: Record<string, ModelPrice> = {
  // Anthropic — https://platform.claude.com/docs/en/docs/about-claude/pricing
  "claude-sonnet-4-6": { inputPerMTok: 3, outputPerMTok: 15 }, // reviewer default
  "claude-sonnet-4-5": { inputPerMTok: 3, outputPerMTok: 15 },
  "claude-opus-4-5": { inputPerMTok: 5, outputPerMTok: 25 },
  "claude-opus-4-6": { inputPerMTok: 5, outputPerMTok: 25 },
  "claude-opus-4-7": { inputPerMTok: 5, outputPerMTok: 25 },
  "claude-opus-4-8": { inputPerMTok: 5, outputPerMTok: 25 },
  "claude-haiku-4-5": { inputPerMTok: 1, outputPerMTok: 5 },
  // OpenAI — https://developers.openai.com/api/docs/pricing
  "gpt-5": { inputPerMTok: 0.625, outputPerMTok: 5 }, // reviewer openai default
  // Google — https://ai.google.dev/gemini-api/docs/pricing (standard, <=200k ctx)
  "gemini-2.5-pro": { inputPerMTok: 1.25, outputPerMTok: 10 }, // reviewer google default
};

/**
 * Compute the USD cost of a single review from its model and token counts.
 *
 * Returns null when the model is unknown/absent OR both token counts are
 * absent (e.g. a pre-model skip-path row) — a null cost is the "not priced"
 * signal, distinct from a real $0.00.
 *
 * `completionTokens` already includes any reasoning tokens (they are a subset,
 * not an additional billed dimension), so reasoning tokens are NOT added again.
 */
export function computeCostUsd(
  model: string | null | undefined,
  promptTokens: number | null | undefined,
  completionTokens: number | null | undefined
): number | null {
  if (!model) return null;
  if (promptTokens == null && completionTokens == null) return null;
  const price = USD_PER_MTOK[model];
  if (!price) return null;
  const inTok = promptTokens ?? 0;
  const outTok = completionTokens ?? 0;
  const cost = (inTok * price.inputPerMTok + outTok * price.outputPerMTok) / 1_000_000;
  // Round to micro-dollar (6dp) granularity to match the numeric(12,6) column.
  return Math.round(cost * 1_000_000) / 1_000_000;
}

/** Minimal structural view of a review output for token/cost extraction. */
export interface TokenCostSource {
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    reasoningTokens?: number;
  };
  model: string;
}

/** The token/cost fields recorded on a `review_timing` row. */
export interface TimingTokenFields {
  inputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  costUsd: number | null;
}

/**
 * Build the `review_timing` token/cost fields from a review output. Threaded
 * into `recordReviewTiming` at the model-invoking timing-write sites; the two
 * pre-model skip paths (routing-skip, concurrent-inflight) omit these fields
 * entirely, so they persist as NULL.
 */
export function timingTokenFields(output: TokenCostSource): TimingTokenFields {
  const promptTokens = output.usage?.promptTokens ?? null;
  const completionTokens = output.usage?.completionTokens ?? null;
  const reasoningTokens = output.usage?.reasoningTokens ?? null;
  return {
    inputTokens: promptTokens,
    outputTokens: completionTokens,
    reasoningTokens,
    costUsd: computeCostUsd(output.model, promptTokens, completionTokens),
  };
}
