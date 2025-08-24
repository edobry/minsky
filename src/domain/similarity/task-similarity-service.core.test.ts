import { describe, it, expect, beforeEach, beforeAll } from "bun:test";
import { TaskSimilarityService } from "../tasks/task-similarity-service";
import type { EmbeddingService } from "../ai/embeddings/types";
import type { VectorStorage } from "../storage/vector/types";
import { EmbeddingsSimilarityBackend } from "./backends/embeddings-backend";

// Repoint task similarity to generic core by disabling embeddings backend and exercising lexical backend

describe("TaskSimilarityService → SimilaritySearchService (lexical fallback)", () => {
  beforeAll(async () => {
    const { initializeConfiguration, CustomConfigFactory } = await import(
      "../configuration/index"
    );
    await initializeConfiguration(new CustomConfigFactory(), { enableCache: true, skipValidation: true });
    // Ensure embeddings backend is globally disabled for this test file
    (process as any).env = { ...(process as any).env, SIMILARITY_DISABLE_EMBEDDINGS: "1" };
  });
  // Minimal dummy embedding service and vector storage (not used when embeddings is disabled)
  const dummyEmbedding: EmbeddingService = {
    generateEmbedding: async () => new Array(3).fill(0),
  } as any;
  const dummyVector: VectorStorage = {
    initialize: async () => void 0,
    store: async () => void 0,
    search: async () => [],
  } as any;

  const tasks = [
    { id: "md#101", title: "Fix login bug", status: "TODO" },
    { id: "md#102", title: "Refactor modules for clarity", status: "TODO" },
    { id: "md#103", title: "Write tests for auth", status: "IN-PROGRESS" },
  ];

  const specs: Record<string, string> = {
    "md#101": "The login bug occurs when password reset is attempted.",
    "md#102": "Refactor code into domain-oriented modules and improve organization.",
    "md#103": "Add unit tests for authentication flow and error handling.",
  };

  let service: TaskSimilarityService;

  beforeEach(() => {
    // Force embeddings backend to be unavailable so core uses lexical backend
    (EmbeddingsSimilarityBackend as any).prototype.isAvailable = async () => false;

    service = new TaskSimilarityService(
      dummyEmbedding,
      dummyVector,
      async (id: string) => tasks.find((t) => t.id === id) || null,
      async () => tasks,
      async (id: string) => ({ content: specs[id] || "", specPath: "", task: {} }),
      {}
    );
  });

  it("searchByText returns top-k ordered by lexical similarity", async () => {
    const results = await service.searchByText("refactor modules and organization", 2);
    expect(results.length).toBe(2);
    expect(results[0].id).toBe("md#102"); // best lexical match
  });

  it("similarToTask finds similar tasks by content using lexical backend", async () => {
    const results = await service.similarToTask("md#101", 2);
    expect(results.length).toBeGreaterThan(0);
    // md#103 mentions auth/tests; md#102 is refactor; either may appear, just ensure ids exist
    results.forEach((r) => expect(["md#102", "md#103", "md#101"]).toContain(r.id));
  });
});
