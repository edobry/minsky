import { log } from "../../utils/logger";
import type { SimilarityBackend, SimilarityQuery, SimilaritySearchResponse } from "./types";

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

  async search(query: SimilarityQuery): Promise<SimilaritySearchResponse> {
    let degraded = false;
    let degradedReason: string | undefined;

    for (const backend of this.backends) {
      try {
        const available = await backend.isAvailable();
        if (!available) continue;
        const items = await backend.search(query);
        this.lastUsedBackend = backend.name;
        return {
          items: Array.isArray(items) ? items : [],
          backend: backend.name,
          degraded,
          degradedReason,
        };
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        log.warn(`Similarity backend "${backend.name}" failed, falling back`, { error: reason });
        degraded = true;
        degradedReason = reason;
        continue;
      }
    }
    this.lastUsedBackend = null;
    return {
      items: [],
      backend: "none",
      degraded,
      degradedReason,
    };
  }
}
