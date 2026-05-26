import { injectable } from "tsyringe";
import { getConfiguration } from "../configuration";
import type { EmbeddingService } from "./embeddings/types";
import { RateLimitError } from "./enhanced-error-types";

/**
 * Determines whether an AI service error is retryable.
 * Retries on transient rate limits, server errors, and network issues.
 * Does NOT retry on quota exhaustion (billing issue).
 */
export function isRetryableAIError(error: unknown): boolean {
  const msg = String((error as Error)?.message || "");
  if (/insufficient_quota/i.test(msg)) return false;
  if (error instanceof RateLimitError) return true;
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

interface OpenAIEmbeddingResponse {
  data: Array<{ embedding: number[] }>;
}

@injectable()
export class OpenAIEmbeddingService implements EmbeddingService {
  private readonly apiKey: string;
  private readonly baseURL: string;
  private readonly model: string;

  constructor(apiKey: string, baseURL?: string, model?: string) {
    this.apiKey = apiKey;
    this.baseURL = baseURL || "https://api.openai.com/v1";
    this.model = model || "text-embedding-3-small";
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
      const { IntelligentRetryService } = await import("./intelligent-retry-service");
      const retry = new IntelligentRetryService({ maxRetries: 3, baseDelay: 500 });
      return await retry.execute(
        async () => this.request(inputs),
        isRetryableAIError,
        "openai-embeddings"
      );
    } catch {
      // Fallback: single attempt
      return this.request(inputs);
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
