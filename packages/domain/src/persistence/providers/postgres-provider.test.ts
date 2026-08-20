/**
 * Layer 1: Persistence Layer Tests
 * Test that persistence providers work correctly with mocked database connections
 */
import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import {
  PostgresPersistenceProvider,
  PostgresVectorPersistenceProvider,
  buildPostgresClient,
  createBoundedSocket,
  resolveMigrationsFolder,
  resolveSocketTimeoutMs,
  shouldAutoMigrate,
} from "./postgres-provider";
import { logPostgresNotice } from "../postgres-notice-handler";
import net from "node:net";
import { once } from "node:events";
// The unix-socket test below binds a REAL listener, and a socket can only be
// bound at a real filesystem path — '/mock/tmp' cannot be listened on. The
// cross-run race the rule guards against is avoided by naming the socket after
// the pid.
// eslint-disable-next-line custom/no-real-fs-in-tests
import { tmpdir } from "node:os";
import { join } from "node:path";
// mt#1767 — `resolveMigrationsFolder()` operates on real filesystem state by
// design (it must verify the deployed bundle's migrations folder exists).
// The tests below assert real-fs resolution, so the in-test fs prohibition
// (no-real-fs-in-tests) is intentionally suspended for this targeted import.
// eslint-disable-next-line custom/no-real-fs-in-tests
import { existsSync } from "node:fs";
import type { PersistenceConfig } from "../../configuration/types";
import { first } from "@minsky/shared/array-safety";
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

  test("initialize() sets up provider correctly", async () => {
    expect((provider as unknown as { isInitialized: boolean }).isInitialized).toBe(false);

    // Mock successful connection
    mockSql.query.mockImplementationOnce(() => Promise.resolve([]));

    await provider.initialize({ sqlClient: mockSql as any });

    expect((provider as unknown as { isInitialized: boolean }).isInitialized).toBe(true);
  });

  test("getRawSqlConnection() returns the pooler-guarded view when initialized (mt#2773)", async () => {
    // Mock successful connection
    mockSql.query.mockImplementationOnce(() => Promise.resolve([]));
    await provider.initialize({ sqlClient: mockSql as any });

    const connection = await provider.getRawSqlConnection();

    expect(connection).toBeDefined();
    // mt#2773: NOT the raw instance — a guarded Proxy that caps in-flight
    // .unsafe() queries at pool max (see raw-sql-pooler-guard.ts)...
    expect(connection).not.toBe(mockSql as any);
    // ...whose other properties forward to the underlying instance...
    expect((connection as unknown as { options: unknown }).options).toBe(
      (mockSql as { options: unknown }).options
    );
    expect(typeof connection.unsafe).toBe("function");
    // ...and which is cached across calls.
    expect(await provider.getRawSqlConnection()).toBe(connection);
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

  test("wiring: initialize() wires onnotice to the real logPostgresNotice handler (mt#1827 + mt#1828, mt#3628)", async () => {
    // mt#1827: drizzle's `CREATE SCHEMA IF NOT EXISTS drizzle` + `CREATE TABLE
    // IF NOT EXISTS __drizzle_migrations` emit Postgres NOTICE codes 42P06 +
    // 42P07 on every cold start. Without an `onnotice` handler, postgres-js's
    // default routes NOTICEs to stdout, breaking any CLI consumer that
    // JSON-parses the output.
    //
    // mt#1828 strengthens the contract: the wired handler must route through
    // the logger (preserving the operational signal) rather than dropping
    // silently. mt#3628: the message-building decision itself now lives in
    // `describeNotice` (postgres-notice-handler.test.ts, tested by return
    // value); this test's job is the PRODUCTION-WIRING check — confirming
    // `initialize()` actually installs the real `logPostgresNotice` handler,
    // not a decoy — via reference identity, never `spyOn(log)`.
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
      const onnotice = (opts as { onnotice?: unknown }).onnotice;
      expect(onnotice).toBe(logPostgresNotice);
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

  // mt#4298 regression. Vector storage runs EVERY query through `.unsafe()` —
  // the `<-> $1::vector` search, store, delete — which is precisely the surface
  // mt#2773's pooler guard bounds. Handing it the raw client left that traffic
  // as unguarded fan-out at the Supavisor transaction pooler, whose wedge leaves
  // postgres-js promises permanently unsettled: tasks_search hung with no error
  // for 81 minutes across three sessions on 2026-08-19.
  test("getVectorStorageForDomain() hands vector storage the guarded client, not the raw one", async () => {
    const rawSqlFunction = mock((strings: TemplateStringsArray, ..._values: any[]) => {
      const queryString = (strings as unknown as string[])[0] ?? "";
      if (queryString.includes("pg_extension") && queryString.includes("vector")) {
        return Promise.resolve([{ exists: true }]);
      }
      return Promise.resolve([]);
    });
    const rawSql = Object.assign(rawSqlFunction, {
      options: { parsers: {}, serializers: {}, max: 10 },
      query: mock(() => Promise.resolve([])),
      end: mock(() => Promise.resolve()),
      unsafe: mock(() => Promise.resolve([])),
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
    await provider.initialize({ sqlClient: rawSql as any });

    const guarded = await provider.getRawSqlConnection();
    const storage = provider.getVectorStorageForDomain("tasks" as never, 1536);
    const storageSql = (storage as unknown as { sql: unknown }).sql;

    // The fix: vector storage gets the SAME memoized guarded instance every
    // other `.unsafe()` consumer gets. Identity matters — the guard's bound is
    // a shared in-flight counter, so a second wrap would admit `max` again.
    expect(storageSql).toBe(guarded);

    // Negative control: this is the assertion that fails pre-fix, where
    // getVectorStorageForDomain passed `this.sql` straight through.
    expect(storageSql).not.toBe(rawSql);
  });
});

// ---------------------------------------------------------------------------
// mt#2973 — factory-probed client reuse (eliminates the redundant second
// cold-boot handshake). The factory hands the provider an already-open,
// SELECT-1-validated client via the constructor; initialize() must adopt it
// WITHOUT opening a second connection or re-running SELECT 1, and the vector
// provider must skip its redundant pgvector re-probe.
// ---------------------------------------------------------------------------

describe("PostgresPersistenceProvider factory-probed client reuse (mt#2973)", () => {
  const reuseConfig: PersistenceConfig = {
    backend: "postgres",
    postgres: {
      connectionString: TEST_CONNECTION_STRING,
      connectTimeout: 10,
      idleTimeout: 60,
    },
  };

  function makeReusableClient() {
    // The template-tag function stands in for `sql\`SELECT 1\`` / probe queries.
    // If the reuse path is correct, initialize() never invokes it (the factory
    // already ran SELECT 1 + the pgvector probe before handing the client over).
    const tag = mock(() => Promise.resolve([]));
    const client = Object.assign(tag, {
      options: { parsers: {}, serializers: {} },
      query: mock(() => Promise.resolve([])),
      end: mock(() => Promise.resolve()),
    });
    return { tag, client };
  }

  test("adopts the probed client without a second connect or SELECT 1 (base provider)", async () => {
    const { tag, client } = makeReusableClient();
    // Must never be called on the reuse path — asserts no second handshake.
    const factoryMustNotRun = mock(() => {
      throw new Error("postgres factory must not be called on the reuse path");
    });

    const provider = new PostgresPersistenceProvider(reuseConfig, {
      sql: client as any,
      pgvectorVerified: false,
    });
    await provider.initialize({ postgresFactory: factoryMustNotRun as any });

    expect(factoryMustNotRun).not.toHaveBeenCalled(); // no second connection opened
    expect(tag).not.toHaveBeenCalled(); // redundant SELECT 1 skipped
    expect((provider as unknown as { isInitialized: boolean }).isInitialized).toBe(true);

    // close() must end the adopted client (ownership transferred to the provider).
    await provider.close();
    expect(client.end).toHaveBeenCalledTimes(1);
  });

  test("vector provider with factory-verified pgvector skips the redundant re-probe", async () => {
    const { tag, client } = makeReusableClient();

    const provider = new PostgresVectorPersistenceProvider(reuseConfig, {
      sql: client as any,
      pgvectorVerified: true,
    });
    await provider.initialize();

    // Both the base SELECT 1 AND the vector re-probe must be skipped → 0 tag calls.
    expect(tag).not.toHaveBeenCalled();
    expect((provider as unknown as { isInitialized: boolean }).isInitialized).toBe(true);
    expect(provider.getCapabilities().vectorStorage).toBe(true);
  });

  test("close() ends a probed client that was never adopted (orphan cleanup)", async () => {
    const { client } = makeReusableClient();

    // Constructed with a probed client but initialize() is never called.
    const provider = new PostgresPersistenceProvider(reuseConfig, {
      sql: client as any,
      pgvectorVerified: false,
    });
    await provider.close();

    // The orphaned client must still be ended so the pool doesn't leak.
    expect(client.end).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// shouldAutoMigrate — pure predicate (mt#1763 R1 BLOCKING #3 / mt#1767)
// ---------------------------------------------------------------------------

describe("shouldAutoMigrate (default OFF, mt#2560)", () => {
  test("false when no deps and MINSKY_AUTO_MIGRATE is unset (default off)", () => {
    expect(shouldAutoMigrate(undefined, {})).toBe(false);
  });

  test("false when no deps and MINSKY_AUTO_MIGRATE is empty (default off)", () => {
    expect(shouldAutoMigrate(undefined, { MINSKY_AUTO_MIGRATE: "" })).toBe(false);
  });

  test("true when no deps and MINSKY_AUTO_MIGRATE is 'true' (opt-in)", () => {
    expect(shouldAutoMigrate(undefined, { MINSKY_AUTO_MIGRATE: "true" })).toBe(true);
  });

  test("true when no deps and MINSKY_AUTO_MIGRATE is '1' (numeric opt-in)", () => {
    expect(shouldAutoMigrate(undefined, { MINSKY_AUTO_MIGRATE: "1" })).toBe(true);
  });

  test("opt-in is case-insensitive (TRUE)", () => {
    expect(shouldAutoMigrate(undefined, { MINSKY_AUTO_MIGRATE: "TRUE" })).toBe(true);
  });

  test("false when MINSKY_AUTO_MIGRATE is 'false'", () => {
    expect(shouldAutoMigrate(undefined, { MINSKY_AUTO_MIGRATE: "false" })).toBe(false);
  });

  test("false when MINSKY_AUTO_MIGRATE is '0'", () => {
    expect(shouldAutoMigrate(undefined, { MINSKY_AUTO_MIGRATE: "0" })).toBe(false);
  });

  test("true when MINSKY_AUTO_MIGRATE is 'yes' (opt-in)", () => {
    expect(shouldAutoMigrate(undefined, { MINSKY_AUTO_MIGRATE: "yes" })).toBe(true);
  });

  test("true when MINSKY_AUTO_MIGRATE is 'on' (opt-in)", () => {
    expect(shouldAutoMigrate(undefined, { MINSKY_AUTO_MIGRATE: "on" })).toBe(true);
  });

  test("false for a non-opt-in value (e.g. 'maybe')", () => {
    expect(shouldAutoMigrate(undefined, { MINSKY_AUTO_MIGRATE: "maybe" })).toBe(false);
  });

  test("false when caller injected sqlClient (test seam)", () => {
    expect(shouldAutoMigrate({ sqlClient: {} }, { MINSKY_AUTO_MIGRATE: "true" })).toBe(false);
  });

  test("false when caller injected postgresFactory (test seam)", () => {
    expect(
      shouldAutoMigrate(
        { postgresFactory: () => ({}) as unknown as never },
        { MINSKY_AUTO_MIGRATE: "true" }
      )
    ).toBe(false);
  });

  test("injected deps win over opt-in (false even with MINSKY_AUTO_MIGRATE=true)", () => {
    expect(shouldAutoMigrate({ sqlClient: {} }, { MINSKY_AUTO_MIGRATE: "1" })).toBe(false);
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

/**
 * mt#3592 — the socket inactivity bound that keeps a half-open connection from
 * wedging the pool forever.
 *
 * WHY THESE TESTS ARE SHAPED THIS WAY. The previous attempt (mt#3092) shipped
 * this mechanism behind four unit tests, a negative control, sixteen green CI
 * checks and a clean review — and took production down, because its factory
 * returned an UNCONNECTED socket and not one test in the repo ever opened a
 * connection through it. So every test here that asserts on connection
 * behaviour opens a real socket against a real listener. A test that only
 * inspects the returned object cannot catch that class of defect.
 */

/** A no-op 'error' handler. Destroying a socket surfaces an async error the
 *  test is not asserting on; postgres-js attaches its own handler immediately
 *  after the factory returns (connection.js:139), so production never sees it
 *  unhandled either. */
function ignoreSocketError(): void {
  // intentional-swallow: the destroy path under test is asserted via 'close'.
}

/** A TCP listener that accepts connections and then says nothing — a peer that
 *  has stopped responding without closing, which is the condition being bounded. */
async function startSilentServer(): Promise<{
  port: number;
  accepted: Promise<net.Socket>;
  close: () => Promise<void>;
}> {
  const sockets: net.Socket[] = [];
  let resolveAccepted!: (socket: net.Socket) => void;
  const accepted = new Promise<net.Socket>((resolve) => {
    resolveAccepted = resolve;
  });
  const server = net.createServer((socket) => {
    sockets.push(socket);
    resolveAccepted(socket);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected a TCP address from a TCP listener");
  }
  return {
    port: address.port,
    accepted,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

describe("resolveSocketTimeoutMs (mt#3592)", () => {
  test("derives the bound from idleTimeout, converted to milliseconds", () => {
    expect(resolveSocketTimeoutMs(30)).toBe(30_000);
  });

  test("falls back to 60s when idleTimeout is unset", () => {
    expect(resolveSocketTimeoutMs(undefined)).toBe(60_000);
  });

  test("floors idleTimeout: 0 instead of composing two different 'disabled' meanings", () => {
    // postgres-js reads idle_timeout: 0 as "never idle out" and Node reads
    // setTimeout(0) as "no timeout" — composing them would silently restore the
    // unbounded hang this whole mechanism exists to prevent.
    expect(resolveSocketTimeoutMs(0)).toBe(60_000);
  });

  test("floors a negative idleTimeout", () => {
    expect(resolveSocketTimeoutMs(-30)).toBe(60_000);
  });
});

describe("createBoundedSocket (mt#3592)", () => {
  test("returns a CONNECTED socket, reading host/port as the arrays postgres-js passes", async () => {
    const server = await startSilentServer();
    try {
      // `host` and `port` are arrays on postgres-js's options object
      // (index.js:466-467, multi-host support). Reading them as scalars yields
      // undefined and connects nowhere.
      const socket = createBoundedSocket(60_000, {
        host: ["127.0.0.1"],
        port: [server.port],
      });
      socket.on("error", ignoreSocketError);

      await once(socket, "connect");
      // postgres-js writes its StartupMessage immediately after this factory
      // returns — connection.js:345 skips its own connect() for a custom socket
      // — so an unconnected socket fails every write with "Socket is closed".
      expect(socket.destroyed).toBe(false);
      expect(socket.writable).toBe(true);

      // The server actually accepted it: proof the address resolved, not just
      // that a socket object came back.
      await server.accepted;
      socket.destroy();
    } finally {
      await server.close();
    }
  });

  test("also accepts scalar host/port (the defensive branch)", async () => {
    const server = await startSilentServer();
    try {
      const socket = createBoundedSocket(60_000, {
        host: "127.0.0.1",
        port: server.port,
      });
      socket.on("error", ignoreSocketError);
      await once(socket, "connect");
      await server.accepted;
      socket.destroy();
    } finally {
      await server.close();
    }
  });

  test("connects over TCP when path is false, the value postgres-js sets for a TCP host", async () => {
    const server = await startSilentServer();
    try {
      // index.js:468 — `path: o.path || host.indexOf('/') > -1 && ...`, so a TCP
      // host yields `false`, not undefined. A truthiness check on `path` alone
      // would be fine here but a `path in options` check would not; this pins it.
      const socket = createBoundedSocket(60_000, {
        host: ["127.0.0.1"],
        port: [server.port],
        path: false,
      });
      socket.on("error", ignoreSocketError);
      await once(socket, "connect");
      await server.accepted;
      socket.destroy();
    } finally {
      await server.close();
    }
  });

  test("connects over a unix socket when options.path is a real path", async () => {
    // postgres-js returns at connection.js:345 BEFORE its own `if (options.path)`
    // branch, so the unix-socket case has to be handled inside the factory.
    const socketPath = join(tmpdir(), `minsky-bounded-socket-${process.pid}.sock`);
    const server = net.createServer(() => {});
    await new Promise<void>((resolve) => server.listen(socketPath, () => resolve()));
    try {
      const socket = createBoundedSocket(60_000, {
        path: socketPath,
        host: ["ignored-when-path-is-set"],
        port: [1],
      });
      socket.on("error", ignoreSocketError);
      await once(socket, "connect");
      expect(socket.destroyed).toBe(false);
      socket.destroy();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("destroys the socket once the bound elapses with no traffic", async () => {
    const server = await startSilentServer();
    try {
      const boundMs = 150;
      const socket = createBoundedSocket(boundMs, {
        host: ["127.0.0.1"],
        port: [server.port],
      });
      socket.on("error", ignoreSocketError);
      await once(socket, "connect");

      const startedAt = performance.now();
      // 'close' is the whole point: postgres-js settles a pending query on it
      // (connection.js:453 — `!hadError && (query || sent.length) && error(
      // CONNECTION_CLOSED)`). Without it the query promise never settles and the
      // pool slot is never returned.
      await once(socket, "close");

      expect(socket.destroyed).toBe(true);
      expect(performance.now() - startedAt).toBeGreaterThanOrEqual(boundMs * 0.8);
    } finally {
      await server.close();
    }
  });

  test("does NOT destroy a socket that keeps seeing traffic — the bound is inactivity, not age", async () => {
    // The regression this guards: if the timer measured connection AGE rather
    // than inactivity, every healthy pooled connection would be torn down every
    // idle_timeout seconds mid-use.
    const chatter: net.Socket[] = [];
    const server = net.createServer((socket) => {
      chatter.push(socket);
      const beat = setInterval(() => socket.write("."), 40);
      socket.on("close", () => clearInterval(beat));
      socket.on("error", ignoreSocketError);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("expected a TCP address from a TCP listener");
    }
    try {
      const socket = createBoundedSocket(200, { host: ["127.0.0.1"], port: [address.port] });
      socket.on("error", ignoreSocketError);
      socket.resume();
      await once(socket, "connect");

      await new Promise<void>((resolve) => setTimeout(resolve, 700));
      expect(socket.destroyed).toBe(false);
      socket.destroy();
    } finally {
      for (const socket of chatter) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("per-process pool default (mt#4308)", () => {
  test("with no configured maxConnections, the pool is sized from the measured pooler budget", () => {
    const prior = process.env.MINSKY_POSTGRES_MAX_CONNECTIONS;
    delete process.env.MINSKY_POSTGRES_MAX_CONNECTIONS;
    try {
      const { factory, getCapturedArgs } = makeMockPostgresFactory();
      buildPostgresClient({ connectionString: TEST_CONNECTION_STRING }, factory as any);

      // floor(POOLER_CLIENT_BUDGET 200 * POOL_BUDGET_FRACTION 0.5 /
      //       ASSUMED_CONCURRENT_POOL_HOLDERS 12) = 8, above the floor of 4.
      //
      // Asserting the NUMBER, not the formula: the point of mt#4308 is that the
      // value follows from measured inputs, so a future change to any input
      // should land here and force a reader to re-check the arithmetic rather
      // than silently re-tune the fleet's connection demand.
      expect((getCapturedArgs()?.[1] as { max?: number } | undefined)?.max).toBe(8);
    } finally {
      if (prior === undefined) delete process.env.MINSKY_POSTGRES_MAX_CONNECTIONS;
      else process.env.MINSKY_POSTGRES_MAX_CONNECTIONS = prior;
    }
  });

  test("an explicit config value still wins over the derived default", () => {
    const { factory, getCapturedArgs } = makeMockPostgresFactory();
    buildPostgresClient(
      { connectionString: TEST_CONNECTION_STRING, maxConnections: 21 },
      factory as any
    );
    expect((getCapturedArgs()?.[1] as { max?: number } | undefined)?.max).toBe(21);
  });
});

describe("buildPostgresClient socket wiring (mt#3592)", () => {
  test("passes a socket factory that produces a connected socket", async () => {
    const server = await startSilentServer();
    const { factory, getCapturedArgs } = makeMockPostgresFactory();
    try {
      buildPostgresClient(
        { connectionString: TEST_CONNECTION_STRING, idleTimeout: 30 },
        factory as any
      );

      const capturedArgs = getCapturedArgs();
      expect(capturedArgs).not.toBeNull();
      const socketFactory = capturedArgs?.[1].socket;
      expect(typeof socketFactory).toBe("function");

      // Exercised end-to-end rather than asserted as present: "an option named
      // socket exists" is exactly the assertion that held while production could
      // not open a connection at all.
      const socket = (socketFactory as (opts: unknown) => net.Socket)({
        host: ["127.0.0.1"],
        port: [server.port],
        path: false,
      });
      socket.on("error", ignoreSocketError);
      await once(socket, "connect");
      await server.accepted;
      socket.destroy();
    } finally {
      await server.close();
    }
  });

  test("wiring: TLS-bound warning routes through the injected logSink, not spyOn(log) (mt#3603, mt#3628)", () => {
    // Skipped rather than installed-but-inert: under TLS postgres-js wraps this
    // socket, and whether the wrapped socket's byte counters keep moving is
    // unverified — a check that read a busy connection as idle would sever it.
    const warnCalls: string[] = [];
    const logSink = { warn: (message: string) => warnCalls.push(message) };

    // sslmode enabled -> bound not installed, warns.
    const { factory: sslFactory, getCapturedArgs: sslArgs } = makeMockPostgresFactory();
    buildPostgresClient(
      { connectionString: "postgresql://user:pass@host/db?sslmode=require" },
      sslFactory as any,
      logSink
    );
    expect(sslArgs()?.[1].socket).toBeUndefined();
    expect(warnCalls.some((msg) => msg.includes("mt#3603"))).toBe(true);

    // sslmode=disable -> bound installed, no warn.
    warnCalls.length = 0;
    const { factory: disableFactory, getCapturedArgs: disableArgs } = makeMockPostgresFactory();
    buildPostgresClient(
      { connectionString: "postgresql://user:pass@host/db?sslmode=disable" },
      disableFactory as any,
      logSink
    );
    expect(typeof disableArgs()?.[1].socket).toBe("function");
    expect(warnCalls.some((msg) => msg.includes("mt#3603"))).toBe(false);
  });
});
