/**
 * Bound embedding input to the model's documented token limit (mt#4212).
 *
 * Embedding endpoints reject an over-length input with a permanent 400, not a
 * retryable error — so an untruncated input is a hard data-loss bug for the turn
 * it belongs to, and (before mt#4212's retry-service fix) it also tripped the
 * shared provider circuit breaker and took out every other embedding consumer in
 * the process.
 *
 * This lives at the SERVICE boundary rather than at a call site on purpose.
 * mt#2861 fixed the same failure inside `task-similarity-service.ts` — one of the
 * nine `generateEmbedding(s)` call sites — which protected task indexing and left
 * transcripts, memories, tools and knowledge sync unbounded. The 2026-08-17
 * incident was the transcript pipeline hitting the gap. A truncation a caller can
 * forget to apply is a truncation that will be forgotten; applying it inside the
 * embedding services means a new consumer is covered by construction.
 *
 * @see mt#2861 — the single-call-site fix this generalizes
 * @see ../tokenizer-service.ts — the model-aware tokenizer this uses
 */

import { log } from "@minsky/shared/logger";
import { safeTruncate } from "@minsky/shared/safe-truncate";
import { DefaultTokenizerService, type TokenizerService } from "../tokenizer-service";
import { getLoggableErrorSummary } from "../../errors/index";

/**
 * Documented maximum input tokens per embedding model.
 *
 * Deliberately a code table and not a config key. `task-similarity-service.ts`
 * read `embeddings.models[model].maxTokens` from configuration, but
 * `embeddingsConfigSchema` declares no `models` key — so that lookup could only
 * ever miss and fall through to its own hardcoded default map. Encoding the
 * limits directly says what actually happens.
 */
export const EMBEDDING_TOKEN_LIMITS: Readonly<Record<string, number>> = {
  "text-embedding-3-small": 8192,
  "text-embedding-3-large": 8192,
  "text-embedding-ada-002": 8192,
  "gemini-embedding-001": 2048,
};

/** Applied to any model not in {@link EMBEDDING_TOKEN_LIMITS}. */
export const DEFAULT_EMBEDDING_TOKEN_LIMIT = 8192;

/**
 * Headroom subtracted from the model limit before truncating.
 *
 * Slicing a token array and decoding it back to text is not exactly reversible
 * at the cut point — re-encoding the decoded string can yield a slightly
 * different token count, because the boundary token may merge with its
 * neighbour. This buffer absorbs that drift so a truncated input cannot land one
 * token over the limit.
 */
export const EMBEDDING_TOKEN_BUFFER = 192;

/**
 * Chars-per-token assumed by the fallback path when the tokenizer is unavailable.
 *
 * 3, not the intuitive 4. `tokenizer-service.ts` records the measurement: dense
 * markdown runs ~3 chars/token, so a 4-chars-per-token cap UNDER-truncates it —
 * which is how mt#2861 kept overflowing the 8192-token limit after nominally
 * truncating (38,547 chars capped to 32,000 is still ~10.6k tokens). The
 * fallback must over-truncate rather than under-truncate: a slightly short
 * embedding is a small recall cost, an over-length one is a dropped row.
 */
const FALLBACK_CHARS_PER_TOKEN = 3;

let sharedTokenizer: TokenizerService | null = null;

function getTokenizer(): TokenizerService {
  if (!sharedTokenizer) sharedTokenizer = new DefaultTokenizerService();
  return sharedTokenizer;
}

/** Replace the shared tokenizer. Test seam; pass `null` to restore the default. */
export function setEmbeddingTokenizerForTest(tokenizer: TokenizerService | null): void {
  sharedTokenizer = tokenizer;
}

/** Effective token budget for `model` — its limit less {@link EMBEDDING_TOKEN_BUFFER}. */
export function embeddingTokenBudget(model: string): number {
  const limit = EMBEDDING_TOKEN_LIMITS[model] ?? DEFAULT_EMBEDDING_TOKEN_LIMIT;
  return Math.max(1, limit - EMBEDDING_TOKEN_BUFFER);
}

/**
 * Truncate `text` so it fits `model`'s input-token budget. Text already within
 * budget is returned unchanged (identical reference).
 *
 * Never throws: a tokenizer failure degrades to the conservative char-based cap
 * rather than propagating, because the caller's alternative is sending an input
 * that is certain to 400.
 */
export async function truncateEmbeddingInput(
  text: string,
  model: string,
  provider?: string
): Promise<string> {
  const budget = embeddingTokenBudget(model);

  // A token is at least one character, so `length <= budget` proves the input is
  // within budget without tokenizing it. This is the common case — it keeps the
  // tokenizer off the hot path for the overwhelming majority of inputs.
  if (text.length <= budget) return text;

  try {
    const tokenizer = getTokenizer();
    const tokens = await tokenizer.tokenize(text, model, provider);
    if (tokens.length <= budget) return text;
    const truncated = await tokenizer.detokenize(tokens.slice(0, budget), model, provider);
    log.debug("Truncated embedding input to model token budget", {
      model,
      budget,
      originalTokens: tokens.length,
      originalChars: text.length,
      truncatedChars: truncated.length,
    });
    return truncated;
  } catch (err) {
    const maxChars = budget * FALLBACK_CHARS_PER_TOKEN;
    if (text.length <= maxChars) return text;
    log.warn("Tokenizer unavailable; truncating embedding input by character heuristic", {
      model,
      maxChars,
      originalChars: text.length,
      error: getLoggableErrorSummary(err),
    });
    // safeTruncate, not `.slice`: a raw slice can cut a UTF-16 surrogate pair in
    // half and emit a lone surrogate.
    return safeTruncate(text, maxChars, "head");
  }
}

/**
 * {@link truncateEmbeddingInput} over a batch.
 *
 * Batching is why this matters as much as it does: a provider rejects the whole
 * request when ANY input is over-length, so one oversize turn in a batch of 20
 * loses the other 19 turns too.
 */
export async function truncateEmbeddingInputs(
  texts: string[],
  model: string,
  provider?: string
): Promise<string[]> {
  return Promise.all(texts.map((t) => truncateEmbeddingInput(t, model, provider)));
}
