import type { SimilarityBackend, SimilarityItem, SimilarityQuery } from "./types";

export class SimilaritySearchService {
  private readonly backends: SimilarityBackend[];
  private lastUsedBackend: string | null = null;

  constructor(backends: SimilarityBackend[]) {
    this.backends = backends;
  }

  getLastUsedBackend(): string | null {
    return this.lastUsedBackend;
  }

  async search(query: SimilarityQuery): Promise<SimilarityItem[]> {
    for (const backend of this.backends) {
      try {
        const available = await backend.isAvailable();
        if (!available) continue;
        const items = await backend.search(query);
        this.lastUsedBackend = backend.name;
        return Array.isArray(items) ? items : [];
      } catch {
        continue;
      }
    }
    this.lastUsedBackend = null;
    return [];
  }
}
