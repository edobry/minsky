import type { SimilarityBackend, SimilarityItem, SimilarityQuery } from "../types";

export interface ContentResolvers {
  getById(id: string): Promise<{ id: string } | null>;
  listCandidateIds(): Promise<string[]>;
  getContent(id: string): Promise<string>;
}

export class LexicalSimilarityBackend implements SimilarityBackend {
  readonly name = "lexical";
  constructor(private readonly resolvers: ContentResolvers) {}

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async search(query: SimilarityQuery): Promise<SimilarityItem[]> {
    const limit = typeof query.limit === "number" && query.limit > 0 ? query.limit : 10;
    const text = (query.queryText || "").toLowerCase();
    const tokens = this.tokenize(text);
    const candidates = await this.resolvers.listCandidateIds();

    const scored: Array<{ id: string; score: number }> = [];
    for (const id of candidates) {
      const content = (await this.resolvers.getContent(id)).toLowerCase();
      const ctokens = this.tokenize(content);
      const score = this.jaccard(tokens, ctokens);
      scored.push({ id, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map((s) => ({ id: s.id, score: s.score }));
  }

  private tokenize(text: string): Set<string> {
    return new Set(
      text
        .split(/[^a-z0-9]+/i)
        .map((t) => t.trim())
        .filter((t) => t.length > 1)
    );
  }

  private jaccard(a: Set<string>, b: Set<string>): number {
    if (a.size === 0 && b.size === 0) return 0;
    let intersection = 0;
    for (const t of a) if (b.has(t)) intersection++;
    const union = a.size + b.size - intersection;
    return union > 0 ? intersection / union : 0;
  }
}
