import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "bun:test";
import { TaskSimilarityService } from "../tasks/task-similarity-service";
import type { EmbeddingService } from "../ai/embeddings/types";
import type { VectorStorage, SearchOptions, SearchResult } from "../storage/vector/types";
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

// Regression guard for mt#2260 (no-forward contract): mt#2220 fixed tasks_search to apply
// status/statusExclude/backend filters at READ TIME and to call the vector store with NO
// `filters` key (so the embeddings backend never builds a `WHERE status NOT IN (...)` clause
// against the now-dropped denormalized columns — the mt#2236 "column status does not exist"
// symptom). The suites above force the embeddings backend UNAVAILABLE, so they exercise the
// lexical path and never reach the embeddings/vector-store boundary. This suite keeps the
// embeddings backend AVAILABLE and spies on the vector store to assert the SimilarityQuery
// that reaches `embeddings-backend.ts` carries no domain filter, on BOTH the fast path
// (no domain filter) and the over-fetch path (with a domain filter). The test goes red if a
// future change re-adds `filters` forwarding into the SimilarityQuery passed to
// `getSearchService().search(...)`.
describe("TaskSimilarityService no-filter-forward contract (mt#2260 / ADR-013)", () => {
  // No initializeConfiguration here: this suite's path (searchByText with a dummy embedding
  // service + spy vector store) reads no configuration, and avoiding a third dynamic import of
  // "../configuration/index" keeps the magic-string-duplication lint clean.

  // One DONE + one TODO strong match so the read-time filter has something to drop/keep.
  const tasks = [
    { id: "md#301", title: "Deploy pipeline rewrite", status: "DONE", backend: "minsky" },
    { id: "md#302", title: "Deploy pipeline monitoring", status: "TODO", backend: "minsky" },
  ];

  // Records the `options` arg passed to vectorStorage.search on every invocation, so the test
  // can assert no `filters`/`status`/`statusExclude`/`backend` key was forwarded down. Typed as
  // SearchOptions (not Record<string, unknown>) so an options-shape regression is caught at
  // compile time as well.
  let capturedSearchOptions: Array<SearchOptions | undefined>;

  const dummyEmbedding: EmbeddingService = {
    generateEmbedding: async () => new Array(3).fill(0.1),
  } as unknown as EmbeddingService;

  // Implements the full VectorStorage interface (no force-cast) so a contract change to the
  // interface surfaces in this stub at compile time.
  const spyVector: VectorStorage = {
    store: async () => void 0,
    delete: async () => void 0,
    search: async (_vector: number[], options?: SearchOptions): Promise<SearchResult[]> => {
      capturedSearchOptions.push(options);
      // Return both tasks as candidates (ids map to live tasks above).
      return tasks.map((t, i) => ({ id: t.id, score: 1 - i * 0.1, metadata: {} }));
    },
  };

  let service: TaskSimilarityService;

  beforeEach(() => {
    capturedSearchOptions = [];
    // Ensure the embeddings backend is AVAILABLE regardless of suite ordering (the suites
    // above patch the prototype to return false); restoring the original makes isAvailable()
    // return true for the injected embedding service + vector store.
    (EmbeddingsSimilarityBackend.prototype as unknown as { isAvailable: unknown }).isAvailable =
      ORIGINAL_EMBEDDINGS_IS_AVAILABLE;

    service = new TaskSimilarityService(
      dummyEmbedding,
      spyVector,
      async (id: string) => tasks.find((t) => t.id === id) || null,
      async () => tasks as any,
      async (_id: string) => ({ content: "", specPath: "", task: {} as any }),
      {}
    );
  });

  // Restore the prototype after every test (not just afterAll) so a mid-suite failure can't
  // leak the patched isAvailable into other suites in the same process.
  afterEach(() => {
    (EmbeddingsSimilarityBackend.prototype as unknown as { isAvailable: unknown }).isAvailable =
      ORIGINAL_EMBEDDINGS_IS_AVAILABLE;
  });

  afterAll(() => {
    (EmbeddingsSimilarityBackend.prototype as unknown as { isAvailable: unknown }).isAvailable =
      ORIGINAL_EMBEDDINGS_IS_AVAILABLE;
  });

  const expectNoForwardedFilter = (calls: Array<Record<string, unknown> | undefined>): void => {
    expect(calls.length).toBeGreaterThan(0);
    for (const opts of calls) {
      // `embeddings-backend.ts` always sets `filters: query.filters`; the contract is that
      // `query.filters` stays undefined (filtering is read-time only). A regression that
      // forwards the domain filter makes this defined and flips the assertion red.
      expect(opts?.filters).toBeUndefined();
      expect(opts).not.toHaveProperty("status");
      expect(opts).not.toHaveProperty("statusExclude");
      expect(opts).not.toHaveProperty("backend");
    }
  };

  it("fast path (no domain filter): embeddings backend runs with no forwarded filter", async () => {
    const response = await service.searchByText("deploy pipeline", 5);
    // Proves the embeddings/vector-store boundary actually ran (not the lexical fallback).
    expect(response.backend).toBe("embeddings");
    expect(response.degraded).toBe(false);
    expectNoForwardedFilter(capturedSearchOptions);
  });

  it("over-fetch path (statusExclude): filter applied read-time, never forwarded", async () => {
    const response = await service.searchByText("deploy pipeline", 5, undefined, {
      statusExclude: ["DONE", "CLOSED"],
    });
    expect(response.backend).toBe("embeddings");
    expect(response.degraded).toBe(false);
    // Read-time filter actually applied against live status: DONE dropped, TODO surfaced.
    const ids = response.results.map((r) => r.id);
    expect(ids).not.toContain("md#301");
    expect(ids).toContain("md#302");
    expectNoForwardedFilter(capturedSearchOptions);
  });

  it("over-fetch path (status equals): filter applied read-time, never forwarded", async () => {
    const response = await service.searchByText("deploy pipeline", 5, undefined, {
      status: "DONE",
    });
    expect(response.backend).toBe("embeddings");
    const ids = response.results.map((r) => r.id);
    expect(ids).toContain("md#301");
    expect(ids).not.toContain("md#302");
    expectNoForwardedFilter(capturedSearchOptions);
  });
});

