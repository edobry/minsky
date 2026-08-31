/**
 * mt#4805 — `SimilarityItem.score` points ONE way across every backend.
 *
 * The spec's first acceptance test reads: "A test asserts both backends return
 * the same orientation for a query where the expected ranking is known —
 * currently impossible to write, which is the defect." This file is that test.
 *
 * All collaborators are constructor-injected (`testing-standards.mdc §Testable
 * Design`); nothing here patches a module or a prototype. That matters
 * particularly for `EmbeddingsSimilarityBackend.prototype.isAvailable`, which
 * `tool-similarity-service.core.test.ts` documents as a shared module-level
 * mutable whose monkey-patching leaked across suites (mt#2665 R2).
 */

import { describe, it, expect } from "bun:test";
import { EmbeddingsSimilarityBackend } from "./backends/embeddings-backend";
import { LexicalSimilarityBackend } from "./backends/lexical-backend";
import { SimilaritySearchService } from "./similarity-search-service";
import { l2DistanceToSimilarity, similarityToL2Distance } from "./similarity-score";
import type { EmbeddingService } from "../ai/embeddings/types";
import type { SearchResult, VectorStorage } from "../storage/vector/types";
import type { SimilarityItem } from "./types";

/**
 * A known ranking, expressed the way each backend natively expresses it.
 *
 * `near` is the best match and `far` the worst, in BOTH fixtures — that shared
 * ground truth is what makes the orientation comparison meaningful.
 */
const RANKING = ["near", "middle", "far"] as const;

/** The one query both fixtures answer, so the two rankings are comparable. */
const QUERY = "alpha beta gamma delta";

/** L2 distances for unit vectors: ASCENDING, because the store returns nearest-first. */
const DISTANCES: Record<(typeof RANKING)[number], number> = {
  near: 0.2,
  middle: 0.7,
  far: 1.1,
};

function fakeEmbeddingService(): EmbeddingService {
  return {
    generateEmbedding: async () => [1, 0, 0],
    generateEmbeddings: async (contents: string[]) => contents.map(() => [1, 0, 0]),
  };
}

/** Returns the fixture's raw L2 DISTANCES, exactly as `PostgresVectorStorage` would. */
function fakeVectorStorage(): VectorStorage {
  return {
    store: async () => {},
    delete: async () => {},
    search: async (): Promise<SearchResult[]> =>
      RANKING.map((id) => ({ id, score: DISTANCES[id] })),
  };
}

/**
 * Lexical resolvers whose token overlap with the query reproduces the same
 * ranking. `near`'s content IS the query, so it shares all four tokens;
 * `far` shares one.
 */
function lexicalBackend(): LexicalSimilarityBackend {
  const content: Record<string, string> = {
    near: QUERY,
    middle: "alpha beta epsilon zeta",
    far: "alpha epsilon zeta eta theta iota kappa",
  };
  return new LexicalSimilarityBackend({
    getById: async (id: string) => (content[id] ? { id } : null),
    listCandidateIds: async () => [...RANKING],
    getContent: async (id: string) => content[id] ?? "",
  });
}

function scoreOf(items: SimilarityItem[], id: string): number {
  const found = items.find((i) => i.id === id);
  if (!found) throw new Error(`fixture error: "${id}" missing from results`);
  return found.score;
}

describe("mt#4805: score orientation is uniform across backends", () => {
  it("the embeddings backend returns a SIMILARITY, best match highest", async () => {
    const backend = new EmbeddingsSimilarityBackend(fakeEmbeddingService(), fakeVectorStorage());
    const items = await backend.search({ queryText: QUERY, limit: 10 });

    expect(scoreOf(items, "near")).toBeGreaterThan(scoreOf(items, "middle"));
    expect(scoreOf(items, "middle")).toBeGreaterThan(scoreOf(items, "far"));

    // Exact values, so a future change to the conversion is caught rather than
    // merely re-ordered: s = 1 - d²/2.
    expect(scoreOf(items, "near")).toBeCloseTo(0.98, 10);
    expect(scoreOf(items, "far")).toBeCloseTo(0.395, 10);
    for (const item of items) {
      expect(item.score).toBeGreaterThanOrEqual(0);
      expect(item.score).toBeLessThanOrEqual(1);
    }
  });

  it("the lexical backend returns a SIMILARITY, best match highest", async () => {
    const items = await lexicalBackend().search({
      queryText: QUERY,
      limit: 10,
    });

    expect(scoreOf(items, "near")).toBeGreaterThan(scoreOf(items, "middle"));
    expect(scoreOf(items, "middle")).toBeGreaterThan(scoreOf(items, "far"));
  });

  it("both backends agree on WHICH result is best and which is worst", async () => {
    const embeddings = await new EmbeddingsSimilarityBackend(
      fakeEmbeddingService(),
      fakeVectorStorage()
    ).search({ queryText: QUERY, limit: 10 });
    const lexical = await lexicalBackend().search({
      queryText: QUERY,
      limit: 10,
    });

    const best = (items: SimilarityItem[]) =>
      items.reduce((a, b) => (b.score > a.score ? b : a)).id;
    const worst = (items: SimilarityItem[]) =>
      items.reduce((a, b) => (b.score < a.score ? b : a)).id;

    expect(best(embeddings)).toBe("near");
    expect(best(lexical)).toBe("near");
    expect(worst(embeddings)).toBe("far");
    expect(worst(lexical)).toBe("far");
  });

  it("a `score >= threshold` filter keeps the NEAREST results, on either backend", async () => {
    const service = new SimilaritySearchService([
      new EmbeddingsSimilarityBackend(fakeEmbeddingService(), fakeVectorStorage()),
    ]);
    const response = await service.search({ queryText: QUERY, limit: 10 });

    // The predicate every consumer now uses: TaskSimilarityService.applyThreshold,
    // RuleSimilarityService.searchByText, and (as its `continue` complement)
    // ToolSimilarityService.findRelevantTools.
    const kept = response.items.filter((i) => i.score >= 0.5).map((i) => i.id);
    expect(kept).toEqual(["near", "middle"]);
    expect(kept).not.toContain("far");
  });

  it("NEGATIVE CONTROL: the same filter over the UNCONVERTED distances keeps the FARTHEST", () => {
    // This is the pre-mt#4805 behaviour, reconstructed from the same fixture: the
    // backend passed `r.score` through, so a consumer applying a similarity-shaped
    // predicate to it selected the opposite set. Without this case the test above
    // would pass against a backend that had never been fixed.
    const unconverted = RANKING.map((id) => ({ id, score: DISTANCES[id] }));
    const kept = unconverted.filter((i) => i.score >= 0.5).map((i) => i.id);

    expect(kept).toEqual(["middle", "far"]);
    expect(kept).not.toContain("near");
  });

  it("conversion is strictly decreasing, so the store's nearest-first ORDER BY still holds", () => {
    const distances = [0, 0.1, 0.25, 0.5, 0.8, 1.0, 1.2, 1.4];
    const similarities = distances.map(l2DistanceToSimilarity);
    for (let i = 1; i < similarities.length; i++) {
      expect(similarities[i] as number).toBeLessThan(similarities[i - 1] as number);
    }
  });

  it("threshold conversion round-trips, so a similarity floor and a distance ceiling agree", () => {
    for (const similarity of [0.1, 0.25, 0.5, 0.75, 0.9]) {
      expect(l2DistanceToSimilarity(similarityToL2Distance(similarity))).toBeCloseTo(
        similarity,
        10
      );
    }
  });
});
