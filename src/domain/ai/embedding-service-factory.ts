import { getConfiguration } from "../configuration";
import type { EmbeddingService } from "./embeddings/types";
import { OpenAIEmbeddingService } from "./embedding-service-openai";
import { LocalEmbeddingService } from "./embedding-service-local";

export async function createEmbeddingServiceFromConfig(): Promise<EmbeddingService> {
  const config = await getConfiguration();
  const provider =
    (config as any).embeddings?.provider || (config as any).ai?.defaultProvider || "openai";

  switch (provider) {
    case "openai":
      return OpenAIEmbeddingService.fromConfig();
    case "local":
      return LocalEmbeddingService.fromConfig();
    default:
      throw new Error(`Embedding provider not supported: ${String(provider)}`);
  }
}
