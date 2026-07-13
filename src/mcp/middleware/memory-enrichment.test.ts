/**
 * Unit tests for memory enrichment middleware (mt#1588 spike).
 *
 * Covers:
 * - Allowlist filtering (only `tasks.get` is enriched in the spike)
 * - Env-var opt-in (`MINSKY_MCP_MEMORY_ENRICHMENT=1` enables; default disabled)
 * - Missing memoryService → null
 * - search() throwing → null (no propagation)
 * - search() returning degraded → null
 * - search() returning empty → null
 * - Result formatting + budget enforcement
 * - Query construction including size cap + object-arg redaction
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import {
  buildQuery,
  enrichToolResponse,
  isEnrichmentEnabled,
  shouldEnrich,
} from "./memory-enrichment";
import type { MemoryServiceSurface } from "@minsky/domain/memory/memory-service";
import type {
  MemoryRecord,
  MemorySearchResponse,
  MemorySearchResult,
} from "@minsky/domain/memory/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMemoryRecord(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: "test-id",
    type: "feedback",
    name: "Test memory",
    description: "Test description",
    content: "Test content body",
    scope: "user",
    projectId: null,
    tags: [],
    sourceAgentId: null,
    sourceSessionId: null,
    confidence: null,
    supersededBy: null,
    metadata: null,
    associations: {},
    createdAt: new Date(),
    updatedAt: new Date(),
    lastAccessedAt: null,
    accessCount: 0,
    ...overrides,
  };
}

function makeSearchResult(overrides: Partial<MemorySearchResult> = {}): MemorySearchResult {
  return {
    record: makeMemoryRecord(),
    score: 0.85,
    ...overrides,
  };
}

function makeMemoryService(opts: {
  searchResponse?: MemorySearchResponse;
  searchError?: Error;
}): MemoryServiceSurface {
  return {
    async search() {
      if (opts.searchError) throw opts.searchError;
      return opts.searchResponse ?? { results: [], backend: "embeddings", degraded: false };
    },
    async get() {
      return null;
    },
    async list() {
      return [];
    },
    async create() {
      throw new Error("not implemented in fake");
    },
    async update() {
      return null;
    },
    async delete() {},
    async similar() {
      return [];
    },
    async supersede() {
      throw new Error("not implemented in fake");
    },
    async lineage() {
      return { chain: [], truncated: false };
    },
  };
}

/** Shared constant: the canonical query string buildQuery emits for the
 * representative `tasks.get(taskId: "mt#1588")` call. Used in the buildQuery
 * stringification test and in the search-passthrough tests below. */
const TEST_TASK_GET_QUERY = "tasks.get mt#1588";

