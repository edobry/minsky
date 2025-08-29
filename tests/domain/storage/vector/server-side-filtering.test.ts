import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { MemoryVectorStorage } from "../../../../src/domain/storage/vector/memory-vector-storage";
import type { SearchOptions } from "../../../../src/domain/storage/vector/types";

describe("VectorStorage Server-Side Filtering", () => {
  let storage: MemoryVectorStorage;
  const dimension = 3;

  beforeEach(async () => {
    storage = new MemoryVectorStorage(dimension);

    // Add test vectors with metadata
    await storage.store("task1", [1, 0, 0], { status: "TODO", backend: "github" });
    await storage.store("task2", [0, 1, 0], { status: "IN-PROGRESS", backend: "github" });
    await storage.store("task3", [0, 0, 1], { status: "DONE", backend: "github" });
    await storage.store("task4", [1, 1, 0], { status: "TODO", backend: "markdown" });
    await storage.store("task5", [0, 1, 1], { status: "IN-PROGRESS", backend: "markdown" });
  });

  afterEach(() => {
    // Cleanup
  });

  it("should return all results when no filters are provided", async () => {
    const queryVector = [1, 0, 0];
    const results = await storage.search(queryVector, { limit: 10 });

    expect(results).toHaveLength(5);
    expect(results.map((r) => r.id).sort()).toEqual(["task1", "task2", "task3", "task4", "task5"]);
  });

  it("should filter by status", async () => {
    const queryVector = [1, 0, 0];
    const options: SearchOptions = {
      limit: 10,
      filters: { status: "TODO" },
    };

    const results = await storage.search(queryVector, options);

    expect(results).toHaveLength(2);
    expect(results.map((r) => r.id).sort()).toEqual(["task1", "task4"]);
    results.forEach((result) => {
      expect(result.metadata?.status).toBe("TODO");
    });
  });

  it("should filter by backend", async () => {
    const queryVector = [1, 0, 0];
    const options: SearchOptions = {
      limit: 10,
      filters: { backend: "markdown" },
    };

    const results = await storage.search(queryVector, options);

    expect(results).toHaveLength(2);
    expect(results.map((r) => r.id).sort()).toEqual(["task4", "task5"]);
    results.forEach((result) => {
      expect(result.metadata?.backend).toBe("markdown");
    });
  });

  it("should filter by multiple criteria", async () => {
    const queryVector = [1, 0, 0];
    const options: SearchOptions = {
      limit: 10,
      filters: { status: "IN-PROGRESS", backend: "github" },
    };

    const results = await storage.search(queryVector, options);

    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("task2");
    expect(results[0].metadata?.status).toBe("IN-PROGRESS");
    expect(results[0].metadata?.backend).toBe("github");
  });

  it("should return empty results when no matches found", async () => {
    const queryVector = [1, 0, 0];
    const options: SearchOptions = {
      limit: 10,
      filters: { status: "BLOCKED" },
    };

    const results = await storage.search(queryVector, options);

    expect(results).toHaveLength(0);
  });

  it("should respect limit parameter with filters", async () => {
    const queryVector = [1, 0, 0];
    const options: SearchOptions = {
      limit: 1,
      filters: { backend: "github" },
    };

    const results = await storage.search(queryVector, options);

    expect(results).toHaveLength(1);
    expect(results[0].metadata?.backend).toBe("github");
  });

  it("should order results by similarity score", async () => {
    const queryVector = [1, 0, 0]; // Closest to task1 [1,0,0]
    const options: SearchOptions = {
      limit: 10,
      filters: { backend: "github" },
    };

    const results = await storage.search(queryVector, options);

    expect(results).toHaveLength(3);
    expect(results[0].id).toBe("task1"); // Exact match should be first
    expect(results[0].score).toBe(0); // Distance 0 for exact match

    // Verify scores are in ascending order (lower score = better match)
    for (let i = 1; i < results.length; i++) {
      expect(results[i].score).toBeGreaterThanOrEqual(results[i - 1].score);
    }
  });
});
