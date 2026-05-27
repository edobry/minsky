import { injectable } from "tsyringe";
import { getConfiguration } from "../configuration";
import type { EmbeddingService } from "./embeddings/types";
import { RateLimitError } from "./enhanced-error-types";
import { IntelligentRetryService } from "./intelligent-retry-service";
import { EmbeddingsHealthTracker } from "./embeddings-health-tracker";
import { isRetryableAIError } from "./embedding-service-openai";

const GEMINI_EMBEDDING_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001";

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

  constructor(apiKey: string, outputDimensionality = 1536) {
    this.apiKey = apiKey;
    this.outputDimensionality = outputDimensionality;
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
    const resp = await this.requestWithRetry([content]);
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
      EmbeddingsHealthTracker.getInstance().recordRecovery();
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const errorCode = /insufficient_quota|RESOURCE_EXHAUSTED/i.test(msg)
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

      throw new Error(
        `Gemini embedding request failed: ${res.status} ${res.statusText}${extra}`.trim()
      );
    }

    return (await res.json()) as GeminiEmbeddingResponse;
  }
}
