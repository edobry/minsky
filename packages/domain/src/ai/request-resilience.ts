/**
 * Provider-agnostic resilience primitives for outbound AI provider requests:
 * the request timeout bound, and the error classifications the retry service
 * and circuit breaker depend on.
 *
 * These live in a neutral module rather than in any one provider's file because
 * every provider needs them. `embedding-service-gemini.ts` previously reached
 * into `embedding-service-openai.ts` for `isRetryableAIError` — a cross-provider
 * dependency that would only deepen as more shared behavior accrued (PR #2481
 * review).
 */
import { RateLimitError } from "./enhanced-error-types";

/**
 * Wall-clock bound on a single outbound provider request (mt#3444).
 *
 * Grounded in measured latency rather than a round number
 * (`decision-defaults §Thresholds`). Measured 2026-07-31 against the live
 * OpenAI embeddings endpoint over two runs (33 calls total), covering both
 * production shapes — reproduce with `bun scripts/measure-embedding-latency.ts`:
 *
 *   run 1  single input             p50 193ms  p90 236ms  max 312ms
 *          batch of 20 (~2KB each)  p50 368ms  p90 449ms  max 449ms
 *   run 2  single input             p50 173ms  p90 452ms  max 452ms
 *          batch of 20 (~2KB each)  p50 341ms  p90 361ms  max 361ms
 *
 * The batch shape is the real index path (`PerTurnEmbeddingPipeline.batchSize`
 * defaults to 20). Slowest LEGITIMATE call observed across both runs: 452ms.
 * This bound is ~33x that — wide enough that a request 30x slower than the
 * worst measured one still succeeds, tight enough that a genuine stall surfaces
 * in seconds instead of hanging until the caller's own timeout (or forever,
 * which is what it did before this bound existed).
 */
export const REQUEST_TIMEOUT_MS = 15_000;

/**
 * Whether `error` is the rejection produced by a request that exceeded its
 * {@link REQUEST_TIMEOUT_MS} bound.
 *
 * Classifies on `name`, not on the message: `AbortSignal.timeout` rejects with
 * a `TimeoutError` whose message is the prose `"The operation timed out."`,
 * which matches NONE of the tokens in {@link isRetryableAIError}'s regex
 * (`ETIMEDOUT` does not match "timed out"). Measured against the installed
 * runtime, not assumed. `name` is a structured contract; the message is vendor
 * prose that can change.
 *
 * Deliberately does NOT match `AbortError`. That is what a caller-initiated
 * `controller.abort()` produces — a deliberate cancellation, which must not be
 * retried. Only the timeout bound this module sets is retryable.
 */
export function isRequestTimeoutError(error: unknown): boolean {
  return String((error as Error)?.name || "") === "TimeoutError";
}

/**
 * Determines whether an AI service error is retryable.
 * Retries on transient rate limits, server errors, and network issues.
 * Does NOT retry on quota exhaustion (billing issue).
 */
export function isRetryableAIError(error: unknown): boolean {
  const msg = String((error as Error)?.message || "");
  if (/insufficient_quota/i.test(msg)) return false;
  if (error instanceof RateLimitError) return true;
  if (isRequestTimeoutError(error)) return true;
  return /429|rate.limit|502|Bad Gateway|503|Service Unavailable|ECONNRESET|ETIMEDOUT/i.test(msg);
}

/**
 * Determines whether a Google Docs / Drive API error is retryable.
 *
 * Retryable:
 *   - 401 (token expired – caller will refresh and retry)
 *   - 403 with reason userRateLimitExceeded or quotaExceeded (transient quota)
 *   - 429 (Too Many Requests)
 *   - 5xx / 503 (server errors)
 *
 * Not retryable:
 *   - 404 (document not found)
 *   - 400 (bad request – permanent)
 *   - 403 with other reasons (e.g. insufficientPermissions)
 */
export function isRetryableGoogleDocsError(error: unknown): boolean {
  const msg = String((error as Error)?.message || "");
  // Non-retryable status codes
  if (/Google (Docs|Drive) API error: 404/i.test(msg)) return false;
  if (/Google (Docs|Drive) API error: 400/i.test(msg)) return false;
  // 403 — only retry if reason is quota-related
  if (/Google (Docs|Drive) API error: 403/i.test(msg)) {
    return /userRateLimitExceeded|quotaExceeded/i.test(msg);
  }
  // Retryable: 401, 429, 5xx, 503, network errors
  return (
    /Google (Docs|Drive) API error: (401|429|5\d\d)/i.test(msg) ||
    /429|503|Service Unavailable|ECONNRESET|ETIMEDOUT/i.test(msg)
  );
}
