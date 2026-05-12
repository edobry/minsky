/**
 * PostgreSQL Persistence Provider
 *
 * Full-featured persistence provider with SQL, transactions, JSONB, and vector support.
 */

import { existsSync } from "node:fs";
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
import { log } from "../../../utils/logger";
import { PostgresVectorStorage } from "../../storage/vector/postgres-vector-storage";
import { withPgPoolRetry } from "../postgres-retry";
import {
  EMBEDDINGS_CONFIGS,
  type VectorDomain,
} from "../../storage/schemas/embeddings-schema-factory";

// Per-process default pool size. Intentionally small: Minsky shares a single
// Supabase/Supavisor session-mode pooler across multiple consumers (laptop
// MCP, Railway MCP, ad-hoc scripts). A high per-process max saturates the
// pooler's global ceiling. Override via persistence.postgres.maxConnections
// in config or MINSKY_POSTGRES_MAX_CONNECTIONS env var (mt#1193).
const DEFAULT_POSTGRES_MAX_CONNECTIONS = 3;
// Upper bound matching the config schema's .max(100). Applied to env-var
// overrides too so a misconfigured value can't re-saturate the pooler.
const MAX_POSTGRES_MAX_CONNECTIONS = 100;

/**
 * mt#1763 (PR #1065 R1 BLOCKING #3): pure-function predicate for the
 * auto-migration decision. Extracted so tests can exercise the decision
 * logic without needing a real DB connection (the production
 * `initialize({...})` path with no deps tries to open a real socket, which
 * unit tests can't fake without the per-deps test seam).
 *
 * Returns true when both:
 *   - the caller did NOT inject any `deps` (sqlClient or postgresFactory), AND
 *   - `MINSKY_AUTO_MIGRATE` env var is not explicitly disabled ("false" / "0").
 *
 * `env` parameter exists so tests can override the env-var lookup without
 * mutating `process.env` (which leaks across tests).
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
 * mt#1763 (PR #1065 R1 BLOCKING #4): resolve the migrations folder path
 * robustly across Node ESM / Bun / Windows. Using `URL.pathname` directly
 * leaks `/C:/...` drive prefixes and `%20`-encoded spaces; `fileURLToPath`
 * is the canonical conversion.
 *
 * Asserts the directory exists at the resolved location and throws a clear
 * error otherwise — fail-loud so the production deployment surface tells
 * the operator exactly where the migrations folder went missing rather than
 * burying the issue inside drizzle's downstream parser.
 *
 * Optional `migrationsFolderOverride` env var (`MINSKY_MIGRATIONS_FOLDER`)
 * supports build artifacts that relocate the migrations directory. The
 * default resolves relative to this module's location.
 */
export function resolveMigrationsFolder(): string {
  const override = process.env.MINSKY_MIGRATIONS_FOLDER;
  if (override) {
    if (!existsSync(override)) {
      throw new Error(
        `MINSKY_MIGRATIONS_FOLDER=${override} but the directory does not exist. ` +
          `Set MINSKY_MIGRATIONS_FOLDER to a directory containing Drizzle migrations or unset to use the default.`
      );
    }
    return override;
  }
  const resolved = fileURLToPath(new URL("../../storage/migrations/pg", import.meta.url));
  if (!existsSync(resolved)) {
    throw new Error(
      `Auto-migration directory not found at ${resolved}. ` +
        `This indicates the build artifact does not include the migrations folder. ` +
        `Either copy src/domain/storage/migrations/pg/ next to the compiled module, ` +
        `or set MINSKY_MIGRATIONS_FOLDER to an absolute path, ` +
        `or set MINSKY_AUTO_MIGRATE=false and apply migrations out-of-band.`
    );
  }
  return resolved;
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
 * Base PostgreSQL persistence provider (without vector storage)
 */
export class PostgresPersistenceProvider
  extends PersistenceProvider
  implements SqlCapablePersistenceProvider
{
  protected db: PostgresJsDatabase | null = null;
  protected sql: ReturnType<typeof postgres> | null = null;
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
     * Test-only override (mt#1763 / PR #1065 R2): when explicitly set,
     * overrides the deps-based suppression in `shouldAutoMigrate`. Lets a
     * test that injects a `postgresFactory` (to avoid a real socket) still
     * flow through the auto-migrate branch so behavioral coverage of the
     * happy path is possible without a real DB. Production callsites leave
     * this `undefined` and let `shouldAutoMigrate` decide.
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

      // Create PostgreSQL connection (use injected client or create new one)
      const sql =
        deps?.sqlClient ??
        pgFactory(pgConfig.connectionString, {
          max: resolveMaxConnections(pgConfig.maxConnections),
          connect_timeout: pgConfig.connectTimeout || 10,
          idle_timeout: pgConfig.idleTimeout || 60,
          prepare: pgConfig.prepareStatements ?? false,
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

      // Cache the connection objects BEFORE running migrations. runMigrations()
      // reads `this.db`, so the assignment is structurally required. The
      // `isInitialized` flag is intentionally deferred until AFTER migrations
      // succeed — see the "PR #1065 R1 BLOCKING #1" note below.
      this.sql = sql;
      this.db = db;
      log.debug("Base PostgreSQL persistence provider connected; checking migrations");

      // mt#1763: Auto-apply pending Drizzle migrations after the connection is
      // verified. Drizzle's migrate() is idempotent — it tracks applied
      // migrations in `__drizzle_migrations` and skips any whose hash is
      // already recorded. This eliminates the "deploy lands, schema isn't
      // updated, INSERT fails" failure class (originating incident mt#1762).
      //
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

      // PR #1065 R1 BLOCKING #1: set `isInitialized = true` only after
      // migrations succeed (or are intentionally skipped). The pre-fix code
      // flipped the flag BEFORE the awaited `runMigrations` call, which
      // opened a race window: a concurrent `initialize()` call could observe
      // `isInitialized === true` and return early via the guard at line 104,
      // while migrations were still running. If those then failed, the catch
      // block resets `isInitialized = false` and closes the pool, leaving the
      // second caller operating on a torn-down provider. Holding the flag
      // until the post-migrate point closes the race — concurrent callers
      // either re-attempt initialization (each calling postgres() once, which
      // creates separate clients but is rare) or fall through to the same
      // resolved state. The trade-off is intentional and minimal.
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
     * Test-only override (mt#1763 / PR #1065 R2): when explicitly set,
     * overrides the deps-based suppression in `shouldAutoMigrate`. Lets a
     * test that injects a `postgresFactory` (to avoid a real socket) still
     * flow through the auto-migrate branch so behavioral coverage of the
     * happy path is possible without a real DB. Production callsites leave
     * this `undefined` and let `shouldAutoMigrate` decide.
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
    return new PostgresVectorStorage(this.sql, this.db, dimension, {
      tableName: config.tableName,
      idColumn: config.idColumn,
      embeddingColumn: config.vectorColumn,
      lastIndexedAtColumn: config.indexedAtColumn,
    });
  }

  getConnectionInfo(): string {
    const baseInfo = super.getConnectionInfo();
    return baseInfo.replace("PostgreSQL:", "PostgreSQL (with vectors):");
  }
}
