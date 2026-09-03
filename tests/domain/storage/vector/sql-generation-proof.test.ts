/**
 * Proof that `PostgresVectorStorage` filters SERVER-SIDE — one query, with the
 * predicate in SQL — rather than over-fetching and filtering in application
 * code. No database connection required.
 *
 * ## Updated for mt#4937
 *
 * This file previously asserted the hand-built `$N` string the storage layer
 * produced for a filtered search (`status = $3`, positional params
 * `[vector, limit, "TODO"]`). mt#4937 moved filtered searches onto a drizzle
 * transaction so they can issue `SET LOCAL hnsw.iterative_scan = strict_order`
 * — pgvector post-filters an HNSW scan, so without it a selective filter
 * silently returns fewer rows than the LIMIT asked for.
 *
 * The property this file exists to defend is UNCHANGED and still worth
 * defending: the filter reaches the database, in the same statement as the
 * similarity search, ahead of ORDER BY. What changed is the mechanism carrying
 * it, so the assertions now read drizzle's rendered SQL instead of a
 * `sql.unsafe` string. The UNFILTERED case still asserts the raw `$1`/`$2`
 * form, because that path is deliberately untouched.
 *
 * Sibling coverage: `packages/domain/src/storage/vector/postgres-vector-storage.test.ts`
 * owns the dispatch and predicate-construction detail (including that SET LOCAL
 * precedes the query). This file stays focused on the server-side-filtering
 * claim its name makes.
 */

import { describe, test, expect, beforeEach, mock } from "bun:test";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { first } from "../../../../src/utils/array-safety";

// Test constants to avoid magic string duplication
const POSTGRES_VEC_MODULE_PATH = "@minsky/domain/storage/vector/postgres-vector-storage";
const TASKS_EMBEDDINGS_TABLE = "tasks_embeddings";

const dialect = new PgDialect();

interface Captured {
  query: string;
  params: unknown[];
}