// Regression for mt#2762: `kind` is applied at READ TIME against the live task, the same way
// status/backend are (see the mt#2220/ADR-013 suite above) — not pushed down into the vector
// store. A task with no `kind` field (the GHI-backend gap) is treated as "implementation".
// No initializeConfiguration call here (see the no-filter-forward suite's comment above) —
// a third occurrence of the "../configuration/index" dynamic import trips the
// no-magic-string-duplication lint rule, and this suite's lexical-fallback path doesn't need it.
describe("TaskSimilarityService read-time kind filter (mt#2762)", () => {
  const dummyEmbedding: EmbeddingService = {
    generateEmbedding: async () => new Array(3).fill(0),
  } as unknown as EmbeddingService;
  const dummyVector: VectorStorage = {
    initialize: async () => void 0,
    store: async () => void 0,
    search: async () => [],
  } as unknown as VectorStorage;

  // Two strong lexical matches for QUERY below: one umbrella, one implementation (kind
  // omitted, defaults to "implementation"); plus an unrelated task.
  const QUERY = "widget rollout plan";
  const tasks = [
    { id: "md#501", title: "Widget rollout plan epic", status: "TODO", kind: "umbrella" },
    { id: "md#502", title: "Widget rollout plan task", status: "TODO" },
    { id: "md#503", title: "Unrelated changelog cleanup", status: "TODO" },
  ];
  const specs: Record<string, string> = {
    "md#501": "Widget rollout plan tracking the overall release effort.",
    "md#502": "Widget rollout plan implementation work for the release.",
    "md#503": "Clean up an unrelated changelog entry.",
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
      async () => tasks as any,
      async (id: string) => ({ content: specs[id] || "", specPath: "", task: {} as any }),
      {}
    );
  });

  afterAll(() => {
    (EmbeddingsSimilarityBackend.prototype as unknown as { isAvailable: unknown }).isAvailable =
      ORIGINAL_EMBEDDINGS_IS_AVAILABLE;
  });

  it("kind=umbrella returns only the umbrella-kind match", async () => {
    const response = await service.searchByText(QUERY, 5, undefined, {
      kind: "umbrella",
    });
    const ids = response.results.map((r) => r.id);
    expect(ids).toContain("md#501");
    expect(ids).not.toContain("md#502"); // implementation (default) — excluded
  });

  it("kind=implementation matches a task with no kind field (default)", async () => {
    const response = await service.searchByText(QUERY, 5, undefined, {
      kind: "implementation",
    });
    const ids = response.results.map((r) => r.id);
    expect(ids).toContain("md#502");
    expect(ids).not.toContain("md#501"); // umbrella — excluded
  });

  it("no kind filter surfaces both matches", async () => {
    const response = await service.searchByText(QUERY, 5);
    const ids = response.results.map((r) => r.id);
    expect(ids).toContain("md#501");
    expect(ids).toContain("md#502");
  });
});

