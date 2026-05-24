/**
 * Tests for the mt#1625 spike memory-bundle composer.
 *
 * Coverage:
 * - isInstructionsBundleEnabled() env-var gate
 * - buildBundleText() output shape + budget capping
 * - composeMemoryBundle() integration (env gate, list results, error path)
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  isInstructionsBundleEnabled,
  buildBundleText,
  composeMemoryBundle,
  INSTRUCTIONS_BUNDLE_ENV_VAR,
} from "./memory-bundle";
import type { MemoryRecord } from "../../domain/memory/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRecord(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: "test-id",
    type: "feedback",
    name: "Test memory",
    description: "A test memory description",
    content: "This is the content of the memory entry.",
    scope: "user",
    projectId: null,
    tags: [],
    sourceAgentId: null,
    sourceSessionId: null,
    confidence: null,
    supersededBy: null,
    metadata: null,
    associations: {},
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
    lastAccessedAt: new Date("2026-01-01"),
    accessCount: 5,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// isInstructionsBundleEnabled()
// ---------------------------------------------------------------------------

describe("isInstructionsBundleEnabled", () => {
  const originalEnv = process.env[INSTRUCTIONS_BUNDLE_ENV_VAR];

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env[INSTRUCTIONS_BUNDLE_ENV_VAR];
    } else {
      process.env[INSTRUCTIONS_BUNDLE_ENV_VAR] = originalEnv;
    }
  });

  test("returns false when env var is unset", () => {
    delete process.env[INSTRUCTIONS_BUNDLE_ENV_VAR];
    expect(isInstructionsBundleEnabled()).toBe(false);
  });

  test('returns true when env var is "1"', () => {
    process.env[INSTRUCTIONS_BUNDLE_ENV_VAR] = "1";
    expect(isInstructionsBundleEnabled()).toBe(true);
  });

  test('returns true when env var is "true"', () => {
    process.env[INSTRUCTIONS_BUNDLE_ENV_VAR] = "true";
    expect(isInstructionsBundleEnabled()).toBe(true);
  });

  test('returns false when env var is "0"', () => {
    process.env[INSTRUCTIONS_BUNDLE_ENV_VAR] = "0";
    expect(isInstructionsBundleEnabled()).toBe(false);
  });

  test('returns false when env var is "false"', () => {
    process.env[INSTRUCTIONS_BUNDLE_ENV_VAR] = "false";
    expect(isInstructionsBundleEnabled()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildBundleText()
// ---------------------------------------------------------------------------

describe("buildBundleText", () => {
  test("returns empty string for empty records array", () => {
    expect(buildBundleText([])).toBe("");
  });

  test("wraps output in memory-bundle tags", () => {
    const records = [makeRecord()];
    const result = buildBundleText(records);
    expect(result).toContain('<memory-bundle count="1" source="minsky-db">');
    expect(result).toContain("</memory-bundle>");
  });

  test("includes memory name and type in output", () => {
    const record = makeRecord({ name: "My feedback entry", type: "feedback", scope: "user" });
    const result = buildBundleText([record]);
    expect(result).toContain("[feedback/user] My feedback entry");
  });

  test("includes memory description in output", () => {
    const record = makeRecord({ description: "Specific description text" });
    const result = buildBundleText([record]);
    expect(result).toContain("Specific description text");
  });

  test("includes memory content snippet in output", () => {
    const record = makeRecord({ content: "Important content here" });
    const result = buildBundleText([record]);
    expect(result).toContain("Important content here");
  });

  test("respects total character budget — output stays under MAX_BUNDLE_CHARS", () => {
    // Generate many large records to hit the budget cap
    const records = Array.from({ length: 50 }, (_, i) =>
      makeRecord({
        id: `id-${i}`,
        name: `Memory ${i}`,
        content: "x".repeat(1000),
      })
    );
    const result = buildBundleText(records);
    // 14000 chars + some tolerance for the enclosing tags
    expect(result.length).toBeLessThanOrEqual(14_500);
  });

  test("count attribute reflects actual number of included records", () => {
    const records = [makeRecord({ id: "a" }), makeRecord({ id: "b" }), makeRecord({ id: "c" })];
    const result = buildBundleText(records);
    expect(result).toContain('count="3"');
  });
});

// ---------------------------------------------------------------------------
// composeMemoryBundle()
// ---------------------------------------------------------------------------

describe("composeMemoryBundle", () => {
  const originalEnv = process.env[INSTRUCTIONS_BUNDLE_ENV_VAR];

  beforeEach(() => {
    process.env[INSTRUCTIONS_BUNDLE_ENV_VAR] = "1";
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env[INSTRUCTIONS_BUNDLE_ENV_VAR];
    } else {
      process.env[INSTRUCTIONS_BUNDLE_ENV_VAR] = originalEnv;
    }
  });

  test("returns null when env-var opt-in is not set", async () => {
    process.env[INSTRUCTIONS_BUNDLE_ENV_VAR] = "0";
    const mockService = {
      list: () => Promise.resolve([]),
      search: () => Promise.resolve({ results: [], backend: "none" as const, degraded: true }),
      get: () => Promise.resolve(null),
      create: () => Promise.reject(new Error("not implemented")),
      update: () => Promise.resolve(null),
      delete: () => Promise.resolve(),
      similar: () => Promise.resolve([]),
      supersede: () => Promise.reject(new Error("not implemented")),
      lineage: () => Promise.resolve({ chain: [], truncated: false }),
    };
    const result = await composeMemoryBundle(mockService);
    expect(result).toBeNull();
  });

  test("returns null when no memories are found", async () => {
    const mockService = {
      list: () => Promise.resolve([]),
      search: () => Promise.resolve({ results: [], backend: "none" as const, degraded: true }),
      get: () => Promise.resolve(null),
      create: () => Promise.reject(new Error("not implemented")),
      update: () => Promise.resolve(null),
      delete: () => Promise.resolve(),
      similar: () => Promise.resolve([]),
      supersede: () => Promise.reject(new Error("not implemented")),
      lineage: () => Promise.resolve({ chain: [], truncated: false }),
    };
    const result = await composeMemoryBundle(mockService);
    expect(result).toBeNull();
  });

  test("returns bundle text when memories are found", async () => {
    const feedbackMemory = makeRecord({ id: "1", name: "Feedback A", accessCount: 10 });
    const userMemory = makeRecord({ id: "2", name: "User pref B", type: "user", accessCount: 5 });
    const mockService = {
      list: (filter?: { type?: string }) => {
        if (filter?.type === "feedback") return Promise.resolve([feedbackMemory]);
        if (filter?.type === "user") return Promise.resolve([userMemory]);
        return Promise.resolve([]);
      },
      search: () => Promise.resolve({ results: [], backend: "none" as const, degraded: true }),
      get: () => Promise.resolve(null),
      create: () => Promise.reject(new Error("not implemented")),
      update: () => Promise.resolve(null),
      delete: () => Promise.resolve(),
      similar: () => Promise.resolve([]),
      supersede: () => Promise.reject(new Error("not implemented")),
      lineage: () => Promise.resolve({ chain: [], truncated: false }),
    };
    const result = await composeMemoryBundle(mockService);
    expect(result).not.toBeNull();
    expect(result).toContain("Feedback A");
    expect(result).toContain("User pref B");
  });

  test("sorts memories by accessCount DESC", async () => {
    const memories = [
      makeRecord({ id: "low", name: "Low Access", type: "feedback", accessCount: 1 }),
      makeRecord({ id: "high", name: "High Access", type: "feedback", accessCount: 100 }),
    ];
    const mockService = {
      list: (filter?: { type?: string }) => {
        if (filter?.type === "feedback") return Promise.resolve(memories);
        return Promise.resolve([]);
      },
      search: () => Promise.resolve({ results: [], backend: "none" as const, degraded: true }),
      get: () => Promise.resolve(null),
      create: () => Promise.reject(new Error("not implemented")),
      update: () => Promise.resolve(null),
      delete: () => Promise.resolve(),
      similar: () => Promise.resolve([]),
      supersede: () => Promise.reject(new Error("not implemented")),
      lineage: () => Promise.resolve({ chain: [], truncated: false }),
    };
    const result = await composeMemoryBundle(mockService);
    expect(result).not.toBeNull();
    // High Access should appear before Low Access
    const bundleText = result ?? "";
    const highIdx = bundleText.indexOf("High Access");
    const lowIdx = bundleText.indexOf("Low Access");
    expect(highIdx).toBeLessThan(lowIdx);
  });

  test("returns null (not throws) when list() rejects", async () => {
    const mockService = {
      list: () => Promise.reject(new Error("DB connection failed")),
      search: () => Promise.resolve({ results: [], backend: "none" as const, degraded: true }),
      get: () => Promise.resolve(null),
      create: () => Promise.reject(new Error("not implemented")),
      update: () => Promise.resolve(null),
      delete: () => Promise.resolve(),
      similar: () => Promise.resolve([]),
      supersede: () => Promise.reject(new Error("not implemented")),
      lineage: () => Promise.resolve({ chain: [], truncated: false }),
    };
    const result = await composeMemoryBundle(mockService);
    expect(result).toBeNull();
  });

  test("respects top-K limit", async () => {
    const manyMemories = Array.from({ length: 50 }, (_, i) =>
      makeRecord({ id: `id-${i}`, name: `Memory ${i}`, type: "feedback", accessCount: 50 - i })
    );
    const mockService = {
      list: (filter?: { type?: string }) => {
        if (filter?.type === "feedback") return Promise.resolve(manyMemories);
        return Promise.resolve([]);
      },
      search: () => Promise.resolve({ results: [], backend: "none" as const, degraded: true }),
      get: () => Promise.resolve(null),
      create: () => Promise.reject(new Error("not implemented")),
      update: () => Promise.resolve(null),
      delete: () => Promise.resolve(),
      similar: () => Promise.resolve([]),
      supersede: () => Promise.reject(new Error("not implemented")),
      lineage: () => Promise.resolve({ chain: [], truncated: false }),
    };
    const result = await composeMemoryBundle(mockService, 5);
    expect(result).not.toBeNull();
    // Should include Memory 0 (accessCount=50) but not Memory 10 (accessCount=40)
    expect(result).toContain("Memory 0");
    expect(result).not.toContain("Memory 10");
  });
});
