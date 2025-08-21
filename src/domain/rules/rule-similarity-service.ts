import type { EmbeddingService } from "../ai/embeddings/types";
import type { VectorStorage, SearchResult } from "../storage/vector/types";

export interface RuleSimilarityServiceConfig {
  similarityThreshold?: number; // maximum distance for inclusion (backend-specific semantics)
}

/**
 * RuleSimilarityService: embedding-based rule retrieval
 */
export class RuleSimilarityService {
  constructor(
    private readonly embeddingService: EmbeddingService,
    private readonly vectorStorage: VectorStorage,
    private readonly config: RuleSimilarityServiceConfig = {}
  ) {}

  /**
   * Search rules by natural language query using embeddings
   */
  async searchByText(query: string, limit = 10, threshold?: number): Promise<SearchResult[]> {
    const vector = await this.embeddingService.generateEmbedding(query);
    const effThreshold = threshold ?? this.config.similarityThreshold ?? Number.POSITIVE_INFINITY;
    const results = await this.vectorStorage.search(vector, limit, effThreshold);
    return results;
  }
}
