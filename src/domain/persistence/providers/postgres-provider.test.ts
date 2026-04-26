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

// Mock SQL client — injected via initialize({ sqlClient: mockSql })
// This path bypasses the postgres() factory call entirely.
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

/**
 * Build a mock postgres factory that captures the call arguments and returns a
 * minimal sql client compatible with drizzle + withPgPoolRetry. Injected via
 * initialize({ postgresFactory }) to test the production factory call path without
 * using mock.module() (which is banned by the no-global-module-mocks ESLint rule).
 */
function makeMockPostgresFactory(): {
  factory: (connStr: string, opts: Record<string, unknown>) => unknown;
  getCapturedArgs: () => [string, Record<string, unknown>] | null;
} {
  let capturedArgs: [string, Record<string, unknown>] | null = null;

  const factory = mock((connStr: string, opts: Record<string, unknown>) => {
    capturedArgs = [connStr, opts];
    const sqlFn = mock(() => Promise.resolve([]));
    return Object.assign(sqlFn, {
      options: { parsers: {}, serializers: {} },
      query: mock(() => Promise.resolve([])),
      end: mock(() => Promise.resolve()),
    });
  });

  return {
    factory: factory as unknown as (connStr: string, opts: Record<string, unknown>) => unknown,
    getCapturedArgs: () => capturedArgs,
  };
}

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
    // This test exercises the postgres() factory call path via the postgresFactory
    // DI hook on initialize(). The factory mock captures call arguments so we can
    // assert connect_timeout: 15 is passed directly (no unit conversion).
    const { factory: pgFactory, getCapturedArgs } = makeMockPostgresFactory();
    const configWith15: PersistenceConfig = {
      backend: "postgres",
      postgres: {
        connectionString: TEST_CONNECTION_STRING,
        connectTimeout: 15,
        idleTimeout: 60,
      },
    };
    const p = new PostgresPersistenceProvider(configWith15);

    await p.initialize({ postgresFactory: pgFactory as any });

    const capturedArgs = getCapturedArgs();
    expect(capturedArgs).not.toBeNull();
    if (capturedArgs) {
      const [connStr, opts] = capturedArgs;
      expect(connStr).toBe(TEST_CONNECTION_STRING);
      expect(opts.connect_timeout).toBe(15);
      expect(opts.idle_timeout).toBe(60);
    }
    expect((p as unknown as { isInitialized: boolean }).isInitialized).toBe(true);
  });

  // mt#1201 NON-BLOCKING: idleTimeout validation and pass-through tests
  test("idleTimeout schema value of 15 (seconds) passes validation", () => {
    const result = persistenceConfigSchema.safeParse({
      backend: "postgres",
      postgres: {
        connectionString: TEST_CONNECTION_STRING,
        idleTimeout: 15,
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.postgres?.idleTimeout).toBe(15);
    }
  });

  test("idleTimeout schema value of 600000 (old ms upper bound) fails validation under new second-scale bounds", () => {
    const result = persistenceConfigSchema.safeParse({
      backend: "postgres",
      postgres: {
        connectionString: TEST_CONNECTION_STRING,
        idleTimeout: 600000,
      },
    });
    expect(result.success).toBe(false);
  });

  test("idleTimeout: 30 (seconds) is passed as idle_timeout: 30 to postgres-js client args", async () => {
    // This test exercises the postgres() factory call path via the postgresFactory
    // DI hook on initialize(). Assert that idleTimeout: 30 is forwarded as
    // idle_timeout: 30 without unit conversion.
    const { factory: pgFactory, getCapturedArgs } = makeMockPostgresFactory();
    const configWith30: PersistenceConfig = {
      backend: "postgres",
      postgres: {
        connectionString: TEST_CONNECTION_STRING,
        connectTimeout: 10,
        idleTimeout: 30,
      },
    };
    const p = new PostgresPersistenceProvider(configWith30);

    await p.initialize({ postgresFactory: pgFactory as any });

    const capturedArgs = getCapturedArgs();
    expect(capturedArgs).not.toBeNull();
    if (capturedArgs) {
      const [, opts] = capturedArgs;
      expect(opts.idle_timeout).toBe(30);
      expect(opts.connect_timeout).toBe(10);
    }
    expect((p as unknown as { isInitialized: boolean }).isInitialized).toBe(true);
  });
});