describe("SQL Generation Proof for Server-Side Filtering", () => {
  /** Statements sent through the raw `sql.unsafe` path (unfiltered searches). */
  let capturedQueries: Captured[] = [];
  /** Statements sent through the drizzle transaction (filtered searches). */
  let capturedTxStatements: Captured[] = [];
  /** Hand-built test double for a postgres-js client (unfiltered path). */
  let mockSql: { unsafe: (query: string, params?: unknown[]) => Promise<unknown> };
  /** Hand-built test double for a drizzle client (filtered path). */
  let mockDb: { transaction: (run: (tx: unknown) => Promise<unknown>) => Promise<unknown> };

  beforeEach(() => {
    capturedQueries = [];
    capturedTxStatements = [];

    // Mock postgres SQL interface - only captures queries without executing
    mockSql = {
      unsafe: mock((query: string, params: unknown[] = []) => {
        capturedQueries.push({ query, params });
        // Return mock data that looks like postgres results
        return Promise.resolve([
          { id: "mt#001", score: 0.1 },
          { id: "mt#002", score: 0.2 },
        ]);
      }),
    };

    // Mock drizzle client. mt#4937 routes a FILTERED search through
    // `db.transaction` so it can scope `SET LOCAL` to the same connection as
    // the query; this captures the rendered SQL of each statement it issues.
    mockDb = {
      transaction: async (run: (tx: unknown) => Promise<unknown>) => {
        const tx = {
          execute: (fragment: SQL) => {
            const rendered = dialect.sqlToQuery(fragment);
            capturedTxStatements.push({ query: rendered.sql, params: rendered.params });
            return Promise.resolve([
              { id: "mt#001", score: 0.1 },
              { id: "mt#002", score: 0.2 },
            ]);
          },
        };
        return run(tx);
      },
    };
  });

  /**
   * Build a storage instance without running the constructor, so no database
   * connection is attempted. `db` is now required alongside `sql` — a filtered
   * search reaches for it.
   */
  async function makeStorage() {
    const { PostgresVectorStorage } = await import(POSTGRES_VEC_MODULE_PATH);
    const storage = Object.create(PostgresVectorStorage.prototype);
    storage.sql = mockSql;
    storage.db = mockDb;
    storage.config = {
      tableName: TASKS_EMBEDDINGS_TABLE,
      idColumn: "task_id",
      embeddingColumn: "vector",
    };
    return storage;
  }

  /** The filtered search's actual query — the statement after `SET LOCAL`. */
  function filteredQuery(): Captured {
    expect(capturedTxStatements).toHaveLength(2);
    const setLocal = first(capturedTxStatements);
    expect(setLocal.query).toBe("SET LOCAL hnsw.iterative_scan = strict_order");
    const query = capturedTxStatements[1];
    if (query === undefined) throw new Error("expected a query statement after SET LOCAL");
    return query;
  }

  test("generates WHERE clause for single filter", async () => {
    const storage = await makeStorage();

    const queryVector = [0.1, 0.2, 0.3];
    await storage.search(queryVector, { limit: 5, filters: { status: "TODO" } });

    // PROOF: the filtered search does NOT fall back to the raw path.
    expect(capturedQueries).toHaveLength(0);

    const { query, params } = filteredQuery();

    // PROOF 1: WHERE clause is generated, naming the column
    expect(query).toContain("WHERE");
    expect(query).toContain("status =");

    // PROOF 2: every value is BOUND, never inlined as a literal
    expect(params).toEqual(["[0.1,0.2,0.3]", "TODO", "[0.1,0.2,0.3]", 5]);
    expect(query).not.toContain("TODO");

    // PROOF 3: Filter happens before ORDER BY (server-side)
    const whereIndex = query.indexOf("WHERE");
    const orderIndex = query.indexOf("ORDER BY");
    expect(whereIndex).toBeGreaterThan(-1);
    expect(whereIndex).toBeLessThan(orderIndex);
  });

  test("generates WHERE clause with multiple filters", async () => {
    const storage = await makeStorage();

    const queryVector = [0.1, 0.2, 0.3];
    await storage.search(queryVector, {
      limit: 10,
      filters: { status: "TODO", backend: "minsky" },
    });

    const { query, params } = filteredQuery();

    // PROOF: Multiple conditions joined with AND
    expect(query).toContain("WHERE");
    expect(query).toContain("status =");
    expect(query).toContain("backend =");
    expect(query).toContain("AND");

    // PROOF: All filter values parameterized, in order
    expect(params).toEqual([
      "[0.1,0.2,0.3]", // vector, in the SELECT distance expression
      "TODO", // status
      "minsky", // backend
      "[0.1,0.2,0.3]", // vector again, in ORDER BY
      10, // limit
    ]);
  });

  test("skips WHERE clause when no filters provided", async () => {
    const storage = await makeStorage();

    const queryVector = [0.1, 0.2, 0.3];
    await storage.search(queryVector, { limit: 10 });

    // PROOF: the unfiltered path is unchanged by mt#4937 — still the raw
    // `sql.unsafe` form, and it opens no transaction.
    expect(capturedTxStatements).toHaveLength(0);
    expect(capturedQueries).toHaveLength(1);
    const { query, params } = first(capturedQueries);

    // PROOF: No WHERE clause without filters
    expect(query).not.toContain("WHERE");
    expect(params).toEqual([
      "[0.1,0.2,0.3]", // vector only
      10, // limit only
    ]);
  });

  test("ignores null/undefined filter values", async () => {
    const storage = await makeStorage();

    const queryVector = [0.1, 0.2, 0.3];
    await storage.search(queryVector, {
      limit: 10,
      filters: {
        status: "TODO",
        backend: null, // should be ignored
        other: undefined, // should be ignored
      },
    });

    const { query, params } = filteredQuery();

    // PROOF: Only non-null filters create conditions
    expect(query).toContain("WHERE");
    expect(query).toContain("status =");
    expect(query).not.toContain("backend");
    expect(query).not.toContain("other");

    expect(params).toEqual([
      "[0.1,0.2,0.3]", // vector
      "TODO", // only status (backend/other ignored)
      "[0.1,0.2,0.3]", // vector again, in ORDER BY
      10, // limit
    ]);
  });

  test("PERFORMANCE PROOF: proves database-level filtering", async () => {
    const storage = await makeStorage();

    const queryVector = [0.1, 0.2, 0.3];
    await storage.search(queryVector, {
      limit: 100,
      filters: { status: "TODO" },
    });

    const { query } = filteredQuery();

    // PERFORMANCE PROOF: a SINGLE query carries both the similarity search and
    // the filter. No separate filtering step in application code — the database
    // does both in one operation. (mt#4937 note: `TaskSimilarityService` DOES
    // post-filter above this layer per ADR-013, deliberately and for a
    // different reason — a mutable denormalized column. That is a decision one
    // level up; this layer's own contract is still server-side filtering.)
    expect(query).toMatch(/SELECT.*FROM tasks_embeddings.*WHERE.*status =.*ORDER BY.*LIMIT/s);

    // PROOF: Query contains all operations in correct order:
    // 1. SELECT with similarity distance
    // 2. FROM table
    // 3. WHERE with filters (server-side)
    // 4. ORDER BY similarity score
    // 5. LIMIT results
    const queryParts = query.replace(/\s+/g, " ").trim();
    expect(queryParts).toContain("SELECT");
    expect(queryParts).toContain("FROM tasks_embeddings");
    expect(queryParts).toContain("WHERE status =");
    expect(queryParts).toContain("ORDER BY");
    expect(queryParts).toContain("LIMIT");
  });
});
