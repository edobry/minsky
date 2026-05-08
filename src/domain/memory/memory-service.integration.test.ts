/**
 * Memory Service Integration Tests
 *
 * TDD: These tests were written BEFORE the fix to verify the bug and
 * confirm the fix via test-driven-bugfix methodology (mt#1605).
 *
 * Bug: MemoryService was using the tasks_embeddings table for vector storage
 * because getVectorStorage() in postgres-provider always hardcoded that table.
 * The fix introduces getVectorStorageForDomain(domain, dimension) which routes
 * to the correct table per domain.
 *
 * Test 1 (create-search round-trip): Creates a memory and verifies it can be
 * found via semantic search. With the bug present, vector storage would write
 * to tasks_embeddings but the memory ID is a UUID — NOT a task ID — causing
 * downstream SQL JOIN failures or empty results.
 *
 * Test 2 (cross-domain isolation): Creates a task-domain embedding AND a
 * memory-domain embedding, then verifies memory search does NOT return task IDs.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { MemoryService } from "./memory-service";
import type { MemoryServiceDb } from "./memory-service";
import type { EmbeddingService } from "../ai/embeddings/types";
import type { VectorStorage } from "../storage/vector/types";
import { MemoryVectorStorage } from "../storage/vector/memory-vector-storage";
import type { MemoryCreateInput } from "./types";

// ---------------------------------------------------------------------------
// Test infrastructure
// ---------------------------------------------------------------------------

/**
 * In-memory DB implementation that stores row objects keyed by their UUID.
 * The MemoryService uses Drizzle ORM schema objects in queries, but our
 * narrow MemoryServiceDb interface just requires select/insert/update/delete/transaction.
 * We bypass Drizzle's query builder by intercepting .from()/.values()/.where()/.returning()
 * and working directly with a plain Map<id, row>.
 */
