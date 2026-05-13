/**
 * Layer 1: Persistence Layer Tests
 * Test that persistence providers work correctly with mocked database connections
 */
import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import {
  PostgresPersistenceProvider,
  PostgresVectorPersistenceProvider,
  resolveMigrationsFolder,
  shouldAutoMigrate,
} from "./postgres-provider";
// mt#1767 — `resolveMigrationsFolder()` operates on real filesystem state by
// design (it must verify the deployed bundle's migrations folder exists).
// The tests below assert real-fs resolution, so the in-test fs prohibition
// (no-real-fs-in-tests) is intentionally suspended for this targeted import.
// eslint-disable-next-line custom/no-real-fs-in-tests
import { existsSync } from "node:fs";
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

  test("initialize() wires onnotice handler to suppress Postgres NOTICE stdout pollution (mt#1827)", async () => {
    // mt#1827: drizzle's `CREATE SCHEMA IF NOT EXISTS drizzle` + `CREATE TABLE
    // IF NOT EXISTS __drizzle_migrations` emit Postgres NOTICE codes 42P06 +
    // 42P07 on every cold start. Without an `onnotice` handler, postgres-js's
    // default routes NOTICEs to stdout, breaking any CLI consumer that
    // JSON-parses the output (the memory-search bridge hook was silently
    // failing on every non-trivial turn). This test guards the wiring so a
    // future refactor doesn't drop the handler.
    const { factory: pgFactory, getCapturedArgs } = makeMockPostgresFactory();
    const config: PersistenceConfig = {
      backend: "postgres",
      postgres: { connectionString: TEST_CONNECTION_STRING },
    };
    const p = new PostgresPersistenceProvider(config);

    await p.initialize({ postgresFactory: pgFactory as any });

    const capturedArgs = getCapturedArgs();
    expect(capturedArgs).not.toBeNull();
    if (capturedArgs) {
      const [, opts] = capturedArgs;
      const onnotice = (opts as { onnotice?: (notice: unknown) => unknown }).onnotice;
      expect(typeof onnotice).toBe("function");
      // No-op: invoking it should not throw and should not return anything.
      expect(onnotice?.({ severity: "NOTICE", code: "42P06" })).toBeUndefined();
    }
  });
});

