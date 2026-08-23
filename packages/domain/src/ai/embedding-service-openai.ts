import { injectable } from "tsyringe";
import { getConfiguration } from "../configuration";
import type { EmbeddingService } from "./embeddings/types";
import { truncateEmbeddingInput, truncateEmbeddingInputs } from "./embeddings/truncate-input";
import { ProviderInputError, RateLimitError } from "./enhanced-error-types";
import { IntelligentRetryService } from "./intelligent-retry-service";
import { EmbeddingsHealthTracker } from "./embeddings-health-tracker";
import {
  isRetryableAIError,
  isRequestTimeoutError,
  REQUEST_TIMEOUT_MS,
} from "./request-resilience";

// `isRetryableAIError` / `isRequestTimeoutError` / `REQUEST_TIMEOUT_MS` are
// provider-agnostic and live in `./request-resilience` so no provider has to
// import from another provider's module (PR #2481 review).

interface OpenAIEmbeddingResponse {
  data: Array<{ embedding: number[] }>;
}

const sharedRetryService = new IntelligentRetryService({
  maxRetries: 3,
  baseDelay: 500,
});

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
    const bounded = await truncateEmbeddingInput(content, this.model, "openai");
    const resp = await this.requestWithRetry([bounded]);
    if (!resp.data?.[0]?.embedding) throw new Error("Invalid embedding response");
    return resp.data[0].embedding;
  }

  async generateEmbeddings(contents: string[]): Promise<number[][]> {
    const bounded = await truncateEmbeddingInputs(contents, this.model, "openai");
    const resp = await this.requestWithRetry(bounded);
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

      const message = `Embedding request failed: ${res.status} ${res.statusText}${extra}`.trim();

      // A 4xx that is not a rate limit or an auth failure means the provider
      // rejected what we SENT — an over-length input, a malformed body (mt#4212).
      // Typing it keeps it off the circuit breaker, which exists to detect a
      // failing provider and cannot be informed by a permanently-invalid request.
      // 401/403 stay untyped on purpose: an unusable credential is a
      // service-level condition where pausing the caller is the right response.
      if (res.status >= 400 && res.status < 500 && ![401, 403, 429].includes(res.status)) {
        throw new ProviderInputError(message, "openai", res.status);
      }

      throw new Error(message);
    }
    return (await res.json()) as OpenAIEmbeddingResponse;
  }
}
