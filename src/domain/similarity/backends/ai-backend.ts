import type { SimilarityBackend, SimilarityItem, SimilarityQuery } from "../types";

export interface AISimilarityProvider {
  isEnabled(): Promise<boolean>;
  searchSimilar(query: string, limit: number): Promise<SimilarityItem[]>;
}

export class AISimilarityBackend implements SimilarityBackend {
  readonly name = "ai";
  constructor(private readonly provider: AISimilarityProvider) {}

  async isAvailable(): Promise<boolean> {
    try {
      return await this.provider.isEnabled();
    } catch {
      return false;
    }
  }

  async search(query: SimilarityQuery): Promise<SimilarityItem[]> {
    const limit = typeof query.limit === "number" && query.limit > 0 ? query.limit : 10;
    const text = query.queryText ?? "";
    return this.provider.searchSimilar(text, limit);
  }
}
