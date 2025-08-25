import type { SimilarityBackend, SimilarityItem, SimilarityQuery } from "./types";

export class SimilaritySearchService {
  private readonly backends: SimilarityBackend[];

  constructor(backends: SimilarityBackend[]) {
    this.backends = backends;
  }

  /**
   * Execute search against the first available backend in priority order.
   * No cross-backend mixing. Returns top-k from the selected backend.
   */
  async search(query: SimilarityQuery): Promise<SimilarityItem[]> {
    for (const backend of this.backends) {
      try {
        const available = await backend.isAvailable();
        if (!available) continue;
        const items = await backend.search(query);
        return Array.isArray(items) ? items : [];
      } catch {
        // Treat errors as unavailability; continue to next backend
        continue;
      }
    }
    return [];
  }
}
