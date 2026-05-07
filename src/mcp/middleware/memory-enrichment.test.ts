/**
 * Unit tests for memory enrichment middleware (mt#1588 spike).
 *
 * Covers:
 * - Allowlist filtering (only `tasks.get` is enriched in the spike)
 * - Env-var kill switch (`MINSKY_MCP_MEMORY_ENRICHMENT=0`)
 * - Missing memoryService → null
 * - search() throwing → null (no propagation)
 * - search() returning degraded → null
 * - search() returning empty → null
 * - Result formatting + budget enforcement
 * - Query construction
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import {
  buildQuery,
  enrichToolResponse,
  isEnrichmentDisabled,
  shouldEnrich,
} from "./memory-enrichment";
import type { MemoryServiceSurface } from "../../domain/memory/memory-service";
import type {
  MemoryRecord,
  MemorySearchResponse,
  MemorySearchResult,
} from "../../domain/memory/types";

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

// Save and restore env between tests since the kill-switch reads process.env.
let savedEnv: string | undefined;
beforeEach(() => {
  savedEnv = process.env.MINSKY_MCP_MEMORY_ENRICHMENT;
  delete process.env.MINSKY_MCP_MEMORY_ENRICHMENT;
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

describe("memory-enrichment / isEnrichmentDisabled", () => {
  test("returns false when env var is unset", () => {
    expect(isEnrichmentDisabled()).toBe(false);
  });
  test("returns true when env var is exactly '0'", () => {
    process.env.MINSKY_MCP_MEMORY_ENRICHMENT = "0";
    expect(isEnrichmentDisabled()).toBe(true);
  });
  test("returns false when env var is '1' or any other non-'0' value", () => {
    process.env.MINSKY_MCP_MEMORY_ENRICHMENT = "1";
    expect(isEnrichmentDisabled()).toBe(false);
    process.env.MINSKY_MCP_MEMORY_ENRICHMENT = "false";
    expect(isEnrichmentDisabled()).toBe(false);
  });
});

describe("memory-enrichment / buildQuery", () => {
  test("stringifies tool name + scalar args", () => {
    expect(buildQuery("tasks.get", { taskId: "mt#1588" })).toBe("tasks.get mt#1588");
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
  test("encodes object values as key=JSON", () => {
    const q = buildQuery("test.tool", { filter: { status: "DONE" } });
    expect(q).toContain("test.tool");
    expect(q).toContain('filter={"status":"DONE"}');
  });
  test("returns just the tool name for empty args", () => {
    expect(buildQuery("session.list", {})).toBe("session.list");
  });
});

describe("memory-enrichment / enrichToolResponse", () => {
  test("returns null for non-allowlisted tool", async () => {
    const service = makeMemoryService({});
    const result = await enrichToolResponse("session.get", { sessionId: "x" }, service);
    expect(result).toBeNull();
  });

  test("returns null when env-var kill switch is set", async () => {
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
    // Total text size must be at or near the requested budget.
    expect(result.text.length).toBeLessThanOrEqual(600);
  });

  test("requests the configured K from search", async () => {
    let capturedLimit: number | undefined;
    const service: MemoryServiceSurface = {
      async search(_query, opts) {
        capturedLimit = opts?.limit;
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
  });
});
