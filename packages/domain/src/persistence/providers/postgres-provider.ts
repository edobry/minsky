/**
 * PostgreSQL Persistence Provider
 *
 * Full-featured persistence provider with SQL, transactions, JSONB, and vector support.
 */

import { existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import {
  PersistenceProvider,
  VectorCapablePersistenceProvider,
  SqlCapablePersistenceProvider,
  PersistenceCapabilities,
  PersistenceConfig,
  type SessionStorage,
} from "../types";
import type { VectorStorage } from "../../storage/vector/types";
import { log } from "@minsky/shared/logger";
import { logPostgresNotice } from "../postgres-notice-handler";
import { PostgresVectorStorage } from "../../storage/vector/postgres-vector-storage";
import { withPgPoolRetry } from "../postgres-retry";
import {
  EMBEDDINGS_CONFIGS,
  type VectorDomain,
} from "../../storage/schemas/embeddings-schema-factory";

// Per-process default pool size. Minsky shares a single Supabase/Supavisor
// transaction-mode pooler (port 6543) across multiple long-lived consumers
// (laptop MCP, Railway MCP, Railway reviewer, cockpit menu-bar app) plus
// ephemeral probes. mt#1193 originally set this to 3 to keep the fleet under
// the SESSION-mode pooler's hard 15-slot ceiling. After the 2026-04-24 swap to
// the transaction-mode pooler (memory 63fbc195) that global ceiling is
// effectively gone (practical ceiling in the thousands), so the value no longer
// rations a scarce global budget. It now sizes per-process query FAN-OUT
// concurrency: 15 lets a dashboard/handler issue ~15 parallel queries without
// client-side queueing (the prior 3 produced gratuitous latency and starved
// widgets that fan out, e.g. the 4-parallel-query path in mt#2183). Retuned to
// 15 by mt#2224. Override via persistence.postgres.maxConnections in config or
// the MINSKY_POSTGRES_MAX_CONNECTIONS env var.
// Note: the transaction-mode pooler is the primary connection used for all
// normal queries. For LISTEN/NOTIFY, a separate session-mode connection is
// maintained via `getListenCapableSqlConnection()` (mt#1852).
const DEFAULT_POSTGRES_MAX_CONNECTIONS = 15;
// Upper bound matching the config schema's .max(100). The env-var path
// (MINSKY_POSTGRES_MAX_CONNECTIONS) bypasses Zod validation, so this clamp is
// the only thing bounding it — kept after the mt#2224 audit: even though the
// transaction pooler is no longer easy to saturate, 100 remains a sane
// per-process ceiling and keeps the env-var path consistent with the schema's
// .max(100).
const MAX_POSTGRES_MAX_CONNECTIONS = 100;

/**
 * mt#1763 (PR #1065 R1 BLOCKING #3) — pure-function predicate for the
 * auto-migration decision. Extracted so tests can exercise the decision
 * logic without needing a real DB connection.
 *
 * Returns true when both:
 *   - the caller did NOT inject any `deps` (sqlClient or postgresFactory), AND
 *   - `MINSKY_AUTO_MIGRATE` env var is not explicitly disabled ("false" / "0").
 *
 * The `env` parameter is injectable so tests can override the env-var lookup
 * without mutating `process.env` (which leaks across tests).
 */
export function shouldAutoMigrate(
  deps?: { sqlClient?: unknown; postgresFactory?: unknown },
  env: NodeJS.ProcessEnv = process.env
): boolean {
  const enabled = !["false", "0"].includes((env.MINSKY_AUTO_MIGRATE ?? "true").toLowerCase());
  if (!enabled) return false;
  const callerOwnsClient = deps?.sqlClient !== undefined || deps?.postgresFactory !== undefined;
  return !callerOwnsClient;
}

/**
 * mt#1767 — bundle-aware migrations folder resolution. Replaces mt#1763's
 * single-candidate path that worked in dev (Bun running `src/`) but failed
 * in the production bundle (Bun running `/app/dist/minsky.js`) because the
 * `import.meta.url`-relative `../../storage/migrations/pg` landed at
 * `/storage/migrations/pg`, outside `/app`.
 *
 * Resolution order (first existing wins):
 *   1. `MINSKY_MIGRATIONS_FOLDER` env override (errors loud if set + missing).
 *   2. `./storage/migrations/pg` relative to this module — production bundle
 *      path: bundle is at `/app/dist/minsky.js`, Dockerfile copies migrations
 *      to `/app/dist/storage/migrations/pg/`.
 *   3. `../../storage/migrations/pg` relative to this module — dev path:
 *      this file is at `src/domain/persistence/providers/postgres-provider.ts`,
 *      migrations are at `packages/domain/src/storage/migrations/pg/`.
 *
 * If none exist, throws with the candidates listed so the operator sees
 * exactly where the lookup looked. The mt#1787 bundle-boot-smoke CI gate
 * exercises this path on every PR — any regression in the Dockerfile copy
 * step or path-resolution logic surfaces at PR time.
 */
export function resolveMigrationsFolder(): string {
  const override = process.env.MINSKY_MIGRATIONS_FOLDER;
  if (override) {
    // PR #1094 R1 BLOCKING: validate the override is a directory, not just any
    // existing path. Without `isDirectory()`, a regular-file path would pass
    // this gate and then fail downstream inside drizzle's migrator with a less
    // actionable error. The error message below promises a directory check, so
    // honor that contract here.
    if (!existsSync(override) || !statSync(override).isDirectory()) {
      throw new Error(
        `MINSKY_MIGRATIONS_FOLDER=${override} but the directory does not exist or is not a directory. ` +
          `Set MINSKY_MIGRATIONS_FOLDER to a directory containing Drizzle migrations or unset to use the default.`
      );
    }
    return override;
  }
  const candidates = [
    fileURLToPath(new URL("./storage/migrations/pg", import.meta.url)),
    fileURLToPath(new URL("../../storage/migrations/pg", import.meta.url)),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    `Auto-migration directory not found. Tried: ${candidates.join(", ")}. ` +
      `This indicates the build artifact does not include the migrations folder. ` +
      `Either copy packages/domain/src/storage/migrations/pg/ next to the compiled module, ` +
      `or set MINSKY_MIGRATIONS_FOLDER to an absolute path, ` +
      `or set MINSKY_AUTO_MIGRATE=false and apply migrations out-of-band.`
  );
}

function resolveMaxConnections(configured: number | undefined): number {
  const pick = (n: number): number => {
    if (n > MAX_POSTGRES_MAX_CONNECTIONS) {
      log.warn(
        `maxConnections (${n}) exceeds upper bound (${MAX_POSTGRES_MAX_CONNECTIONS}); clamping to prevent pooler saturation`
      );
      return MAX_POSTGRES_MAX_CONNECTIONS;
    }
    return n;
  };
  if (typeof configured === "number" && configured > 0) return pick(configured);
  const envRaw = process.env.MINSKY_POSTGRES_MAX_CONNECTIONS;
  if (envRaw) {
    const parsed = Number(envRaw);
    if (Number.isFinite(parsed) && parsed > 0) return pick(parsed);
  }
  return DEFAULT_POSTGRES_MAX_CONNECTIONS;
}

/**
 * Derive a session-mode-pooler URL from a Supavisor transaction-pooler URL by
 * swapping the URL's port from 6543 → 5432. Returns the input unchanged if the
 * URL is not on port 6543 (so non-Supavisor hosts pass through — the URL is
 * assumed to already be session-mode-capable).
 *
 * Supavisor exposes the same logical pooler on two ports with different semantics:
 *   - :6543 — transaction mode (pool connections between transactions; LISTEN-incompatible)
 *   - :5432 — session mode (one backend connection per client; LISTEN-compatible)
 *
 * Uses URL parsing (handles IPv6 literals, credentials, query strings correctly)
 * with a regex fallback for non-URL-shaped strings (e.g. libpq key=value format
 * — rare but supported by postgres-js). PR #1135 R1 NON-BLOCKING refinement.
 */
export function swapSupavisorPort(connectionString: string): string {
  try {
    const url = new URL(connectionString);
    if (url.port === "6543") {
      url.port = "5432";
      return url.toString();
    }
    return connectionString;
  } catch {
    // Not URL-shaped (e.g. libpq key=value DSN). Fall back to a bounded regex
    // that only touches the authority's port segment between `@` and `/`.
    return connectionString.replace(/(@[^/?]*):6543(?=\/|$|\?)/, "$1:5432");
  }
}

/**
 * Base PostgreSQL persistence provider (without vector storage)
 */
export class PostgresPersistenceProvider
  extends PersistenceProvider
  implements SqlCapablePersistenceProvider
{
  protected db: PostgresJsDatabase | null = null;
  protected sql: ReturnType<typeof postgres> | null = null;
  /** Dedicated session-mode connection for LISTEN/NOTIFY (mt#1852). Created lazily. */
  protected listenSql: ReturnType<typeof postgres> | null = null;
  protected config: PersistenceConfig;
  protected isInitialized = false;
  private cachedStorage: SessionStorage | null = null;

  /**
   * Base PostgreSQL capabilities (no vector storage)
   */
  readonly capabilities: PersistenceCapabilities & { sql: true } = {
    sql: true,
    transactions: true,
    jsonb: true,
    vectorStorage: false,
    migrations: true,
  };

  // Note: Capabilities are returned by getCapabilities() method below

  constructor(config: PersistenceConfig) {
    super();
    if (config.backend !== "postgres" || !config.postgres) {
      throw new Error("PostgresPersistenceProvider requires postgres configuration");
    }
    this.config = config;
  }

  /** Returns the postgres config — guaranteed non-null by the constructor. */
  private get pgConfig(): NonNullable<PersistenceConfig["postgres"]> {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    return this.config.postgres!;
  }

  /**
   * Initialize PostgreSQL connection
   */
  async initialize(deps?: {
    sqlClient?: ReturnType<typeof postgres>;
    postgresFactory?: typeof postgres;
    /**
     * Test-only override (mt#1763 PR #1065 R2 / mt#1767): when explicitly set,
     * overrides the deps-based suppression in `shouldAutoMigrate`. Lets a test
     * that injects a `postgresFactory` (to avoid a real socket) still flow
     * through the auto-migrate branch so behavioral coverage of the happy path
     * is possible without a real DB. Production callsites leave this
     * `undefined` and let `shouldAutoMigrate` decide.
     */
    _overrideAutoMigrate?: boolean;
  }): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    const pgConfig = this.pgConfig;
    // Track whether we created the connection (vs injected) for cleanup
    let createdSql: ReturnType<typeof postgres> | null = null;

    try {
      log.debug("Initializing PostgreSQL persistence provider");

      // Resolve the factory — allows tests to inject a mock without mock.module()
      const pgFactory = deps?.postgresFactory ?? postgres;

      // Create PostgreSQL connection (use injected client or create new one).
      // `onnotice` routes NOTICEs through `log.debug` (via the shared handler at
      // postgres-notice-handler.ts). Pre-mt#1828 this site dropped silently with
      // `() => {}` to keep stdout clean (mt#1827); the helper preserves the
      // stdout-clean property AND captures the operational signal at debug
      // level. Six postgres-js sites in total go through this helper.
      const sql =
        deps?.sqlClient ??
        pgFactory(pgConfig.connectionString, {
          max: resolveMaxConnections(pgConfig.maxConnections),
          connect_timeout: pgConfig.connectTimeout || 10,
          idle_timeout: pgConfig.idleTimeout || 60,
          prepare: pgConfig.prepareStatements ?? false,
          onnotice: logPostgresNotice,
        });

      // Track only connections we created, so we can clean up on failure without
      // closing an injected client that the caller still owns
      if (!deps?.sqlClient) {
        createdSql = sql;
      }

      // Create Drizzle instance
      const db = drizzle(sql);

      // Verify connection — retry on pool saturation (mt#1193)
      await withPgPoolRetry(() => sql`SELECT 1`, "postgres-provider.initialize");

      // Cache the connection objects BEFORE running migrations. runMigrations
      // uses `this.db` / `this.sql`, but `this.isInitialized` stays false until
      // migrations succeed — per mt#1763 R1 BLOCKING #1, callers waiting on
      // initialize() must not see isInitialized=true while migrations are
      // still running (race window where they could read pre-migration schema).
      this.sql = sql;
      this.db = db;

      // mt#1767 (mt#1763 redo, post-revert): auto-run pending migrations.
      // Skip conditions (see `shouldAutoMigrate` for the predicate):
      // - Caller injected any `deps` (sqlClient or postgresFactory): test seam.
      // - `MINSKY_AUTO_MIGRATE` env var is "false" / "0": explicit opt-out.
      // The `_overrideAutoMigrate` test seam can force the auto-migrate branch
      // (see initialize signature for rationale).
      const autoMigrate = deps?._overrideAutoMigrate ?? shouldAutoMigrate(deps);
      if (autoMigrate) {
        await this.runMigrations(resolveMigrationsFolder());
      } else if (deps?.sqlClient !== undefined || deps?.postgresFactory !== undefined) {
        log.debug("Skipping auto-migration: caller-injected deps (test seam)");
      } else {
        log.warn("Skipping auto-migration: MINSKY_AUTO_MIGRATE=false");
      }

      // All checks passed AND migrations applied — now mark initialized.
      this.isInitialized = true;
      log.debug("Base PostgreSQL persistence provider initialized");
    } catch (error) {
      // Clean up connection we created to prevent pool leaks
      if (createdSql) {
        try {
          await createdSql.end();
        } catch {
          /* ignore cleanup errors */
        }
      }
      this.sql = null;
      this.db = null;
      this.isInitialized = false;
      log.error(
        "Failed to initialize PostgreSQL provider:",
        error instanceof Error ? error : { error: String(error) }
      );
      throw error;
    }
  }

  /**
   * Get provider capabilities
   */
  getCapabilities(): PersistenceCapabilities {
    return this.capabilities;
  }

  /**
   * Get storage instance for domain entities
   */
  getStorage(): SessionStorage {
    if (!this.isInitialized) {
      throw new Error("PostgresPersistenceProvider not initialized");
    }

    // Return cached storage instance — creating a new one every call caused
    // independent connection pools and fire-and-forget initialization (mt#722)
    if (this.cachedStorage) {
      return this.cachedStorage;
    }

    const { PostgresStorage } = require("../../storage/backends/postgres-storage");
    // PostgresStorage reuses this provider's sql client (see constructor); it
    // does not open its own sockets, so only connectionString is needed.
    const storage = new PostgresStorage(
      { connectionString: this.pgConfig.connectionString },
      this // Pass provider so storage reuses our connections
    );

    this.cachedStorage = storage;
    return storage as SessionStorage;
  }

  /**
   * Get direct database connection
   */
  async getDatabaseConnection(): Promise<PostgresJsDatabase> {
    if (!this.isInitialized) {
      throw new Error("PostgresPersistenceProvider not initialized");
    }

    if (!this.db) {
      throw new Error("Database connection not available");
    }

    return this.db;
  }

  /**
   * Get raw SQL connection for migrations and low-level operations
   */
  async getRawSqlConnection(): Promise<ReturnType<typeof postgres>> {
    if (!this.isInitialized) {
      throw new Error("PostgresPersistenceProvider not initialized");
    }

    if (!this.sql) {
      throw new Error("Raw SQL connection not available");
    }

    return this.sql;
  }

  /**
   * Get a session-mode-capable Sql instance for LISTEN/NOTIFY (mt#1852).
   *
   * The transaction-mode pooler (:6543) is incompatible with LISTEN — the pooler
   * may route each command to a different backend connection, breaking per-connection
   * LISTEN registrations. This method returns a connection over the session-mode pooler
   * (:5432 on Supabase/Supavisor), which preserves backend connections for the life of
   * the client session.
   *
   * The connection is created lazily on first call and cached for the lifetime of this
   * provider instance. It uses max:1 and idle_timeout:0 so the LISTEN state persists
   * without expiration.
   *
   * The underlying Sql instance is NOT closed by this method — lifecycle is owned by
   * the caller (typically a `PostgresChannelListener`). `close()` on this provider
   * closes the listen connection as part of full teardown.
   */
  async getListenCapableSqlConnection(): Promise<ReturnType<typeof postgres>> {
    if (!this.isInitialized) {
      throw new Error("PostgresPersistenceProvider not initialized");
    }

    if (this.listenSql) {
      return this.listenSql;
    }

    const sessionUrl = this.resolveSessionConnectionString();
    this.listenSql = postgres(sessionUrl, {
      max: 1, // listener needs one connection; LISTEN state is per-connection
      connect_timeout: this.pgConfig.connectTimeout ?? 10,
      idle_timeout: 0, // never idle out — LISTEN must persist
      prepare: false,
      onnotice: logPostgresNotice,
    });

    return this.listenSql;
  }

  /**
   * Resolve the session-mode connection string for LISTEN/NOTIFY.
   * Uses the explicit sessionConnectionString config when set;
   * otherwise auto-derives by swapping :6543 → :5432 (Supavisor port-swap).
   */
  private resolveSessionConnectionString(): string {
    if (this.pgConfig.sessionConnectionString) {
      return this.pgConfig.sessionConnectionString;
    }
    // Supavisor port-swap auto-derive: transaction pooler is on :6543, session
    // pooler is on :5432, same host. For non-Supavisor hosts the URL is returned
    // unchanged (assumed already session-mode-capable).
    return swapSupavisorPort(this.pgConfig.connectionString);
  }

  /**
   * Run database migrations
   */
  async runMigrations(migrationsFolder: string): Promise<void> {
    if (!this.db) {
      throw new Error("Database connection not available");
    }

    try {
      log.info(`Running migrations from ${migrationsFolder}`);
      await migrate(this.db, { migrationsFolder });
      log.info("Migrations completed successfully");
    } catch (error) {
      log.error(
        "Failed to run migrations:",
        error instanceof Error ? error : { error: String(error) }
      );
      throw error;
    }
  }

  /**
   * Close database connections
   */
  async close(): Promise<void> {
    try {
      // Close the session-mode listen connection first (if created)
      if (this.listenSql) {
        try {
          await this.listenSql.end();
        } catch (listenErr) {
          log.warn(
            `Error closing listen SQL connection: ${listenErr instanceof Error ? listenErr.message : String(listenErr)}`
          );
        }
        this.listenSql = null;
      }
      if (this.sql) {
        await this.sql.end();
        this.sql = null;
        this.db = null;
        this.isInitialized = false;
        log.debug("PostgreSQL connections closed");
      }
    } catch (error) {
      log.error(
        "Error closing PostgreSQL connections:",
        error instanceof Error ? error : { error: String(error) }
      );
      throw error;
    }
  }

  /**
   * Get connection information
   */
  getConnectionInfo(): string {
    if (!this.config.postgres) {
      return "PostgreSQL: Not configured";
    }

    const connectionString = this.config.postgres.connectionString;
    // Remove credentials for display
    const displayString = connectionString.replace(/\/\/[^@]+@/, "//***@");

    return `PostgreSQL: ${displayString} (${this.isInitialized ? "connected" : "disconnected"})`;
  }
}

