import { describe, it, expect, beforeEach, beforeAll, afterEach, afterAll } from "bun:test";
import { RuleSimilarityService } from "../rules/rule-similarity-service";

// Ensure embeddings path does not short-circuit core behavior in test
import { EmbeddingsSimilarityBackend } from "./backends/embeddings-backend";

// mt#2665 R2: this file patched the SHARED prototype without restoring — under
// bunfig's randomize:true, whichever similarity suite loaded AFTER this file
// captured the poisoned `() => false` as its "original" and failed CI-only
// (task-similarity-service.core.test.ts's third describe block). Same fix as
// tool-similarity-service.core.test.ts: capture + restore in afterEach/afterAll.
const ORIGINAL_EMBEDDINGS_IS_AVAILABLE = EmbeddingsSimilarityBackend.prototype.isAvailable;

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

  afterEach(() => {
    (EmbeddingsSimilarityBackend.prototype as unknown as { isAvailable: unknown }).isAvailable =
      ORIGINAL_EMBEDDINGS_IS_AVAILABLE;
  });

  afterAll(() => {
    (EmbeddingsSimilarityBackend.prototype as unknown as { isAvailable: unknown }).isAvailable =
      ORIGINAL_EMBEDDINGS_IS_AVAILABLE;
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
