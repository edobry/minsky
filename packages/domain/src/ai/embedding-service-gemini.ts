import { injectable } from "tsyringe";
import { getConfiguration } from "../configuration";
import type { EmbeddingService } from "./embeddings/types";
import { truncateEmbeddingInput } from "./embeddings/truncate-input";
import { ProviderInputError, RateLimitError } from "./enhanced-error-types";
import { IntelligentRetryService } from "./intelligent-retry-service";
import { EmbeddingsHealthTracker } from "./embeddings-health-tracker";
import {
  isRetryableAIError,
  isRequestTimeoutError,
  REQUEST_TIMEOUT_MS,
} from "./request-resilience";

const GEMINI_EMBEDDING_MODEL = "gemini-embedding-001";
const GEMINI_EMBEDDING_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_EMBEDDING_MODEL}`;

interface GeminiEmbeddingResponse {
  embedding?: { values: number[] };
  embeddings?: Array<{ values: number[] }>;
}

const sharedRetryService = new IntelligentRetryService({
  maxRetries: 3,
  baseDelay: 500,
});

@injectable()
export class GeminiEmbeddingService implements EmbeddingService {
  private readonly apiKey: string;
  private readonly outputDimensionality: number;
  private readonly requestTimeoutMs: number;

  constructor(
    apiKey: string,
    outputDimensionality = 1536,
    requestTimeoutMs: number = REQUEST_TIMEOUT_MS
  ) {
    this.apiKey = apiKey;
    this.outputDimensionality = outputDimensionality;
    // Injectable seam, at parity with OpenAIEmbeddingService, so a test can
    // exercise the timeout without a real 15s wait (PR #2481 review).
    this.requestTimeoutMs = requestTimeoutMs;
  }

  static async fromConfig(): Promise<GeminiEmbeddingService> {
    const config = await getConfiguration();
    const providerCfg = config.ai?.providers?.google;

    const apiKey = providerCfg?.apiKey;
    if (!apiKey) {
      throw new Error(
        "Google AI provider not configured. Set ai.providers.google.apiKey in configuration."
      );
    }

    const dimension = config.embeddings?.dimension || 1536;
    return new GeminiEmbeddingService(apiKey, dimension);
  }

  async generateEmbedding(content: string): Promise<number[]> {
    // `generateEmbeddings` below delegates here per input, so bounding this one
    // method covers both entry points.
    const bounded = await truncateEmbeddingInput(content, GEMINI_EMBEDDING_MODEL, "google");
    const resp = await this.requestWithRetry([bounded]);
    if (resp.embedding?.values) return resp.embedding.values;
    if (resp.embeddings?.[0]?.values) return resp.embeddings[0].values;
    throw new Error("Invalid Gemini embedding response");
  }

  async generateEmbeddings(contents: string[]): Promise<number[][]> {
    const results: number[][] = [];
    for (const content of contents) {
      results.push(await this.generateEmbedding(content));
    }
    return results;
  }

  private async requestWithRetry(inputs: string[]) {
    try {
      const input = inputs[0];
      if (!input) throw new Error("No input provided for embedding");
      const result = await sharedRetryService.execute(
        async () => this.request(input),
        isRetryableAIError,
        "gemini-embeddings"
      );
      // Parity with OpenAIEmbeddingService (PR #2481 review). This service
      // recorded errors but never recovery, so a gemini-caused degradation
      // could never be cleared from gemini's own side.
      EmbeddingsHealthTracker.getInstance().recordRecovery();
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const errorCode = isRequestTimeoutError(err)
        ? "timeout"
        : /insufficient_quota|RESOURCE_EXHAUSTED/i.test(msg)
          ? "insufficient_quota"
          : /circuit.breaker.is.open/i.test(msg)
            ? "circuit_breaker_open"
            : /429|rate.limit/i.test(msg)
              ? "rate_limit"
              : "unknown";
      await EmbeddingsHealthTracker.getInstance().recordError("gemini", errorCode, msg);
      throw err;
    }
  }

  private async request(content: string): Promise<GeminiEmbeddingResponse> {
    const url = `${GEMINI_EMBEDDING_URL}:embedContent?key=${this.apiKey}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "models/gemini-embedding-001",
        content: { parts: [{ text: content }] },
        outputDimensionality: this.outputDimensionality,
      }),
      // Same unbounded-hang defect as the OpenAI service; same bound (mt#3444).
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    });

    if (!res.ok) {
      let extra = "";
      let errorStatus = "";
      try {
        const body = (await res.json()) as {
          error?: { message?: string; status?: string; code?: number };
        };
        const err = body?.error;
        if (err) {
          const parts: string[] = [];
          if (err.status) {
            parts.push(`status=${err.status}`);
            errorStatus = err.status;
          }
          if (err.code) parts.push(`code=${err.code}`);
          if (err.message) parts.push(`message=${err.message}`);
          extra = parts.length > 0 ? ` - ${parts.join(", ")}` : "";
        }
      } catch {
        const text = await res.text().catch(() => "");
        extra = text ? ` ${text}` : "";
      }

      if (res.status === 429) {
        const retryAfterHeader = res.headers.get("retry-after");
        const retryAfter = retryAfterHeader ? Number(retryAfterHeader) : 60;
        if (errorStatus === "RESOURCE_EXHAUSTED") {
          throw new Error(`Gemini embedding quota exhausted: ${res.status}${extra}`.trim());
        }
        throw new RateLimitError(
          `Gemini embedding rate limited: 429${extra}`.trim(),
          "gemini",
          isNaN(retryAfter) ? 60 : retryAfter,
          0,
          0
        );
      }

      const message =
        `Gemini embedding request failed: ${res.status} ${res.statusText}${extra}`.trim();

      // Same split as the OpenAI service (mt#4212): a 4xx that is not a rate
      // limit or an auth failure is a rejected request body, which must not
      // count against the provider circuit breaker.
      if (res.status >= 400 && res.status < 500 && ![401, 403, 429].includes(res.status)) {
        throw new ProviderInputError(message, "gemini", res.status);
      }

      throw new Error(message);
    }

    return (await res.json()) as GeminiEmbeddingResponse;
  }
}