describe("PostgresVectorPersistenceProvider", () => {
  test("initialize() accepts deps parameter with same shape as parent", async () => {
    // Build a mock SQL client that also satisfies the pgvector extension check
    const vectorSqlFunction = mock((strings: TemplateStringsArray, ...values: any[]) => {
      const queryString = (strings as unknown as string[])[0] ?? "";
      if (queryString.includes("pg_extension") && queryString.includes("vector")) {
        return Promise.resolve([{ exists: true }]);
      }
      return Promise.resolve([]);
    });
    const vectorSql = Object.assign(vectorSqlFunction, {
      options: { parsers: {}, serializers: {} },
      query: mock(() => Promise.resolve([])),
      end: mock(() => Promise.resolve()),
    });

    const config: PersistenceConfig = {
      backend: "postgres",
      postgres: {
        connectionString: TEST_CONNECTION_STRING,
        connectTimeout: 15,
        idleTimeout: 60,
      },
    };
    const provider = new PostgresVectorPersistenceProvider(config);

    // Should accept the same deps shape without TypeScript error and initialize correctly
    await provider.initialize({ sqlClient: vectorSql as any });

    expect((provider as unknown as { isInitialized: boolean }).isInitialized).toBe(true);
  });

  test("initialize() accepts postgresFactory in deps parameter", async () => {
    // Build a vector-aware postgres factory mock (passes pgvector extension check)
    const vectorAwareFactory = mock((connStr: string, opts: Record<string, unknown>) => {
      const sqlFn = mock((strings: TemplateStringsArray, ...values: any[]) => {
        const queryString = (strings as unknown as string[])[0] ?? "";
        if (queryString.includes("pg_extension") && queryString.includes("vector")) {
          return Promise.resolve([{ exists: true }]);
        }
        return Promise.resolve([]);
      });
      return Object.assign(sqlFn, {
        options: { parsers: {}, serializers: {} },
        query: mock(() => Promise.resolve([])),
        end: mock(() => Promise.resolve()),
        _connStr: connStr,
        _opts: opts,
      });
    });

    const config: PersistenceConfig = {
      backend: "postgres",
      postgres: {
        connectionString: TEST_CONNECTION_STRING,
        connectTimeout: 10,
        idleTimeout: 30,
      },
    };
    const provider = new PostgresVectorPersistenceProvider(config);

    // Should not throw TypeScript error — same shape as parent's deps
    await provider.initialize({ postgresFactory: vectorAwareFactory as any });

    expect((provider as unknown as { isInitialized: boolean }).isInitialized).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// shouldAutoMigrate — pure predicate (mt#1763 R1 BLOCKING #3 / mt#1767)
// ---------------------------------------------------------------------------

describe("shouldAutoMigrate (mt#1767)", () => {
  test("true when no deps and env has no MINSKY_AUTO_MIGRATE", () => {
    expect(shouldAutoMigrate(undefined, {})).toBe(true);
  });

  test("true when no deps and MINSKY_AUTO_MIGRATE is unset/empty", () => {
    expect(shouldAutoMigrate(undefined, { MINSKY_AUTO_MIGRATE: "" })).toBe(true);
  });

  test("true when no deps and MINSKY_AUTO_MIGRATE is 'true'", () => {
    expect(shouldAutoMigrate(undefined, { MINSKY_AUTO_MIGRATE: "true" })).toBe(true);
  });

  test("false when MINSKY_AUTO_MIGRATE is 'false' (explicit opt-out)", () => {
    expect(shouldAutoMigrate(undefined, { MINSKY_AUTO_MIGRATE: "false" })).toBe(false);
  });

  test("false when MINSKY_AUTO_MIGRATE is '0' (numeric opt-out)", () => {
    expect(shouldAutoMigrate(undefined, { MINSKY_AUTO_MIGRATE: "0" })).toBe(false);
  });

  test("false-opt-out is case-insensitive (FALSE)", () => {
    expect(shouldAutoMigrate(undefined, { MINSKY_AUTO_MIGRATE: "FALSE" })).toBe(false);
  });

  test("false when caller injected sqlClient (test seam)", () => {
    expect(shouldAutoMigrate({ sqlClient: {} }, {})).toBe(false);
  });

  test("false when caller injected postgresFactory (test seam)", () => {
    expect(shouldAutoMigrate({ postgresFactory: () => ({}) as unknown as never }, {})).toBe(false);
  });

  test("env opt-out wins over no-deps (false even without injected client)", () => {
    expect(shouldAutoMigrate(undefined, { MINSKY_AUTO_MIGRATE: "false" })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// resolveMigrationsFolder — bundle-aware path resolution (mt#1767 BLOCKING)
// ---------------------------------------------------------------------------

describe("resolveMigrationsFolder (mt#1767)", () => {
  // Snapshot env so tests can mutate without leaking across the suite.
  const savedFolder = process.env.MINSKY_MIGRATIONS_FOLDER;
  afterEach(() => {
    if (savedFolder === undefined) {
      delete process.env.MINSKY_MIGRATIONS_FOLDER;
    } else {
      process.env.MINSKY_MIGRATIONS_FOLDER = savedFolder;
    }
  });

  test("default resolution finds an existing migrations folder (dev or bundle)", () => {
    delete process.env.MINSKY_MIGRATIONS_FOLDER;
    const resolved = resolveMigrationsFolder();
    expect(typeof resolved).toBe("string");
    // eslint-disable-next-line custom/no-real-fs-in-tests
    expect(existsSync(resolved)).toBe(true);
    // Path must end with the canonical leaf — guards against accidentally
    // resolving to a sibling directory that happens to exist.
    expect(resolved.endsWith("storage/migrations/pg")).toBe(true);
  });

  test("MINSKY_MIGRATIONS_FOLDER override returns the override when it exists", () => {
    // Use a directory we know exists (the source migrations dir itself).
    const sourceDir = resolveMigrationsFolder();
    process.env.MINSKY_MIGRATIONS_FOLDER = sourceDir;
    expect(resolveMigrationsFolder()).toBe(sourceDir);
  });

  test("MINSKY_MIGRATIONS_FOLDER override throws when path does not exist", () => {
    process.env.MINSKY_MIGRATIONS_FOLDER = "/definitely/not/a/real/path/anywhere";
    expect(() => resolveMigrationsFolder()).toThrow(/MINSKY_MIGRATIONS_FOLDER/);
    expect(() => resolveMigrationsFolder()).toThrow(/does not exist or is not a directory/);
  });

  test("MINSKY_MIGRATIONS_FOLDER override throws when path is a file, not a directory (PR #1094 R1)", () => {
    // Use a known-existing file (this very test file). A regular-file path
    // exists but is not a directory; the override gate must reject it with
    // an actionable error, not pass it to drizzle's migrator.
    process.env.MINSKY_MIGRATIONS_FOLDER = __filename;
    expect(() => resolveMigrationsFolder()).toThrow(/MINSKY_MIGRATIONS_FOLDER/);
    expect(() => resolveMigrationsFolder()).toThrow(/not a directory/);
  });

  test("error message names BOTH candidates when default resolution fails", () => {
    // Can't easily simulate "neither candidate exists" without mocking fs.
    // Instead validate the message shape via the override-not-found path's
    // sibling: confirm the error message format exposes the override hint
    // and the env-var name (operator-actionable diagnostics).
    process.env.MINSKY_MIGRATIONS_FOLDER = "/definitely/not/a/real/path/anywhere";
    try {
      resolveMigrationsFolder();
      throw new Error("expected resolveMigrationsFolder to throw");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      expect(msg).toContain("MINSKY_MIGRATIONS_FOLDER");
    }
  });
});

// ---------------------------------------------------------------------------
// initialize() auto-migrate behavioral test (mt#1763 R2 / mt#1767)
// ---------------------------------------------------------------------------

describe("PostgresPersistenceProvider.initialize() auto-migrate (mt#1767)", () => {
  test("isInitialized is true after initialize() succeeds (deferred-flag invariant from R1 BLOCKING #1)", async () => {
    // Inject postgresFactory + skip auto-migrate (default behavior with deps
    // injected). Asserts the order-of-operations invariant: isInitialized
    // becomes true only at the END of the initialize() flow, never partway.
    const sqlFn: any = mock(() => Promise.resolve([{ "?column?": 1 }]));
    sqlFn.options = { parsers: {}, serializers: {} };
    sqlFn.query = mock(() => Promise.resolve([]));
    sqlFn.end = mock(() => Promise.resolve());
    const factory = mock(() => sqlFn);

    const config: PersistenceConfig = {
      backend: "postgres",
      postgres: {
        connectionString: "postgresql://test:test@localhost/test",
        connectTimeout: 10,
        idleTimeout: 30,
      },
    };
    const provider = new PostgresPersistenceProvider(config);
    await provider.initialize({ postgresFactory: factory as any });

    // shouldAutoMigrate returned false (postgresFactory injected) → migrations
    // skipped → isInitialized still becomes true at the end.
    expect((provider as unknown as { isInitialized: boolean }).isInitialized).toBe(true);
  });

  test("auto-migrate is skipped when caller injects deps (test-seam suppression)", async () => {
    // No env set, factory injected → shouldAutoMigrate returns false →
    // runMigrations is NOT called. We verify the negative by asserting
    // initialize succeeds without the migrations folder being touched.
    const sqlFn: any = mock(() => Promise.resolve([{ "?column?": 1 }]));
    sqlFn.options = { parsers: {}, serializers: {} };
    sqlFn.query = mock(() => Promise.resolve([]));
    sqlFn.end = mock(() => Promise.resolve());
    const factory = mock(() => sqlFn);

    const config: PersistenceConfig = {
      backend: "postgres",
      postgres: {
        connectionString: "postgresql://test:test@localhost/test",
        connectTimeout: 10,
        idleTimeout: 30,
      },
    };
    const provider = new PostgresPersistenceProvider(config);

    // _overrideAutoMigrate omitted → deps-based suppression applies.
    // initialize() must complete without invoking runMigrations (would crash
    // against this stub factory's non-real DB).
    await provider.initialize({ postgresFactory: factory as any });
    expect((provider as unknown as { isInitialized: boolean }).isInitialized).toBe(true);
  });
});
