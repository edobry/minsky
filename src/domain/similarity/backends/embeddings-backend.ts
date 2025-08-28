import type { SimilarityBackend, SimilarityItem, SimilarityQuery } from "../types";
import type { EmbeddingService } from "../../ai/embeddings/types";
import type { VectorStorage } from "../../storage/vector/types";

export class EmbeddingsSimilarityBackend implements SimilarityBackend {
  readonly name = "embeddings";
  constructor(
    private readonly embeddingService: EmbeddingService,
    private readonly vectorStorage: VectorStorage
  ) {}

  async isAvailable(): Promise<boolean> {
    return Boolean(this.embeddingService) && Boolean(this.vectorStorage);
  }

  async search(query: SimilarityQuery): Promise<SimilarityItem[]> {
    const limit = typeof query.limit === "number" && query.limit > 0 ? query.limit : 10;
    const text = query.queryText ?? "";
    const vector = await this.embeddingService.generateEmbedding(text);
    const results = await this.vectorStorage.search(vector, {
      limit,
      filters: query.filters,
    });
    return results.map((r) => ({ id: r.id, score: r.score, metadata: r.metadata }));
  }
}
