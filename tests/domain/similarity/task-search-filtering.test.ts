import { describe, it, expect, beforeAll, beforeEach } from "bun:test";
import { EmbeddingsSimilarityBackend } from "../../../src/domain/similarity/backends/embeddings-backend";
import type { SimilarityQuery } from "../../../src/domain/similarity/types";
import { MemoryVectorStorage } from "../../../src/domain/storage/vector/memory-vector-storage";

// Mock embedding service for predictable results
const mockEmbeddingService = {
  generateEmbedding: async (text: string): Promise<number[]> => {
    // Simple hash-based embedding for testing
    const hash = text.split("").reduce((a, b) => a + b.charCodeAt(0), 0);
    return [hash % 10, (hash * 2) % 10, (hash * 3) % 10];
  },
};

describe("Task Search Server-Side Filtering Integration", () => {
  let backend: EmbeddingsSimilarityBackend;
  let storage: MemoryVectorStorage;

  beforeAll(async () => {
    const { initializeConfiguration, CustomConfigFactory } = await import(
      "../../../src/domain/configuration/index"
    );
    await initializeConfiguration(new CustomConfigFactory(), {
      enableCache: true,
      skipValidation: true,
    });
  });

  beforeEach(async () => {
    // Initialize memory storage with test data
    storage = new MemoryVectorStorage(3);

    // Add task embeddings with filter metadata
    await storage.store("md#001", [1, 0, 0], { status: "TODO", backend: "markdown" });
    await storage.store("md#002", [0, 1, 0], { status: "IN-PROGRESS", backend: "markdown" });
    await storage.store("gh#001", [0, 0, 1], { status: "DONE", backend: "github" });
    await storage.store("gh#002", [1, 1, 0], { status: "TODO", backend: "github" });
    await storage.store("mt#001", [0, 1, 1], { status: "IN-REVIEW", backend: "minsky" });

    backend = new EmbeddingsSimilarityBackend(mockEmbeddingService as any, storage);
  });

  it("should search without filters", async () => {
    const query: SimilarityQuery = {
      queryText: "test query",
      limit: 10,
    };

    const results = await backend.search(query);

    expect(results).toHaveLength(5);
    expect(results.map((r) => r.id).sort()).toEqual([
      "gh#001",
      "gh#002",
      "md#001",
      "md#002",
      "mt#001",
    ]);
  });

  it("should filter by status", async () => {
    const query: SimilarityQuery = {
      queryText: "test query",
      limit: 10,
      filters: { status: "TODO" },
    };

    const results = await backend.search(query);

    expect(results).toHaveLength(2);
    expect(results.map((r) => r.id).sort()).toEqual(["gh#002", "md#001"]);
    results.forEach((result) => {
      expect(result.metadata?.status).toBe("TODO");
    });
  });

  it("should filter by backend", async () => {
    const query: SimilarityQuery = {
      queryText: "test query",
      limit: 10,
      filters: { backend: "github" },
    };

    const results = await backend.search(query);

    expect(results).toHaveLength(2);
    expect(results.map((r) => r.id).sort()).toEqual(["gh#001", "gh#002"]);
    results.forEach((result) => {
      expect(result.metadata?.backend).toBe("github");
    });
  });

  it("should filter by multiple criteria", async () => {
    const query: SimilarityQuery = {
      queryText: "test query",
      limit: 10,
      filters: { status: "TODO", backend: "github" },
    };

    const results = await backend.search(query);

    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("gh#002");
    expect(results[0].metadata?.status).toBe("TODO");
    expect(results[0].metadata?.backend).toBe("github");
  });

  it("should respect limit with filters", async () => {
    const query: SimilarityQuery = {
      queryText: "test query",
      limit: 1,
      filters: { backend: "github" },
    };

    const results = await backend.search(query);

    expect(results).toHaveLength(1);
    expect(["gh#001", "gh#002"]).toContain(results[0].id);
    expect(results[0].metadata?.backend).toBe("github");
  });

  it("should return empty results for non-matching filters", async () => {
    const query: SimilarityQuery = {
      queryText: "test query",
      limit: 10,
      filters: { status: "BLOCKED" },
    };

    const results = await backend.search(query);

    expect(results).toHaveLength(0);
  });

  it("should handle undefined/null filter values", async () => {
    const query: SimilarityQuery = {
      queryText: "test query",
      limit: 10,
      filters: { status: undefined, backend: null },
    };

    const results = await backend.search(query);

    // Should return all results since undefined/null filters are ignored
    expect(results).toHaveLength(5);
  });
});
