/**
 * Test to PROVE that PostgresVectorStorage generates proper SQL with WHERE clauses
 * for server-side filtering (without requiring real database connection)
 */

import { describe, test, expect, beforeEach, mock } from "bun:test";

describe("SQL Generation Proof for Server-Side Filtering", () => {
  let capturedQueries: Array<{ query: string; params: any[] }> = [];
  let mockSql: any;

  beforeEach(() => {
    capturedQueries = [];

    // Mock postgres SQL interface - only captures queries without executing
    mockSql = {
      unsafe: mock((query: string, params: any[] = []) => {
        capturedQueries.push({ query, params });
        // Return mock data that looks like postgres results
        return Promise.resolve([
          { id: "mt#001", score: 0.1 },
          { id: "mt#002", score: 0.2 },
        ]);
      }),
    };
  });

  test("generates WHERE clause for single filter", async () => {
    // Import and create a PostgresVectorStorage instance with mock SQL
    const { PostgresVectorStorage } = await import(
      "../../../../src/domain/storage/vector/postgres-vector-storage"
    );

    // Manually set internal properties to avoid constructor database connection
    const storage = Object.create(PostgresVectorStorage.prototype);
    storage.sql = mockSql;
    storage.config = {
      tableName: "tasks_embeddings",
      idColumn: "task_id",
      embeddingColumn: "vector",
    };

    // Execute search with filters
    const queryVector = [0.1, 0.2, 0.3];
    await storage.search(queryVector, { limit: 5, filters: { status: "TODO" } });

    // PROOF: Verify SQL generation
    expect(capturedQueries).toHaveLength(1);
    const { query, params } = capturedQueries[0];

    // PROOF 1: WHERE clause is generated
    expect(query).toContain("WHERE");
    expect(query).toContain("status = $3");

    // PROOF 2: Parameters are properly bound
    expect(params[0]).toBe("[0.1,0.2,0.3]"); // vector
    expect(params[1]).toBe(5); // limit
    expect(params[2]).toBe("TODO"); // status filter

    // PROOF 3: Filter happens before ORDER BY (server-side)
    const whereIndex = query.indexOf("WHERE");
    const orderIndex = query.indexOf("ORDER BY");
    expect(whereIndex).toBeLessThan(orderIndex);
  });

  test("generates WHERE clause with multiple filters", async () => {
    const { PostgresVectorStorage } = await import(
      "../../../../src/domain/storage/vector/postgres-vector-storage"
    );

    const storage = Object.create(PostgresVectorStorage.prototype);
    storage.sql = mockSql;
    storage.config = {
      tableName: "tasks_embeddings",
      idColumn: "task_id",
      embeddingColumn: "vector",
    };

    const queryVector = [0.1, 0.2, 0.3];
    await storage.search(queryVector, {
      limit: 10,
      filters: { status: "TODO", backend: "minsky" },
    });

    expect(capturedQueries).toHaveLength(1);
    const { query, params } = capturedQueries[0];

    // PROOF: Multiple conditions with AND
    expect(query).toContain("WHERE");
    expect(query).toContain("status = $3");
    expect(query).toContain("backend = $4");
    expect(query).toContain("AND");

    // PROOF: All filter values parameterized
    expect(params).toEqual([
      "[0.1,0.2,0.3]", // vector
      10, // limit
      "TODO", // status
      "minsky", // backend
    ]);
  });

  test("skips WHERE clause when no filters provided", async () => {
    const { PostgresVectorStorage } = await import(
      "../../../../src/domain/storage/vector/postgres-vector-storage"
    );

    const storage = Object.create(PostgresVectorStorage.prototype);
    storage.sql = mockSql;
    storage.config = {
      tableName: "tasks_embeddings",
      idColumn: "task_id",
      embeddingColumn: "vector",
    };

    const queryVector = [0.1, 0.2, 0.3];
    await storage.search(queryVector, { limit: 10 });

    expect(capturedQueries).toHaveLength(1);
    const { query, params } = capturedQueries[0];

    // PROOF: No WHERE clause without filters
    expect(query).not.toContain("WHERE");
    expect(params).toEqual([
      "[0.1,0.2,0.3]", // vector only
      10, // limit only
    ]);
  });

  test("ignores null/undefined filter values", async () => {
    const { PostgresVectorStorage } = await import(
      "../../../../src/domain/storage/vector/postgres-vector-storage"
    );

    const storage = Object.create(PostgresVectorStorage.prototype);
    storage.sql = mockSql;
    storage.config = {
      tableName: "tasks_embeddings",
      idColumn: "task_id",
      embeddingColumn: "vector",
    };

    const queryVector = [0.1, 0.2, 0.3];
    await storage.search(queryVector, {
      limit: 10,
      filters: {
        status: "TODO",
        backend: null, // should be ignored
        other: undefined, // should be ignored
      },
    });

    expect(capturedQueries).toHaveLength(1);
    const { query, params } = capturedQueries[0];

    // PROOF: Only non-null filters create conditions
    expect(query).toContain("WHERE");
    expect(query).toContain("status = $3");
    expect(query).not.toContain("backend");
    expect(query).not.toContain("other");

    expect(params).toEqual([
      "[0.1,0.2,0.3]", // vector
      10, // limit
      "TODO", // only status (backend/other ignored)
    ]);
  });

  test("PERFORMANCE PROOF: proves database-level filtering", async () => {
    const { PostgresVectorStorage } = await import(
      "../../../../src/domain/storage/vector/postgres-vector-storage"
    );

    const storage = Object.create(PostgresVectorStorage.prototype);
    storage.sql = mockSql;
    storage.config = {
      tableName: "tasks_embeddings",
      idColumn: "task_id",
      embeddingColumn: "vector",
    };

    const queryVector = [0.1, 0.2, 0.3];
    await storage.search(queryVector, {
      limit: 100,
      filters: { status: "TODO" },
    });

    expect(capturedQueries).toHaveLength(1);
    const { query } = capturedQueries[0];

    // PERFORMANCE PROOF: Single query with embedded filter
    // No separate filtering step in application code
    // Database does both similarity search AND filtering in one operation
    expect(query).toMatch(/SELECT.*FROM tasks_embeddings.*WHERE.*status = \$3.*ORDER BY.*LIMIT/s);

    // PROOF: Query contains all operations in correct order:
    // 1. SELECT with similarity distance
    // 2. FROM table
    // 3. WHERE with filters (server-side)
    // 4. ORDER BY similarity score
    // 5. LIMIT results
    const queryParts = query.replace(/\s+/g, " ").trim();
    expect(queryParts).toContain("SELECT");
    expect(queryParts).toContain("FROM tasks_embeddings");
    expect(queryParts).toContain("WHERE status = $3");
    expect(queryParts).toContain("ORDER BY");
    expect(queryParts).toContain("LIMIT");
  });
});
