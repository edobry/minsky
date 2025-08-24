import type { SearchResult } from "../storage/vector/types";
import { createRuleSimilarityCore } from "../similarity/create-rule-similarity-core";

export interface RuleSimilarityServiceConfig {
  similarityThreshold?: number; // maximum distance for inclusion (backend-specific semantics)
}

/**
 * RuleSimilarityService: embedding-based rule retrieval
 */
export class RuleSimilarityService {
  constructor(private readonly workspacePath: string, private readonly config: RuleSimilarityServiceConfig = {}) {}

  /**
   * Search rules by natural language query using embeddings
   */
  async searchByText(query: string, limit = 10, threshold?: number): Promise<SearchResult[]> {
    const core = await createRuleSimilarityCore(this.workspacePath);
    const items = await core.search({ queryText: query, limit });
    // Map to SearchResult shape (id/score compatible)
    return items.map((i) => ({ id: i.id, score: i.score } as SearchResult));
  }
}
