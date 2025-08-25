import type { SimilarityBackend, SimilarityItem, SimilarityQuery } from "./types";

export class SimilaritySearchService {
  private readonly backends: SimilarityBackend[];

  constructor(backends: SimilarityBackend[]) {
    this.backends = backends;
  }

  async search(query: SimilarityQuery): Promise<SimilarityItem[]> {
    for (const backend of this.backends) {
      try {
        const available = await backend.isAvailable();
        if (!available) continue;
        const items = await backend.search(query);
        if (Array.isArray(items) && items.length > 0) {
          return items;
        }
        // If no results, try next backend as graceful fallback
        continue;
      } catch {
        continue;
      }
    }
    return [];
  }
}