// mt#2754: the filtered path embeds the query ONCE (concurrently with the live-task fetch) and
// reuses that precomputed vector for the vector search(es) — the embed-split latency fix. Verified
// by counting embed calls and asserting the vector store receives the precomputed vector.
describe("TaskSimilarityService embed-split reuses one query vector (mt#2754)", () => {
  const tasks = [
    { id: "md#401", title: "Embed-split candidate one", status: "TODO", backend: "minsky" },
    { id: "md#402", title: "Embed-split candidate two", status: "TODO", backend: "minsky" },
  ];
  const QUERY_VECTOR = [0.42, 0.43, 0.44];
  let embedCalls: number;
  let capturedVectors: number[][];

  const countingEmbedding: EmbeddingService = {
    generateEmbedding: async () => {
      embedCalls++;
      return QUERY_VECTOR;
    },
  } as unknown as EmbeddingService;

  const spyVector: VectorStorage = {
    store: async () => void 0,
    delete: async () => void 0,
    search: async (vector: number[]): Promise<SearchResult[]> => {
      capturedVectors.push(vector);
      return tasks.map((t, i) => ({ id: t.id, score: 1 - i * 0.1, metadata: {} }));
    },
  };

  let service: TaskSimilarityService;

  beforeEach(() => {
    embedCalls = 0;
    capturedVectors = [];
    (EmbeddingsSimilarityBackend.prototype as unknown as { isAvailable: unknown }).isAvailable =
      ORIGINAL_EMBEDDINGS_IS_AVAILABLE;
    service = new TaskSimilarityService(
      countingEmbedding,
      spyVector,
      async (id: string) => tasks.find((t) => t.id === id) || null,
      async () => tasks as any,
      async (_id: string) => ({ content: "", specPath: "", task: {} as any }),
      {}
    );
  });

  afterEach(() => {
    (EmbeddingsSimilarityBackend.prototype as unknown as { isAvailable: unknown }).isAvailable =
      ORIGINAL_EMBEDDINGS_IS_AVAILABLE;
  });

  it("filtered search embeds once and passes the precomputed vector to the vector store", async () => {
    const response = await service.searchByText("deploy pipeline", 5, undefined, {
      statusExclude: ["DONE", "CLOSED"],
    });
    expect(response.backend).toBe("embeddings");
    // Embedded exactly once (in searchByText's Promise.all), NOT re-embedded inside the backend.
    expect(embedCalls).toBe(1);
    // Every vector-store search received the precomputed query vector.
    expect(capturedVectors.length).toBeGreaterThan(0);
    for (const v of capturedVectors) {
      expect(v).toEqual(QUERY_VECTOR);
    }
  });

  it("pre-embed failure degrades to the lexical backend instead of throwing", async () => {
    const throwingEmbedding: EmbeddingService = {
      generateEmbedding: async () => {
        throw new Error("embedding provider unavailable");
      },
    } as unknown as EmbeddingService;
    // Lexical needs content to score against; make it overlap the query.
    const specForLexical: Record<string, string> = {
      "md#401": "widget alpha configuration and rollout notes",
      "md#402": "widget beta configuration and rollout notes",
    };
    const svc = new TaskSimilarityService(
      throwingEmbedding,
      spyVector,
      async (id: string) => tasks.find((t) => t.id === id) || null,
      async () => tasks as any,
      async (id: string) => ({ content: specForLexical[id] || "", specPath: "", task: {} as any }),
      {}
    );

    // The precompute embed throws; searchByText must NOT bubble it — the search service
    // fails the embeddings backend and degrades to lexical (mt#2754 review BLOCKING).
    const response = await svc.searchByText("widget configuration rollout", 5, undefined, {
      statusExclude: ["DONE", "CLOSED"],
    });
    expect(response.backend).toBe("lexical");
    expect(response.degraded).toBe(true);
    expect(response.results.length).toBeGreaterThan(0);
  });
});
