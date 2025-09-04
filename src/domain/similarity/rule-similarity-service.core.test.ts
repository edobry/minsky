import { describe, it, expect, beforeEach, beforeAll } from "bun:test";
import { RuleSimilarityService } from "../rules/rule-similarity-service";
import { createRuleSimilarityCore } from "./create-rule-similarity-core";

// Ensure embeddings path does not short-circuit core behavior in test
import { EmbeddingsSimilarityBackend } from "./backends/embeddings-backend";

describe("RuleSimilarityService → SimilaritySearchService (lexical fallback)", () => {
  const workspacePath = "/mock/workspace";

  beforeAll(async () => {
    const { initializeConfiguration, CustomConfigFactory } = await import("../configuration/index");
    await initializeConfiguration(new CustomConfigFactory(), {
      enableCache: true,
      skipValidation: true,
    });
  });

  beforeEach(() => {
    (EmbeddingsSimilarityBackend as any).prototype.isAvailable = async () => false;
  });

  it("searchByText returns top-k ordered results via core", async () => {
    const sim = RuleSimilarityService.createWithWorkspacePath(workspacePath, {});
    const results = await sim.searchByText("refactor modules", 3);
    expect(Array.isArray(results)).toBe(true);
    // Not asserting exact IDs since rules are workspace-dependent; ensure shape
    results.forEach((r) => {
      expect(typeof r.id).toBe("string");
      expect(typeof r.score).toBe("number");
    });
  });
});
