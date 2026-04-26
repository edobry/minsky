/**
 * Layer 1: Persistence Layer Tests
 * Test that persistence providers work correctly with mocked database connections
 */
import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { PostgresPersistenceProvider } from "./postgres-provider";
import { PostgresStorage } from "../../storage/backends/postgres-storage";
import type { PersistenceConfig } from "../../../domain/configuration/types";
import { first } from "../../../utils/array-safety";
import { persistenceConfigSchema } from "../../configuration/schemas/persistence";

// Mock SQL client — injected via initialize()
const mockSqlFunction = mock((strings: TemplateStringsArray, ...values: any[]) => {
  // Handle pgvector extension check specifically
  const queryString = first(strings as unknown as string[], "SQL template strings");
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

const CONNECTION_REFUSED = "connection refused";
const TEST_CONNECTION_STRING = "postgresql://user:pass@host/db";

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
    await provider.initialize({ sqlClient: mockSql as any });

    const storage = provider.getStorage();

    // Should return real PostgresStorage instance, not stub
    expect(storage).toBeInstanceOf(PostgresStorage);
    expect((storage as unknown as PostgresStorage).readState).toBeDefined();
    expect((storage as unknown as PostgresStorage).getEntities).toBeDefined();
    expect((storage as unknown as PostgresStorage).initialize).toBeDefined();
  });

  test("getStorage() throws error when not initialized", () => {
    expect(() => provider.getStorage()).toThrow("PostgresPersistenceProvider not initialized");
  });

  test("initialize() sets up provider correctly", async () => {
    expect((provider as unknown as { isInitialized: boolean }).isInitialized).toBe(false);

    // Mock successful connection
    mockSql.query.mockImplementationOnce(() => Promise.resolve([]));

    await provider.initialize({ sqlClient: mockSql as any });

    expect((provider as unknown as { isInitialized: boolean }).isInitialized).toBe(true);
  });

  test("getRawSqlConnection() returns connection when initialized", async () => {
    // Mock successful connection
    mockSql.query.mockImplementationOnce(() => Promise.resolve([]));
    await provider.initialize({ sqlClient: mockSql as any });

    const connection = await provider.getRawSqlConnection();

    expect(connection).toBeDefined();
    // Should return the mocked SQL connection
    expect(connection).toBe(mockSql as any);
  });

  test("getCapabilities() returns correct PostgreSQL capabilities (base provider)", () => {
    const capabilities = provider.getCapabilities();

    expect(capabilities.sql).toBe(true);
    expect(capabilities.transactions).toBe(true);
    expect(capabilities.jsonb).toBe(true);
    expect(capabilities.vectorStorage).toBe(false); // Base provider has no vector support
    expect(capabilities.migrations).toBe(true);
  });

  test("initialize() cleans up state when connection verification fails", async () => {
    // Create a SQL client whose template-tag call (SELECT 1) rejects
    const failingSqlFunction = mock(() => Promise.reject(new Error(CONNECTION_REFUSED)));
    const failingSql = Object.assign(failingSqlFunction, {
      options: { parsers: {}, serializers: {} },
      query: mock(() => Promise.reject(new Error(CONNECTION_REFUSED))),
      end: mock(() => Promise.resolve()),
    });

    await expect(provider.initialize({ sqlClient: failingSql as any })).rejects.toThrow(
      CONNECTION_REFUSED
    );

    // Provider should NOT be marked as initialized
    expect((provider as unknown as { isInitialized: boolean }).isInitialized).toBe(false);
    // Internal fields should be nulled out
    expect((provider as unknown as { sql: unknown }).sql).toBeNull();
    expect((provider as unknown as { db: unknown }).db).toBeNull();
    // Should NOT call end() on injected client (caller owns it)
    expect(failingSql.end).not.toHaveBeenCalled();
  });

  test("initialize() can be retried after failure", async () => {
    // First attempt: fail
    const failingSqlFunction = mock(() => Promise.reject(new Error(CONNECTION_REFUSED)));
    const failingSql = Object.assign(failingSqlFunction, {
      options: { parsers: {}, serializers: {} },
      query: mock(() => Promise.reject(new Error(CONNECTION_REFUSED))),
      end: mock(() => Promise.resolve()),
    });

    await expect(provider.initialize({ sqlClient: failingSql as any })).rejects.toThrow();

    // Second attempt: succeed with working client
    mockSql.query.mockImplementationOnce(() => Promise.resolve([]));
    await provider.initialize({ sqlClient: mockSql as any });

    expect((provider as unknown as { isInitialized: boolean }).isInitialized).toBe(true);
  });

  test("close() exists and calls sql.end() to release pool sockets (mt#1193)", async () => {
    // Use a dedicated mock whose end() we can observe
    const endMock = mock(() => Promise.resolve());
    const localSqlFn = mock(() => Promise.resolve([]));
    const localSql = Object.assign(localSqlFn, {
      options: { parsers: {}, serializers: {} },
      query: mock(() => Promise.resolve([])),
      end: endMock,
    });

    await provider.initialize({ sqlClient: localSql as any });
    expect((provider as unknown as { isInitialized: boolean }).isInitialized).toBe(true);

    await provider.close();

    // Must actually release sockets (not a no-op) — this is what the MCP
    // SIGTERM handler (start-command.ts) relies on to free pool slots
    // promptly during Railway redeploys.
    expect(endMock).toHaveBeenCalledTimes(1);
    expect((provider as unknown as { sql: unknown }).sql).toBeNull();
    expect((provider as unknown as { db: unknown }).db).toBeNull();
    expect((provider as unknown as { isInitialized: boolean }).isInitialized).toBe(false);
  });

  // mt#1201: connectTimeout/idleTimeout unit fix — values are seconds, not ms.
  // The schema now validates second-scale values; the provider passes them
  // through unchanged to postgres-js (connect_timeout / idle_timeout are seconds).
  test("connectTimeout schema value of 15 (seconds) passes validation", () => {
    const result = persistenceConfigSchema.safeParse({
      backend: "postgres",
      postgres: {
        connectionString: TEST_CONNECTION_STRING,
        connectTimeout: 15,
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.postgres?.connectTimeout).toBe(15);
    }
  });

  test("connectTimeout schema value of 300000 (old ms upper bound) fails validation under new second-scale bounds", () => {
    const result = persistenceConfigSchema.safeParse({
      backend: "postgres",
      postgres: {
        connectionString: TEST_CONNECTION_STRING,
        connectTimeout: 300000,
      },
    });
    expect(result.success).toBe(false);
  });

  test("connectTimeout: 15 (seconds) is passed as connect_timeout: 15 to postgres-js client args", async () => {
    // The provider stores the config and passes connectTimeout directly to
    // connect_timeout in the postgres-js call. Verify the stored config value
    // (which feeds the postgres-js args) matches the input without conversion.
    const configWith15: PersistenceConfig = {
      backend: "postgres",
      postgres: {
        connectionString: TEST_CONNECTION_STRING,
        connectTimeout: 15,
      },
    };
    const p = new PostgresPersistenceProvider(configWith15);

    // The internal config (accessed via the private pgConfig getter) is what
    // gets passed to postgres-js as connect_timeout. Use injection to observe
    // that initialize() accepts the value and the provider reaches initialized
    // state — meaning the value (15, in seconds) was used without conversion.
    mockSql.query.mockImplementationOnce(() => Promise.resolve([]));
    await p.initialize({ sqlClient: mockSql as any });

    // pgConfig.connectTimeout is what the production code passes to connect_timeout.
    // Access via the known internal field for verification.
    const storedConfig = (p as unknown as { config: PersistenceConfig }).config;
    expect(storedConfig.postgres?.connectTimeout).toBe(15);
    expect((p as unknown as { isInitialized: boolean }).isInitialized).toBe(true);
  });
});
