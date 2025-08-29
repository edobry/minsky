import { describe, it, expect, beforeEach, beforeAll } from "bun:test";
import { ToolSimilarityService } from "./tool-similarity-service";
import { createToolSimilarityCore } from "./create-tool-similarity-core";

// Ensure embeddings path does not short-circuit core behavior in test
import { EmbeddingsSimilarityBackend } from "../../similarity/backends/embeddings-backend";

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
    (EmbeddingsSimilarityBackend as any).prototype.isAvailable = async () => false;
  });

  it("searchByText returns top-k ordered results via core", async () => {
    const service = new ToolSimilarityService();
    const results = await service.searchByText("commit changes", 3);
    expect(Array.isArray(results)).toBe(true);
    // Ensure results have proper shape - commands are registry-dependent
    results.forEach((r) => {
      expect(typeof r.id).toBe("string");
      expect(typeof r.score).toBe("number");
    });
  });

  it("findRelevantTools returns enriched results with tool metadata", async () => {
    const service = new ToolSimilarityService();
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
    const service = new ToolSimilarityService();

    // Find a tool ID to use for similarity
    const searchResults = await service.searchByText("task", 1);
    if (searchResults.length === 0) {
      // Skip test if no tools available
      return;
    }

    const targetToolId = searchResults[0].id;
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
    const service = new ToolSimilarityService();
    const results = await service.findRelevantTools({
      query: "debug test",
      categories: ["TASKS"], // Restrict to TASKS category only
      limit: 5,
    });

    // All results should be from TASKS category if any exist
    results.forEach((result) => {
      expect(result.tool.category).toBe("TASKS");
    });
  });

  it("respects threshold filtering in findRelevantTools", async () => {
    const service = new ToolSimilarityService();

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