/**
 * PostgreSQL persistence provider with vector storage support
 * Only created when pgvector extension is available
 */
export class PostgresVectorPersistenceProvider
  extends PostgresPersistenceProvider
  implements VectorCapablePersistenceProvider
{
  /**
   * PostgreSQL capabilities with vector storage
   */
  override readonly capabilities: PersistenceCapabilities & { sql: true; vectorStorage: true } = {
    sql: true,
    transactions: true,
    jsonb: true,
    vectorStorage: true,
    migrations: true,
  };

  async initialize(deps?: {
    sqlClient?: ReturnType<typeof postgres>;
    postgresFactory?: typeof postgres;
    /**
     * Test-only override (mt#1763 PR #1065 R2 / mt#1767): forwarded to
     * `super.initialize()` so the auto-migrate branch is exercisable in
     * tests that inject a `postgresFactory` to avoid a real DB socket.
     */
    _overrideAutoMigrate?: boolean;
  }): Promise<void> {
    // Initialize base PostgreSQL functionality first
    await super.initialize(deps);

    // Verify pgvector extension is available (should have been checked by factory)
    if (!this.sql) {
      throw new Error("SQL connection not available");
    }

    try {
      const result = await this.sql`
        SELECT EXISTS (
          SELECT 1 FROM pg_extension WHERE extname = 'vector'
        ) as exists
      `;

      if (!result[0]?.exists) {
        throw new Error("pgvector extension not available - factory should have prevented this");
      }

      log.debug("PostgreSQL persistence provider initialized with vector support");
    } catch (error) {
      log.error(
        "Failed to verify pgvector extension:",
        error instanceof Error ? error : { error: String(error) }
      );
      throw error;
    }
  }

  /**
   * Get vector storage for a specific domain.
   * Each domain has its own embeddings table (EMBEDDINGS_CONFIGS); this method
   * routes to the correct table, preventing cross-domain contamination.
   */
  getVectorStorageForDomain(domain: VectorDomain, dimension: number): VectorStorage {
    if (!this.isInitialized) {
      throw new Error("PostgresVectorPersistenceProvider not initialized");
    }

    if (!this.sql || !this.db) {
      throw new Error("Database connections not available");
    }

    const config = EMBEDDINGS_CONFIGS[domain];
    // The `metadata` (JSONB) and `content_hash` (TEXT) columns are created by
    // createEmbeddingsTable() on every embeddings table; pass them through so
    // PostgresVectorStorage actually writes the values it's been given.
    // Pre-mt#1930 these were silently dropped on the floor.
    return new PostgresVectorStorage(this.sql, this.db, dimension, {
      tableName: config.tableName,
      idColumn: config.idColumn,
      embeddingColumn: config.vectorColumn,
      lastIndexedAtColumn: config.indexedAtColumn,
      metadataColumn: "metadata",
      contentHashColumn: "content_hash",
    });
  }

  getConnectionInfo(): string {
    const baseInfo = super.getConnectionInfo();
    return baseInfo.replace("PostgreSQL:", "PostgreSQL (with vectors):");
  }
}
