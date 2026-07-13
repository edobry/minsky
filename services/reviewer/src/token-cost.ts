/**
 * Per-review token-cost computation (mt#2288; cached-input modeling mt#2721).
 *
 * Static per-model USD pricing map keyed by the provider model id
 * (`config.providerModel`, surfaced on `ReviewOutput.model`). Cost is computed
 * at WRITE time and frozen into `review_timing.cost_usd`, so a historical spend
 * record does not retroactively change when a provider reprices.
 *
 * Prices are USD per million tokens (MTok), transcribed from official pricing
 * docs (base rates verified 2026-07-09; cached multiplier + gpt-5 rate 2026-07-10):
 *   - Anthropic: https://platform.claude.com/docs/en/docs/about-claude/pricing
 *   - OpenAI:    https://developers.openai.com/api/docs/pricing
 *   - Google:    https://ai.google.dev/gemini-api/docs/pricing
 *
 * Cached input is billed at 0.1x the base input rate — confirmed consistent
 * across every current OpenAI model (gpt-5.6-luna $1.00/$0.10, gpt-5.4
 * $2.50/$0.25) and Anthropic cache-read. See CACHED_INPUT_DISCOUNT.
 *
 * Only the models the reviewer actually configures (`REVIEWER_MODEL` defaults in
 * `config.ts`) plus their near siblings are priced. An UNKNOWN model yields a
 * null cost — tokens still persist and the cockpit shows tokens even when cost
 * is unknown.
 */

interface ModelPrice {
  /** USD per million input (prompt) tokens. */
  inputPerMTok: number;
  /** USD per million output (completion) tokens. */
  outputPerMTok: number;
}

/**
 * Cached-input billing multiplier relative to the base input rate. OpenAI bills
 * cached input at 0.1x across all current models; Anthropic cache-read is also
 * 0.1x. Uniform, so derived rather than stored per-model.
 */
const CACHED_INPUT_DISCOUNT = 0.1;

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
  // gpt-5 is the deployed reviewer model (verified via /health) and is now an
  // "earlier model" delisted from OpenAI's current pricing page. Rate is from
  // the mt#2718 audit's real reviewer billing ($1.25/$10); mt#2288 previously
  // used a wrong generic-search value ($0.625/$5). RESIDUAL UNCERTAINTY: if
  // "gpt-5" now bills at gpt-5.4 rates it is $2.50/$15 — confirm from the OpenAI
  // billing dashboard. cached input derives at 0.1x = $0.125/MTok.
  "gpt-5": { inputPerMTok: 1.25, outputPerMTok: 10 }, // reviewer openai default
  // Google — https://ai.google.dev/gemini-api/docs/pricing (standard, <=200k ctx)
  "gemini-2.5-pro": { inputPerMTok: 1.25, outputPerMTok: 10 }, // reviewer google default
};

/**
 * Compute the USD cost of a single review from its model and token counts.
 *
 * Returns null when the model is unknown/absent OR both prompt+completion token
 * counts are absent (e.g. a pre-model skip-path row) — a null cost is the "not
 * priced" signal, distinct from a real $0.00.
 *
 * `cachedTokens` is the subset of prompt tokens served from cache; it is billed
 * at CACHED_INPUT_DISCOUNT x the base input rate. `completionTokens` already
 * includes any reasoning tokens (a subset, not an additional billed dimension),
 * so reasoning tokens are NOT added again.
 */
export function computeCostUsd(
  model: string | null | undefined,
  promptTokens: number | null | undefined,
  completionTokens: number | null | undefined,
  cachedTokens?: number | null | undefined
): number | null {
  if (!model) return null;
  if (promptTokens == null && completionTokens == null) return null;
  const price = USD_PER_MTOK[model];
  if (!price) return null;
  const inTok = promptTokens ?? 0;
  const outTok = completionTokens ?? 0;
  // Clamp cached to [0, inTok] so a bad count can't yield negative uncached input.
  const cachedTok = Math.min(Math.max(cachedTokens ?? 0, 0), inTok);
  const uncachedInTok = inTok - cachedTok;
  const cost =
    (uncachedInTok * price.inputPerMTok +
      cachedTok * price.inputPerMTok * CACHED_INPUT_DISCOUNT +
      outTok * price.outputPerMTok) /
    1_000_000;
  // Round to micro-dollar (6dp) granularity to match the numeric(12,6) column.
  return Math.round(cost * 1_000_000) / 1_000_000;
}

/** Minimal structural view of a review output for token/cost extraction. */
export interface TokenCostSource {
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    reasoningTokens?: number;
    cachedTokens?: number;
  };
  model: string;
}

/** The token/cost fields recorded on a `review_timing` row. */
export interface TimingTokenFields {
  inputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  cachedTokens: number | null;
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
  const cachedTokens = output.usage?.cachedTokens ?? null;
  return {
    inputTokens: promptTokens,
    outputTokens: completionTokens,
    reasoningTokens,
    cachedTokens,
    costUsd: computeCostUsd(output.model, promptTokens, completionTokens, cachedTokens),
  };
}
