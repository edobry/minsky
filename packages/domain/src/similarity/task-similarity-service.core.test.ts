import { describe, it, expect, beforeEach, beforeAll, afterAll } from "bun:test";
import { TaskSimilarityService } from "../tasks/task-similarity-service";
import type { EmbeddingService } from "../ai/embeddings/types";
import type { VectorStorage } from "../storage/vector/types";
import { EmbeddingsSimilarityBackend } from "./backends/embeddings-backend";
import { first } from "@minsky/shared/array-safety";

// These suites force the embeddings backend unavailable by monkey-patching the prototype.
// Capture the original so each suite can restore it in afterAll and not leak the patch into
// other test files running in the same process.
const ORIGINAL_EMBEDDINGS_IS_AVAILABLE = EmbeddingsSimilarityBackend.prototype.isAvailable;

// Repoint task similarity to generic core by disabling embeddings backend and exercising lexical backend

describe("TaskSimilarityService → SimilaritySearchService (lexical fallback)", () => {
  beforeAll(async () => {
    const { initializeConfiguration, CustomConfigFactory } = await import("../configuration/index");
    await initializeConfiguration(new CustomConfigFactory(), {
      enableCache: true,
      skipValidation: true,
    });
  });
  // Minimal dummy embedding service and vector storage (not used when embeddings is disabled)
  const dummyEmbedding: EmbeddingService = {
    generateEmbedding: async () => new Array(3).fill(0),
  } as unknown as EmbeddingService;
  const dummyVector: VectorStorage = {
    initialize: async () => void 0,
    store: async () => void 0,
    search: async () => [],
  } as unknown as VectorStorage;

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
    (
      EmbeddingsSimilarityBackend.prototype as unknown as { isAvailable: () => Promise<boolean> }
    ).isAvailable = async () => false;

    service = new TaskSimilarityService(
      dummyEmbedding,
      dummyVector,
      async (id: string) => tasks.find((t) => t.id === id) || null,
      async () => tasks,

      async (id: string) => ({ content: specs[id] || "", specPath: "", task: {} as any }),
      {}
    );
  });

  afterAll(() => {
    (EmbeddingsSimilarityBackend.prototype as unknown as { isAvailable: unknown }).isAvailable =
      ORIGINAL_EMBEDDINGS_IS_AVAILABLE;
  });

  it("searchByText returns top-k ordered by lexical similarity", async () => {
    const response = await service.searchByText("refactor modules and organization", 2);
    expect(response.results.length).toBe(2);
    expect(first(response.results).id).toBe("md#102"); // best lexical match
    expect(response.backend).toBe("lexical"); // embeddings disabled, falls back to lexical
    expect(response.degraded).toBe(false); // not degraded, just unavailable
  });

  it("similarToTask finds similar tasks by content using lexical backend", async () => {
    const response = await service.similarToTask("md#101", 2);
    expect(response.results.length).toBeGreaterThan(0);
    // md#103 mentions auth/tests; md#102 is refactor; either may appear, just ensure ids exist
    response.results.forEach((r) => expect(["md#102", "md#103", "md#101"]).toContain(r.id));
    expect(response.backend).toBe("lexical");
  });
});

// Regression for mt#2220 (ADR-013): status filtering is applied at READ TIME against the
// live task status in the domain service, NOT via a denormalized column in the vector store.
// A strongly-matching DONE task must be excluded from the default search and reappear with
// --all (no filter), proving the filter operates on live status and surfaces non-excluded
// matches that the old NULL-column WHERE clause silently dropped.
describe("TaskSimilarityService read-time status filter (mt#2220 / ADR-013)", () => {
  beforeAll(async () => {
    const { initializeConfiguration, CustomConfigFactory } = await import("../configuration/index");
    await initializeConfiguration(new CustomConfigFactory(), {
      enableCache: true,
      skipValidation: true,
    });
  });

  const dummyEmbedding: EmbeddingService = {
    generateEmbedding: async () => new Array(3).fill(0),
  } as unknown as EmbeddingService;
  const dummyVector: VectorStorage = {
    initialize: async () => void 0,
    store: async () => void 0,
    search: async () => [],
  } as unknown as VectorStorage;

  // Two strong matches for "deploy pipeline": one DONE, one TODO; plus an unrelated TODO.
  const tasks = [
    { id: "md#201", title: "Deploy pipeline rewrite", status: "DONE" },
    { id: "md#202", title: "Deploy pipeline monitoring", status: "TODO" },
    { id: "md#203", title: "Unrelated documentation cleanup", status: "TODO" },
  ];
  const specs: Record<string, string> = {
    "md#201": "Deploy pipeline rewrite for the release process.",
    "md#202": "Deploy pipeline monitoring and alerting.",
    "md#203": "Clean up unrelated documentation and typos.",
  };

  let service: TaskSimilarityService;

  beforeEach(() => {
    (
      EmbeddingsSimilarityBackend.prototype as unknown as { isAvailable: () => Promise<boolean> }
    ).isAvailable = async () => false;

    service = new TaskSimilarityService(
      dummyEmbedding,
      dummyVector,
      async (id: string) => tasks.find((t) => t.id === id) || null,
      async () => tasks,
      async (id: string) => ({ content: specs[id] || "", specPath: "", task: {} as any }),
      {}
    );
  });

  afterAll(() => {
    (EmbeddingsSimilarityBackend.prototype as unknown as { isAvailable: unknown }).isAvailable =
      ORIGINAL_EMBEDDINGS_IS_AVAILABLE;
  });

  it("default search excludes DONE/CLOSED tasks (filters on live status)", async () => {
    const response = await service.searchByText("deploy pipeline", 5, undefined, {
      statusExclude: ["DONE", "CLOSED"],
    });
    const ids = response.results.map((r) => r.id);
    expect(ids).not.toContain("md#201"); // DONE — excluded
    expect(ids).toContain("md#202"); // TODO match — surfaced
  });

  it("--all (no filter) surfaces the DONE task, proving exclusion is what hides it", async () => {
    const response = await service.searchByText("deploy pipeline", 5);
    const ids = response.results.map((r) => r.id);
    expect(ids).toContain("md#201"); // findable when not filtered
  });

  it("explicit status filter returns only matching-status tasks", async () => {
    const response = await service.searchByText("deploy pipeline", 5, undefined, {
      status: "DONE",
    });
    const ids = response.results.map((r) => r.id);
    expect(ids).toContain("md#201");
    expect(ids).not.toContain("md#202"); // TODO — excluded by status=DONE
  });

  it("over-fetch surfaces a non-excluded match even when stronger matches are excluded", async () => {
    // limit=1, but the top lexical match (md#201) is DONE; the read-time filter + over-fetch
    // must still return the non-excluded match rather than an empty result.
    const response = await service.searchByText("deploy pipeline", 1, undefined, {
      statusExclude: ["DONE", "CLOSED"],
    });
    expect(response.results.length).toBe(1);
    expect(response.results[0]?.id).toBe("md#202");
  });
});