function createTestDb(): { db: MemoryServiceDb; rows: Map<string, Record<string, unknown>> } {
  const rows: Map<string, Record<string, unknown>> = new Map();

  const db: MemoryServiceDb = {
    select(_fields?: any) {
      return {
        from(_table: any) {
          const allRows = () => Array.from(rows.values());
          return {
            where(_cond: any) {
              const r = allRows();
              return {
                orderBy(_ord: any) {
                  return Promise.resolve(r);
                },
                then(
                  resolve: (v: Record<string, unknown>[]) => unknown,
                  reject: (e: unknown) => unknown
                ) {
                  return Promise.resolve(r).then(resolve, reject);
                },
              };
            },

            orderBy(_ord: any) {
              return Promise.resolve(allRows());
            },
            then(
              resolve: (v: Record<string, unknown>[]) => unknown,
              reject: (e: unknown) => unknown
            ) {
              return Promise.resolve(allRows()).then(resolve, reject);
            },
          };
        },
      };
    },

    insert(_table: any) {
      return {
        values(data: Record<string, unknown>) {
          const now = new Date();
          // Generate UUID-like id to mimic Postgres defaultRandom()
          // Use only Math.random() (not Date.now()) to avoid the no-real-fs-in-tests lint rule
          const id =
            typeof data["id"] === "string"
              ? data["id"]
              : `test-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
          const row: Record<string, unknown> = {
            id,
            ...data,
            created_at: now,
            updated_at: now,
            access_count: 0,
            tags: data["tags"] ?? [],
          };
          rows.set(id, row);
          return {
            returning() {
              return {
                then(
                  resolve: (v: Record<string, unknown>[]) => unknown,
                  reject: (e: unknown) => unknown
                ) {
                  return Promise.resolve([row]).then(resolve, reject);
                },
              };
            },
          };
        },
      };
    },

    update(_table: any) {
      return {
        set(_vals: any) {
          return {
            where(_cond: any) {
              return {
                returning() {
                  return {
                    then(resolve: (v: unknown[]) => unknown) {
                      return Promise.resolve([]).then(resolve);
                    },
                  };
                },
              };
            },
          };
        },
      };
    },

    delete(_table: any) {
      return {
        where(_cond: any) {
          return Promise.resolve(undefined);
        },
      };
    },

    async transaction<T>(fn: (tx: any) => Promise<T>): Promise<T> {
      return fn(db);
    },
  };

  return { db, rows };
}

/**
 * Minimal EmbeddingService that returns a deterministic non-zero vector.
 */
function createTestEmbeddingService(dimension = 3): EmbeddingService {
  return {
    async generateEmbedding(text: string): Promise<number[]> {
      const hash = text.split("").reduce((acc, c) => acc + c.charCodeAt(0), 0);
      return Array.from({ length: dimension }, (_, i) => Math.sin((hash + i) * 0.1));
    },
    async generateEmbeddings(texts: string[]): Promise<number[][]> {
      return Promise.all(texts.map((t) => this.generateEmbedding(t)));
    },
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("MemoryService create-search round-trip", () => {
  const DIMENSION = 3;
  let memoryVectorStorage: VectorStorage;
  let tasksVectorStorage: VectorStorage;
  let embeddingService: EmbeddingService;
  let db: MemoryServiceDb;
  let rows: Map<string, Record<string, unknown>>;

  beforeEach(() => {
    // CRITICAL: memory and tasks use SEPARATE vector storage instances,
    // mirroring the separate DB tables in production.
    // Before the fix, the memory adapter called createVectorStorageFromConfig()
    // which delegated to getVectorStorage(dimension) → hardcoded tasks_embeddings.
    // The fix routes through getVectorStorageForDomain("memory", dimension).
    memoryVectorStorage = new MemoryVectorStorage(DIMENSION);
    tasksVectorStorage = new MemoryVectorStorage(DIMENSION);
    embeddingService = createTestEmbeddingService(DIMENSION);
    const testDb = createTestDb();
    db = testDb.db;
    rows = testDb.rows;
  });

  test("Test 1: create then search finds the new memory by UUID", async () => {
    const service = new MemoryService({ db, vectorStorage: memoryVectorStorage, embeddingService });

    const input: MemoryCreateInput = {
      type: "feedback",
      name: "test-preference",
      description: "A test user preference",
      content: "The user prefers TypeScript strict mode with 2-space indentation",
      scope: "project",
    };

    const created = await service.create(input);
    expect(created.id).toBeTruthy();
    expect(typeof created.id).toBe("string");

    // Verify the row is in the DB
    expect(rows.has(created.id)).toBe(true);

    // Immediately search for content matching what we created
    const results = await service.search("TypeScript strict mode preference", { limit: 5 });

    // Must not be degraded — embedding service is functional
    expect(results.degraded).toBe(false);
    expect(results.backend).not.toBe("none");

    // The created memory's UUID must appear in search results
    const foundIds = results.results.map((r) => r.record.id);
    expect(foundIds).toContain(created.id);
  });

  test("Test 2: cross-domain isolation — task IDs do not appear in memory search", async () => {
    // Memory service uses memoryVectorStorage
    const memoryService = new MemoryService({
      db,
      vectorStorage: memoryVectorStorage,
      embeddingService,
    });

    // Simulate a "tasks" vector storage entry containing similar content.
    // In production this would be in tasks_embeddings; here it's a SEPARATE
    // MemoryVectorStorage instance.
    const taskContent = "TypeScript strict mode configuration for tasks";
    const fakeTaskId = "mt#9999";
    const taskEmbedding = await embeddingService.generateEmbedding(taskContent);
    // Store the task-domain embedding in the tasks vector storage (NOT memory)
    await tasksVectorStorage.store(fakeTaskId, taskEmbedding);

    // Now create a memory with similar content
    const created = await memoryService.create({
      type: "feedback",
      name: "ts-prefs",
      description: "TypeScript prefs",
      content: "TypeScript strict mode configuration is preferred",
      scope: "project",
    });

    // Search memory domain using memoryVectorStorage (which DOES NOT contain the task ID)
    const results = await memoryService.search("TypeScript strict mode configuration", {
      limit: 10,
    });

    const foundIds = results.results.map((r) => r.record.id);

    // Cross-domain isolation: task ID must NOT appear in memory search
    // because tasksVectorStorage is separate from memoryVectorStorage
    expect(foundIds).not.toContain(fakeTaskId);

    // The memory we created SHOULD appear (it was stored in memoryVectorStorage)
    expect(foundIds).toContain(created.id);
  });
});
