import { injectable } from "tsyringe";
import type { SimilarityBackend, SimilarityQuery, SimilaritySearchResponse } from "./types";
import { log } from "../../utils/logger";

@injectable()
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
        const errorMsg = error instanceof Error ? error.message : String(error);
        log.warn(`Similarity search backend "${backend.name}" failed, trying next`, {
          error: errorMsg,
        });
        // A backend was available but threw — mark degraded for whoever
        // eventually succeeds (the fallback).
        degraded = true;
        degradedReason = `${backend.name} failed: ${errorMsg}`;
        continue;
      }
    }
    this.lastUsedBackend = null;
    log.warn("All similarity search backends failed; returning empty results");
    return {
      items: [],
      backend: "none",
      degraded,
      degradedReason: degraded ? degradedReason : undefined,
    };
  }
}
