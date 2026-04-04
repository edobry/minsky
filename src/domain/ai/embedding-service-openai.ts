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
        (error) =>
          /503|Service Unavailable|ECONNRESET|ETIMEDOUT/i.test(String(error?.message || "")),
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
      try {
        const asJson: unknown = await res.json();
        const obj = asJson as { error?: { code?: unknown; type?: unknown; message?: unknown } };
        const err = obj?.error || obj;
        const errObj = err as { code?: unknown; type?: unknown; message?: unknown };
        const parts: string[] = [];
        if (errObj?.code) parts.push(`code=${String(errObj.code)}`);
        if (errObj?.type) parts.push(`type=${String(errObj.type)}`);
        if (errObj?.message) parts.push(`message=${String(errObj.message)}`);
        extra = parts.length > 0 ? ` - ${parts.join(", ")}` : ` ${JSON.stringify(asJson)}`;
      } catch {
        const text = await res.text().catch(() => "");
        extra = text ? ` ${text}` : "";
      }
      throw new Error(`Embedding request failed: ${res.status} ${res.statusText}${extra}`.trim());
    }
    return (await res.json()) as OpenAIEmbeddingResponse;
  }
}
