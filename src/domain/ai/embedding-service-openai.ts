import { DefaultAIConfigurationService } from "./config-service";
import { getConfiguration } from "../configuration";
import type { EmbeddingService } from "./embeddings/types";

interface OpenAIEmbeddingResponse {
  data: Array<{ embedding: number[] }>;
}

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
    const aiConfig = new DefaultAIConfigurationService(config);
    const provider = await aiConfig.getProviderConfig("openai");
    if (!provider || !provider.apiKey) {
      throw new Error(
        "OpenAI provider not configured. Set ai.providers.openai.apiKey in configuration."
      );
    }
    const model = (config as any).embeddings?.model || provider.defaultModel || "text-embedding-3-small";
    return new OpenAIEmbeddingService(provider.apiKey, provider.baseURL, model);
  }

  async generateEmbedding(content: string): Promise<number[]> {
    const resp = await this.request([content]);
    if (!resp.data?.[0]?.embedding) throw new Error("Invalid embedding response");
    return resp.data[0].embedding;
  }

  async generateEmbeddings(contents: string[]): Promise<number[][]> {
    const resp = await this.request(contents);
    return resp.data.map((d) => d.embedding);
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
      const text = await res.text().catch(() => "");
      throw new Error(`Embedding request failed: ${res.status} ${res.statusText} ${text}`.trim());
    }
    return (await res.json()) as OpenAIEmbeddingResponse;
  }
}