// Save and restore env between tests since the opt-in reads process.env.
let savedEnv: string | undefined;
beforeEach(() => {
  savedEnv = process.env.MINSKY_MCP_MEMORY_ENRICHMENT;
  // Default each test to ENABLED so the test's intent is what's exercised;
  // tests that want the disabled path explicitly delete the var.
  process.env.MINSKY_MCP_MEMORY_ENRICHMENT = "1";
});
afterEach(() => {
  if (savedEnv === undefined) {
    delete process.env.MINSKY_MCP_MEMORY_ENRICHMENT;
  } else {
    process.env.MINSKY_MCP_MEMORY_ENRICHMENT = savedEnv;
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("memory-enrichment / shouldEnrich", () => {
  test("returns true for tasks.get", () => {
    expect(shouldEnrich("tasks.get")).toBe(true);
  });
  test("returns false for tools not in the allowlist", () => {
    expect(shouldEnrich("tasks.list")).toBe(false);
    expect(shouldEnrich("session.get")).toBe(false);
    expect(shouldEnrich("memory.search")).toBe(false);
  });
});

describe("memory-enrichment / isEnrichmentEnabled", () => {
  test("returns true when env var is '1'", () => {
    process.env.MINSKY_MCP_MEMORY_ENRICHMENT = "1";
    expect(isEnrichmentEnabled()).toBe(true);
  });
  test("returns true when env var is 'true'", () => {
    process.env.MINSKY_MCP_MEMORY_ENRICHMENT = "true";
    expect(isEnrichmentEnabled()).toBe(true);
  });
  test("returns false when env var is unset (default disabled)", () => {
    delete process.env.MINSKY_MCP_MEMORY_ENRICHMENT;
    expect(isEnrichmentEnabled()).toBe(false);
  });
  test("returns false when env var is '0'", () => {
    process.env.MINSKY_MCP_MEMORY_ENRICHMENT = "0";
    expect(isEnrichmentEnabled()).toBe(false);
  });
  test("returns false for any other non-truthy value", () => {
    process.env.MINSKY_MCP_MEMORY_ENRICHMENT = "false";
    expect(isEnrichmentEnabled()).toBe(false);
    process.env.MINSKY_MCP_MEMORY_ENRICHMENT = "yes";
    expect(isEnrichmentEnabled()).toBe(false);
  });
});

describe("memory-enrichment / buildQuery", () => {
  test("stringifies tool name + scalar args", () => {
    expect(buildQuery("tasks.get", { taskId: "mt#1588" })).toBe(TEST_TASK_GET_QUERY);
  });
  test("filters out empty/null/undefined values", () => {
    expect(
      buildQuery("tasks.get", {
        taskId: "mt#1588",
        backend: undefined,
        repo: null as unknown as string,
        session: "",
      })
    ).toBe("tasks.get mt#1588");
  });
  test("redacts object values to key-only (value dropped, key included as hint)", () => {
    const q = buildQuery("test.tool", { filter: { status: "DONE" } });
    expect(q).toBe("test.tool filter");
    expect(q).not.toContain("DONE");
    expect(q).not.toContain("status");
    expect(q).not.toContain("{");
  });
  test("redacts array values to key-only", () => {
    const q = buildQuery("test.tool", { ids: ["a", "b", "c"] });
    expect(q).toBe("test.tool ids");
    expect(q).not.toContain("[");
  });
  test("redacts string values when key matches sensitive-key pattern", () => {
    const q1 = buildQuery("test.tool", { token: "sk-abc-secret-XYZ" });
    expect(q1).toBe("test.tool token");
    expect(q1).not.toContain("sk-abc");

    const q2 = buildQuery("test.tool", { password: "hunter2" });
    expect(q2).toBe("test.tool password");
    expect(q2).not.toContain("hunter2");

    const q3 = buildQuery("test.tool", { apiKey: "AIzaSyXXX" });
    expect(q3).toBe("test.tool apiKey");
    expect(q3).not.toContain("AIzaSy");

    const q4 = buildQuery("test.tool", { authorization: "Bearer xyz" });
    expect(q4).toBe("test.tool authorization");
    expect(q4).not.toContain("Bearer");

    const q5 = buildQuery("test.tool", { auth: "x" });
    expect(q5).toBe("test.tool auth");

    // Non-sensitive keys still pass values through.
    expect(buildQuery("test.tool", { taskId: "mt#1588" })).toBe("test.tool mt#1588");
  });
  test("includes key context for non-string scalars (key=value form)", () => {
    const q = buildQuery("test.tool", { retries: 3, verbose: true, ratio: 0.5 });
    expect(q).toContain("retries=3");
    expect(q).toContain("verbose=true");
    expect(q).toContain("ratio=0.5");
    // Strings still appended bare (their meaning is in the value itself).
    const q2 = buildQuery("tasks.get", { taskId: "mt#1588" });
    expect(q2).toBe(TEST_TASK_GET_QUERY);
  });
  test("returns just the tool name for empty args", () => {
    expect(buildQuery("session.list", {})).toBe("session.list");
  });
  test("hard-caps the query at MAX_QUERY_LENGTH chars with ellipsis suffix", () => {
    const longArg = "x".repeat(2000);
    const q = buildQuery("tasks.get", { taskId: longArg });
    expect(q.length).toBeLessThanOrEqual(500);
    expect(q.endsWith("…")).toBe(true);
  });
});

describe("memory-enrichment / enrichToolResponse", () => {
  test("returns null when env-var opt-in is unset (default disabled)", async () => {
    delete process.env.MINSKY_MCP_MEMORY_ENRICHMENT;
    const service = makeMemoryService({
      searchResponse: {
        results: [makeSearchResult()],
        backend: "embeddings",
        degraded: false,
      },
    });
    const result = await enrichToolResponse("tasks.get", { taskId: "mt#1588" }, service);
    expect(result).toBeNull();
  });

  test("returns null when env-var is set to '0'", async () => {
    process.env.MINSKY_MCP_MEMORY_ENRICHMENT = "0";
    const service = makeMemoryService({
      searchResponse: {
        results: [makeSearchResult()],
        backend: "embeddings",
        degraded: false,
      },
    });
    const result = await enrichToolResponse("tasks.get", { taskId: "mt#1588" }, service);
    expect(result).toBeNull();
  });

  test("returns null for non-allowlisted tool", async () => {
    const service = makeMemoryService({});
    const result = await enrichToolResponse("session.get", { sessionId: "x" }, service);
    expect(result).toBeNull();
  });

  test("returns null when memoryService is undefined", async () => {
    const result = await enrichToolResponse("tasks.get", { taskId: "mt#1588" }, undefined);
    expect(result).toBeNull();
  });

  test("returns null when search throws", async () => {
    const service = makeMemoryService({ searchError: new Error("boom") });
    const result = await enrichToolResponse("tasks.get", { taskId: "mt#1588" }, service);
    expect(result).toBeNull();
  });

  test("returns null when search returns degraded", async () => {
    const service = makeMemoryService({
      searchResponse: { results: [], backend: "none", degraded: true },
    });
    const result = await enrichToolResponse("tasks.get", { taskId: "mt#1588" }, service);
    expect(result).toBeNull();
  });

  test("returns null when search returns no results", async () => {
    const service = makeMemoryService({
      searchResponse: { results: [], backend: "embeddings", degraded: false },
    });
    const result = await enrichToolResponse("tasks.get", { taskId: "mt#1588" }, service);
    expect(result).toBeNull();
  });

  test("formats results into a memory-context block", async () => {
    const service = makeMemoryService({
      searchResponse: {
        results: [
          makeSearchResult({
            record: makeMemoryRecord({
              type: "feedback",
              name: "Test rule A",
              description: "Description A",
            }),
            score: 0.91,
          }),
          makeSearchResult({
            record: makeMemoryRecord({
              id: "id-2",
              type: "project",
              name: "Test project B",
              description: "Description B",
            }),
            score: 0.82,
          }),
        ],
        backend: "embeddings",
        degraded: false,
      },
    });
    const result = await enrichToolResponse("tasks.get", { taskId: "mt#1588" }, service);
    expect(result).not.toBeNull();
    expect(result?.type).toBe("text");
    expect(result?.text).toContain('<memory-context tool="tasks.get" count="2">');
    expect(result?.text).toContain("</memory-context>");
    expect(result?.text).toContain("[feedback] Test rule A");
    expect(result?.text).toContain("score 0.91");
    expect(result?.text).toContain("[project] Test project B");
    expect(result?.text).toContain("Description A");
    expect(result?.text).toContain("Description B");
  });

  test("respects total char budget", async () => {
    const longBody = "x".repeat(5000);
    const service = makeMemoryService({
      searchResponse: {
        results: [
          makeSearchResult({
            record: makeMemoryRecord({ description: longBody }),
            score: 0.95,
          }),
          makeSearchResult({
            record: makeMemoryRecord({ id: "id-2", description: longBody }),
            score: 0.92,
          }),
          makeSearchResult({
            record: makeMemoryRecord({ id: "id-3", description: longBody }),
            score: 0.9,
          }),
        ],
        backend: "embeddings",
        degraded: false,
      },
    });
    const result = await enrichToolResponse("tasks.get", { taskId: "mt#1588" }, service, {
      charBudget: 600,
    });
    expect(result).not.toBeNull();
    if (result === null) throw new Error("unreachable");
    expect(result.text.length).toBeLessThanOrEqual(600);
  });

  test("requests the configured K from search", async () => {
    let capturedLimit: number | undefined;
    let capturedQuery: string | undefined;
    const service: MemoryServiceSurface = {
      async search(query, opts) {
        capturedLimit = opts?.limit;
        capturedQuery = query;
        return { results: [], backend: "embeddings", degraded: false };
      },
      async get() {
        return null;
      },
      async list() {
        return [];
      },
      async create() {
        throw new Error("not implemented");
      },
      async update() {
        return null;
      },
      async delete() {},
      async similar() {
        return [];
      },
      async supersede() {
        throw new Error("not implemented");
      },
      async lineage() {
        return { chain: [], truncated: false };
      },
    };
    await enrichToolResponse("tasks.get", { taskId: "mt#1588" }, service, { k: 7 });
    expect(capturedLimit).toBe(7);
    expect(capturedQuery).toBe(TEST_TASK_GET_QUERY);
  });

  test("redacts object args before passing query to search", async () => {
    let capturedQuery: string | undefined;
    const service: MemoryServiceSurface = {
      async search(query) {
        capturedQuery = query;
        return { results: [], backend: "embeddings", degraded: false };
      },
      async get() {
        return null;
      },
      async list() {
        return [];
      },
      async create() {
        throw new Error("not implemented");
      },
      async update() {
        return null;
      },
      async delete() {},
      async similar() {
        return [];
      },
      async supersede() {
        throw new Error("not implemented");
      },
      async lineage() {
        return { chain: [], truncated: false };
      },
    };
    await enrichToolResponse(
      "tasks.get",
      { taskId: "mt#1588", filter: { status: "DONE", body: "x".repeat(10000) } },
      service
    );
    expect(capturedQuery).toBe("tasks.get mt#1588 filter");
    expect(capturedQuery).not.toContain("DONE");
    expect(capturedQuery).not.toContain("x".repeat(100));
  });

  test("returns null when search exceeds the configured timeout", async () => {
    // Search that never resolves — relies on the timeout path to return null.
    const service: MemoryServiceSurface = {
      async search() {
        return new Promise(() => {
          /* never resolves */
        });
      },
      async get() {
        return null;
      },
      async list() {
        return [];
      },
      async create() {
        throw new Error("not implemented");
      },
      async update() {
        return null;
      },
      async delete() {},
      async similar() {
        return [];
      },
      async supersede() {
        throw new Error("not implemented");
      },
      async lineage() {
        return { chain: [], truncated: false };
      },
    };
    const result = await enrichToolResponse("tasks.get", { taskId: "mt#1588" }, service, {
      timeoutMs: 50,
    });
    expect(result).toBeNull();
  });
});
