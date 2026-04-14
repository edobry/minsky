import { describe, it, expect } from "bun:test";
import { SimilaritySearchService } from "./similarity-search-service";
import type { SimilarityBackend, SimilarityItem, SimilarityQuery } from "./types";

function createBackend(
  name: string,
  options: {
    available?: boolean;
    results?: SimilarityItem[];
    error?: Error;
  } = {}
): SimilarityBackend {
  const { available = true, results = [], error } = options;
  return {
    name,
    isAvailable: async () => available,
    search: async () => {
      if (error) throw error;
      return results;
    },
  };
}

describe("SimilaritySearchService", () => {
  const query: SimilarityQuery = { queryText: "test query", limit: 5 };

  it("returns results from the first available backend", async () => {
    const items: SimilarityItem[] = [{ id: "a", score: 0.5 }];
    const svc = new SimilaritySearchService([
      createBackend("embeddings", { results: items }),
      createBackend("lexical", { results: [{ id: "b", score: 0.1 }] }),
    ]);

    const response = await svc.search(query);

    expect(response.backend).toBe("embeddings");
    expect(response.degraded).toBe(false);
    expect(response.degradedReason).toBeUndefined();
    expect(response.items).toEqual(items);
  });

  it("sets degraded=true with reason when a backend throws and falls back", async () => {
    const fallbackItems: SimilarityItem[] = [{ id: "b", score: 0.2 }];
    const svc = new SimilaritySearchService([
      createBackend("embeddings", {
        error: new Error("429 insufficient_quota"),
      }),
      createBackend("lexical", { results: fallbackItems }),
    ]);

    const response = await svc.search(query);

    expect(response.backend).toBe("lexical");
    expect(response.degraded).toBe(true);
    expect(response.degradedReason).toContain("429 insufficient_quota");
    expect(response.items).toEqual(fallbackItems);
  });

  it("skips unavailable backends without setting degraded", async () => {
    const items: SimilarityItem[] = [{ id: "c", score: 0.3 }];
    const svc = new SimilaritySearchService([
      createBackend("embeddings", { available: false }),
      createBackend("lexical", { results: items }),
    ]);

    const response = await svc.search(query);

    expect(response.backend).toBe("lexical");
    expect(response.degraded).toBe(false);
    expect(response.degradedReason).toBeUndefined();
  });

  it("returns empty with backend='none' when all backends fail", async () => {
    const svc = new SimilaritySearchService([
      createBackend("embeddings", { error: new Error("quota exceeded") }),
      createBackend("lexical", { error: new Error("lexical also broken") }),
    ]);

    const response = await svc.search(query);

    expect(response.backend).toBe("none");
    expect(response.degraded).toBe(true);
    expect(response.degradedReason).toContain("lexical also broken");
    expect(response.items).toEqual([]);
  });

  it("returns empty with degraded=false when no backends configured", async () => {
    const svc = new SimilaritySearchService([]);

    const response = await svc.search(query);

    expect(response.backend).toBe("none");
    expect(response.degraded).toBe(false);
    expect(response.items).toEqual([]);
  });

  it("tracks lastUsedBackend correctly", async () => {
    const svc = new SimilaritySearchService([
      createBackend("embeddings", { error: new Error("fail") }),
      createBackend("lexical", { results: [{ id: "x", score: 0.1 }] }),
    ]);

    expect(svc.getLastUsedBackend()).toBeNull();
    await svc.search(query);
    expect(svc.getLastUsedBackend()).toBe("lexical");
  });
});
