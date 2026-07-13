import { getConfiguration } from "../configuration";
import type { EmbeddingService } from "./embeddings/types";
import { OpenAIEmbeddingService } from "./embedding-service-openai";
import { LocalEmbeddingService } from "./embedding-service-local";
import { GeminiEmbeddingService } from "./embedding-service-gemini";
import { EmbeddingsHealthTracker } from "./embeddings-health-tracker";
import { log } from "@minsky/shared/logger";

function isQuotaExhausted(error: unknown): boolean {
  const msg = String((error as Error)?.message || "");
  return /insufficient_quota|RESOURCE_EXHAUSTED/i.test(msg);
}

class FallbackEmbeddingService implements EmbeddingService {
  constructor(
    private readonly primary: EmbeddingService,
    private readonly fallback: EmbeddingService,
    private readonly primaryName: string,
    private readonly fallbackName: string
  ) {}

  async generateEmbedding(content: string): Promise<number[]> {
    try {
      return await this.primary.generateEmbedding(content);
    } catch (err) {
      if (!isQuotaExhausted(err)) throw err;
      return this.activateFallback(() => this.fallback.generateEmbedding(content));
    }
  }

  async generateEmbeddings(contents: string[]): Promise<number[][]> {
    try {
      return await this.primary.generateEmbeddings(contents);
    } catch (err) {
      if (!isQuotaExhausted(err)) throw err;
      return this.activateFallback(() => this.fallback.generateEmbeddings(contents));
    }
  }

  private async activateFallback<T>(operation: () => Promise<T>): Promise<T> {
    log.warn(
      `Embedding provider ${this.primaryName} quota exhausted — falling back to ${this.fallbackName}`
    );
    const tracker = EmbeddingsHealthTracker.getInstance();
    tracker.setFallbackActive(this.fallbackName);
    return operation();
  }
}

async function createProvider(name: string): Promise<EmbeddingService> {
  switch (name) {
    case "openai":
      return OpenAIEmbeddingService.fromConfig();
    case "gemini":
      return GeminiEmbeddingService.fromConfig();
    case "local":
      return LocalEmbeddingService.fromConfig();
    default:
      throw new Error(`Embedding provider not supported: ${String(name)}`);
  }
}

export async function createEmbeddingServiceFromConfig(): Promise<EmbeddingService> {
  const config = await getConfiguration();
  const primaryName = config.embeddings?.provider || config.ai?.defaultProvider || "openai";
  const fallbackName = config.embeddings?.fallbackProvider;

  const primary = await createProvider(primaryName);

  if (!fallbackName || fallbackName === primaryName) {
    return primary;
  }

  try {
    const fallback = await createProvider(fallbackName);
    log.info(`Embedding fallback chain: ${primaryName} → ${fallbackName}`);
    return new FallbackEmbeddingService(primary, fallback, primaryName, fallbackName);
  } catch (err) {
    log.warn(
      `Failed to initialize fallback embedding provider ${fallbackName}: ${err instanceof Error ? err.message : String(err)}. Continuing with ${primaryName} only.`
    );
    return primary;
  }
}
