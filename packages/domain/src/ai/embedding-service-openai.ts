import { injectable } from "tsyringe";
import { getConfiguration } from "../configuration";
import type { EmbeddingService } from "./embeddings/types";
import { RateLimitError } from "./enhanced-error-types";
import { IntelligentRetryService } from "./intelligent-retry-service";
import { EmbeddingsHealthTracker } from "./embeddings-health-tracker";

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
 * Whether `error` is the rejection produced by a request that exceeded its
 * {@link REQUEST_TIMEOUT_MS} bound.
 *
 * Classifies on `name`, not on the message: `AbortSignal.timeout` rejects with
 * a `TimeoutError` whose message is the prose `"The operation timed out."`,
 * which matches NONE of the tokens in `isRetryableAIError`'s regex (`ETIMEDOUT`
 * does not match "timed out"). Measured against the installed runtime, not
 * assumed. `name` is a structured contract; the message is vendor prose that
 * can change.
 *
 * Deliberately does NOT match `AbortError`. That is what a caller-initiated
 * `controller.abort()` produces — a deliberate cancellation, which must not be
 * retried. Only the timeout bound this module sets is retryable.
 */
export function isRequestTimeoutError(error: unknown): boolean {
  return String((error as Error)?.name || "") === "TimeoutError";
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

interface OpenAIEmbeddingResponse {
  data: Array<{ embedding: number[] }>;
}

const sharedRetryService = new IntelligentRetryService({
  maxRetries: 3,
  baseDelay: 500,
});

/**
 * Wall-clock bound on a single embeddings HTTP request (mt#3444).
 *
 * Grounded in measured latency rather than a round number
 * (`decision-defaults §Thresholds`). Measured 2026-07-31 against the live
 * endpoint over two runs (33 calls total), covering both production shapes —
 * reproduce with `bun scripts/measure-embedding-latency.ts`:
 *
 *   run 1  single input             p50 193ms  p90 236ms  max 312ms
 *          batch of 20 (~2KB each)  p50 368ms  p90 449ms  max 449ms
 *   run 2  single input             p50 173ms  p90 452ms  max 452ms
 *          batch of 20 (~2KB each)  p50 341ms  p90 361ms  max 361ms
 *
 * The batch shape is the real index path (`PerTurnEmbeddingPipeline.batchSize`
 * defaults to 20). Slowest LEGITIMATE call observed across both runs: 452ms.
 * The bound below is ~33x that — wide enough that a request 30x slower than the
 * worst measured one still succeeds, tight enough that a genuine stall surfaces
 * in seconds instead of hanging until the caller's own timeout (or forever,
 * which is what it did before this bound existed).
 */
export const REQUEST_TIMEOUT_MS = 15_000;

@injectable()
export class OpenAIEmbeddingService implements EmbeddingService {
  private readonly apiKey: string;
  private readonly baseURL: string;
  private readonly model: string;
  private readonly retryService: IntelligentRetryService;
  private readonly requestTimeoutMs: number;

  /**
   * `retryService` (mt#2980): optional injectable retry-config seam, following
   * the `postgres-channel-listener.ts` `RetryConfig` precedent. Defaults to
   * the module-level `sharedRetryService` singleton (preserving the existing
   * production behavior — one circuit breaker shared across every
   * `OpenAIEmbeddingService` instance created via `fromConfig()`). Tests can
   * inject a fast `IntelligentRetryService` (tiny `baseDelay`/`maxDelay` and
   * `jitterMaxMs: 0`) to exercise the real retry loop without real delays.
   *
   * Circuit-breaker isolation: passing a custom `retryService` gives this
   * instance its OWN circuit-breaker state, isolated from the shared
   * singleton's — the right behavior for tests (each test wants a fresh
   * breaker) but a future production caller that wants the shared
   * cross-instance breaker must NOT pass this param.
   *
   * `@injectable()` note: this class is never resolved via the tsyringe
   * container in production — `apiKey`/`baseURL`/`model` are unannotated
   * primitive params tsyringe cannot auto-inject by type, and the sole
   * production construction site is the static `fromConfig()` factory below,
   * which calls `new OpenAIEmbeddingService(apiKey, baseURL, model)` (3 args;
   * `retryService` defaults to `sharedRetryService`). Verified empirically:
   * grepping the whole repo for `OpenAIEmbeddingService` turns up only this
   * file, this file's test, and `embedding-service-factory.ts`'s
   * `fromConfig()` call — no `container.resolve(OpenAIEmbeddingService)` or
   * DI registration exists anywhere.
   */
  constructor(
    apiKey: string,
    baseURL?: string,
    model?: string,
    retryService?: IntelligentRetryService,
    requestTimeoutMs?: number
  ) {
    this.apiKey = apiKey;
    this.baseURL = baseURL || "https://api.openai.com/v1";
    this.model = model || "text-embedding-3-small";
    this.retryService = retryService ?? sharedRetryService;
    this.requestTimeoutMs = requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  }

  static async fromConfig(): Promise<OpenAIEmbeddingService> {
    const config = await getConfiguration();
    const providerCfg = config.ai?.providers?.openai;

    const apiKey = providerCfg?.apiKey;
    if (!apiKey) {
      throw new Error(
        "OpenAI provider not configured. Set ai.providers.openai.apiKey in configuration."
      );
    }

    const baseURL = providerCfg?.baseUrl;
    const model = config.embeddings?.model || providerCfg?.model || "text-embedding-3-small";

    return new OpenAIEmbeddingService(apiKey, baseURL, model);
  }

  async generateEmbedding(content: string): Promise<number[]> {
    const resp = await this.requestWithRetry([content]);
    if (!resp.data?.[0]?.embedding) throw new Error("Invalid embedding response");
    return resp.data[0].embedding;
  }

  async generateEmbeddings(contents: string[]): Promise<number[][]> {
    const resp = await this.requestWithRetry(contents);
    return resp.data.map((d) => d.embedding);
  }

  private async requestWithRetry(inputs: string[]) {
    try {
      const result = await this.retryService.execute(
        async () => this.request(inputs),
        isRetryableAIError,
        "openai-embeddings"
      );
      EmbeddingsHealthTracker.getInstance().recordRecovery();
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // `timeout` is checked FIRST and by error name: a stalled request is a
      // distinct operational condition from an error the API returned, and it
      // would otherwise fall through to "unknown" — the bucket that tells an
      // operator nothing (mt#3444).
      const errorCode = isRequestTimeoutError(err)
        ? "timeout"
        : /insufficient_quota/i.test(msg)
          ? "insufficient_quota"
          : /circuit.breaker.is.open/i.test(msg)
            ? "circuit_breaker_open"
            : /429|rate.limit/i.test(msg)
              ? "rate_limit"
              : "unknown";
      await EmbeddingsHealthTracker.getInstance().recordError("openai", errorCode, msg);
      throw err;
    }
  }

  private async request(inputs: string[]): Promise<OpenAIEmbeddingResponse> {
    const url = `${this.baseURL.replace(/\/$/, "")}/embeddings`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ model: this.model, input: inputs }),
      // Without this the request can hang forever: a server that accepts the
      // connection and never responds leaves the promise pending, so the
      // surrounding retry service never sees a rejection to retry and the
      // circuit breaker never counts it (mt#3444).
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    });

    if (!res.ok) {
      // Try to parse a helpful JSON error first
      let extra: string = "";
      let errorCode: string | undefined;
      try {
        const asJson: unknown = await res.json();
        const obj = asJson as { error?: { code?: unknown; type?: unknown; message?: unknown } };
        const err = obj?.error || obj;
        const errObj = err as { code?: unknown; type?: unknown; message?: unknown };
        errorCode = errObj?.code ? String(errObj.code) : undefined;
        const parts: string[] = [];
        if (errObj?.code) parts.push(`code=${String(errObj.code)}`);
        if (errObj?.type) parts.push(`type=${String(errObj.type)}`);
        if (errObj?.message) parts.push(`message=${String(errObj.message)}`);
        extra = parts.length > 0 ? ` - ${parts.join(", ")}` : ` ${JSON.stringify(asJson)}`;
      } catch {
        const text = await res.text().catch(() => "");
        extra = text ? ` ${text}` : "";
      }

      // Handle 429 rate limit responses with structured error
      if (res.status === 429 && errorCode !== "insufficient_quota") {
        const retryAfterHeader = res.headers.get("retry-after");
        const resetHeader = res.headers.get("x-ratelimit-reset-requests");
        const remainingHeader = res.headers.get("x-ratelimit-remaining-requests");
        const limitHeader = res.headers.get("x-ratelimit-limit-requests");
        const retryAfter = retryAfterHeader
          ? Number(retryAfterHeader)
          : resetHeader
            ? Number(resetHeader)
            : 60;
        throw new RateLimitError(
          `Embedding rate limited: 429${extra}`.trim(),
          "openai",
          isNaN(retryAfter) ? 60 : retryAfter,
          remainingHeader ? Number(remainingHeader) : 0,
          limitHeader ? Number(limitHeader) : 0
        );
      }

      throw new Error(`Embedding request failed: ${res.status} ${res.statusText}${extra}`.trim());
    }
    return (await res.json()) as OpenAIEmbeddingResponse;
  }
}
