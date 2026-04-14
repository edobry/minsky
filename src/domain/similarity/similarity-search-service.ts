import type { SimilarityBackend, SimilarityItem, SimilarityQuery } from "./types";
import { log } from "../../utils/logger";

export class SimilaritySearchService {
  private readonly backends: SimilarityBackend[];
  private lastUsedBackend: string | null = null;

  constructor(backends: SimilarityBackend[]) {
    this.backends = backends;
  }

  getLastUsedBackend(): string | null {
    return this.lastUsedBackend;
  }

  getBackend(name: string): SimilarityBackend | undefined {
    return this.backends.find((b) => b.name === name);
  }

  async search(query: SimilarityQuery): Promise<SimilarityItem[]> {
    for (const backend of this.backends) {
      try {
        const available = await backend.isAvailable();
        if (!available) continue;
        const items = await backend.search(query);
        this.lastUsedBackend = backend.name;
        return Array.isArray(items) ? items : [];
      } catch (error) {
        log.warn(`Similarity search backend "${backend.name}" failed, trying next`, {
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
    }
    this.lastUsedBackend = null;
    log.warn("All similarity search backends failed; returning empty results");
    return [];
  }
}
