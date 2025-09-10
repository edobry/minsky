/**
 * Layer 1: Persistence Layer Tests
 * Test that persistence providers work correctly with mocked database connections
 */
import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { PostgresPersistenceProvider } from "./postgres-provider";
import { PostgresStorage } from "../../storage/backends/postgres-storage";
import type { PersistenceConfig } from "../../../domain/configuration/types";

// Mock the postgres module to avoid real database connections
const mockSqlFunction = mock((strings: TemplateStringsArray, ...values: any[]) => {
  // Handle pgvector extension check specifically
  const queryString = strings[0];
  if (queryString.includes("pg_extension") && queryString.includes("vector")) {
    return Promise.resolve([{ exists: true }]); // Mock pgvector as available
  }
  return Promise.resolve([]);
});
const mockSql = Object.assign(mockSqlFunction, {
  options: {
    parsers: {},
    serializers: {}, // Drizzle needs both parsers and serializers
  },
  query: mock(() => Promise.resolve([])),
  end: mock(() => Promise.resolve()),
});

mock.module("postgres", () => ({
  default: mock(() => mockSql),
}));

describe("PostgresPersistenceProvider", () => {
  let provider: PostgresPersistenceProvider;
  let mockConfig: PersistenceConfig;

  beforeEach(() => {
    mockConfig = {
      backend: "postgres",
      postgres: {
        connectionString: "postgresql://testuser:testpass@localhost:5432/testdb",
        maxConnections: 10,
        connectTimeout: 30,
      },
    };
    provider = new PostgresPersistenceProvider(mockConfig);
  });

  afterEach(() => {
    mock.restore();
  });

  test("getStorage() returns actual PostgresStorage instance, not stub", async () => {
    // Mock successful connection
    mockSql.query.mockImplementationOnce(() => Promise.resolve([]));
    await provider.initialize();

    const storage = provider.getStorage();

    // Should return real PostgresStorage instance, not stub
    expect(storage).toBeInstanceOf(PostgresStorage);
    expect(storage.readState).toBeDefined();
    expect(storage.getEntities).toBeDefined();
    expect(storage.initialize).toBeDefined();
  });

  test("getStorage() throws error when not initialized", () => {
    expect(() => provider.getStorage()).toThrow("PostgresPersistenceProvider not initialized");
  });

  test("initialize() sets up provider correctly", async () => {
    expect(provider.isInitialized).toBe(false);

    // Mock successful connection
    mockSql.query.mockImplementationOnce(() => Promise.resolve([]));

    await provider.initialize();

    expect(provider.isInitialized).toBe(true);
  });

  test("getRawSqlConnection() returns connection when initialized", async () => {
    // Mock successful connection
    mockSql.query.mockImplementationOnce(() => Promise.resolve([]));
    await provider.initialize();

    const connection = await provider.getRawSqlConnection();

    expect(connection).toBeDefined();
    // Should return the mocked SQL connection
    expect(connection).toBe(mockSql);
  });

  test("getCapabilities() returns correct PostgreSQL capabilities (base provider)", () => {
    const capabilities = provider.getCapabilities();

    expect(capabilities.sql).toBe(true);
    expect(capabilities.transactions).toBe(true);
    expect(capabilities.jsonb).toBe(true);
    expect(capabilities.vectorStorage).toBe(false); // Base provider has no vector support
    expect(capabilities.migrations).toBe(true);
  });
});
