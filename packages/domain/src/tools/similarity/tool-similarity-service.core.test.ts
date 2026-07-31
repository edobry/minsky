import { describe, it, expect, beforeEach, beforeAll, afterEach, afterAll } from "bun:test";
import { ToolSimilarityService } from "./tool-similarity-service";

// Ensure embeddings path does not short-circuit core behavior in test
import { EmbeddingsSimilarityBackend } from "../../similarity/backends/embeddings-backend";
import { first } from "@minsky/shared/array-safety";
import { FakePersistenceProvider } from "../../persistence/fake-persistence-provider";

// mt#2665 R2 review fix: EmbeddingsSimilarityBackend.prototype.isAvailable is a SHARED,
// module-level mutable (not per-instance) -- monkey-patching it here without restoring
// leaked into whichever *other* test file's suite happened to run afterward in the same
// bun test process (bunfig.toml's randomize: true makes the order non-deterministic),
// permanently forcing every other suite's embeddings backend "unavailable" too. This
// broke packages/domain/src/similarity/task-similarity-service.core.test.ts's third
// describe block (which relies on the ORIGINAL isAvailable behaving normally) whenever
// bun happened to run this file first -- reproduced live on CI
// (https://github.com/edobry/minsky/actions/runs/28986550374/job/86016883605) but not
// locally, because the random seed differed. Capture the original and restore it in
// BOTH afterEach (defense against a mid-suite failure) and afterAll, mirroring the
// already-correct pattern in task-similarity-service.core.test.ts.
const ORIGINAL_EMBEDDINGS_IS_AVAILABLE = EmbeddingsSimilarityBackend.prototype.isAvailable;

describe("ToolSimilarityService → SimilaritySearchService (lexical fallback)", () => {
  beforeAll(async () => {
    const { initializeConfiguration, CustomConfigFactory } = await import(
      "../../configuration/index"
    );
    await initializeConfiguration(new CustomConfigFactory(), {
      enableCache: true,
      skipValidation: true,
    });
  });

  beforeEach(() => {
    // Force embeddings backend to be unavailable so core uses lexical backend
    (
      EmbeddingsSimilarityBackend.prototype as unknown as { isAvailable: () => Promise<boolean> }
    ).isAvailable = async () => false;
  });

  afterEach(() => {
    (EmbeddingsSimilarityBackend.prototype as unknown as { isAvailable: unknown }).isAvailable =
      ORIGINAL_EMBEDDINGS_IS_AVAILABLE;
  });

  afterAll(() => {
    (EmbeddingsSimilarityBackend.prototype as unknown as { isAvailable: unknown }).isAvailable =
      ORIGINAL_EMBEDDINGS_IS_AVAILABLE;
  });

  it("searchByText returns top-k ordered results via core", async () => {
    const service = new ToolSimilarityService(new FakePersistenceProvider());
    const results = await service.searchByText("commit changes", 3);
    expect(Array.isArray(results)).toBe(true);
    // Ensure results have proper shape - commands are registry-dependent
    results.forEach((r) => {
      expect(typeof r.id).toBe("string");
      expect(typeof r.score).toBe("number");
    });
  });

  it("findRelevantTools returns enriched results with tool metadata", async () => {
    const service = new ToolSimilarityService(new FakePersistenceProvider());
    const results = await service.findRelevantTools({
      query: "debug failing tests",
      limit: 2,
    });

    expect(Array.isArray(results)).toBe(true);
    results.forEach((result) => {
      expect(typeof result.toolId).toBe("string");
      expect(typeof result.relevanceScore).toBe("number");
      expect(result.tool).toBeDefined();
      expect(result.tool.id).toBe(result.toolId);
      expect(result.tool.description).toBeDefined();
      expect(result.tool.category).toBeDefined();
      expect(typeof result.reason).toBe("string");
    });
  });

  it("similarToTool finds tools similar to given tool ID", async () => {
    const service = new ToolSimilarityService(new FakePersistenceProvider());

    // Find a tool ID to use for similarity
    const searchResults = await service.searchByText("task", 1);
    if (searchResults.length === 0) {
      // Skip test if no tools available
      return;
    }

    const targetToolId = first(searchResults).id;
    const results = await service.similarToTool(targetToolId, 2);

    expect(Array.isArray(results)).toBe(true);
    // Should not include the original tool in results
    results.forEach((r) => {
      expect(r.id).not.toBe(targetToolId);
      expect(typeof r.id).toBe("string");
      expect(typeof r.score).toBe("number");
    });
  });

  it("respects category filtering in findRelevantTools", async () => {
    const service = new ToolSimilarityService(new FakePersistenceProvider());
    const results = await service.findRelevantTools({
      query: "debug test",
      categories: ["TASKS" as any], // Restrict to TASKS category only
      limit: 5,
    });

    // All results should be from TASKS category if any exist
    results.forEach((result) => {
      expect(result.tool.category).toBe("TASKS" as any);
    });
  });

  it("respects threshold filtering in findRelevantTools", async () => {
    const service = new ToolSimilarityService(new FakePersistenceProvider());

    const highThresholdResults = await service.findRelevantTools({
      query: "task management",
      threshold: 0.9, // Very high threshold
      limit: 10,
    });

    const lowThresholdResults = await service.findRelevantTools({
      query: "task management",
      threshold: 0.1, // Low threshold
      limit: 10,
    });

    // High threshold should return fewer or equal results
    expect(highThresholdResults.length).toBeLessThanOrEqual(lowThresholdResults.length);

    // All high threshold results should meet the threshold
    highThresholdResults.forEach((result) => {
      expect(result.relevanceScore).toBeGreaterThanOrEqual(0.9);
    });
  });
});
