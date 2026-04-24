/**
 * PostgreSQL Persistence Provider
 *
 * Full-featured persistence provider with SQL, transactions, JSONB, and vector support.
 */

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

// Per-process default pool size. Intentionally small: Minsky shares a single
// Supabase/Supavisor session-mode pooler across multiple consumers (laptop
// MCP, Railway MCP, ad-hoc scripts). A high per-process max saturates the
// pooler's global ceiling. Override via persistence.postgres.maxConnections
// in config or MINSKY_POSTGRES_MAX_CONNECTIONS env var (mt#1193).
const DEFAULT_POSTGRES_MAX_CONNECTIONS = 3;

function resolveMaxConnections(configured: number | undefined): number {
  if (typeof configured === "number" && configured > 0) return configured;
  const envRaw = process.env.MINSKY_POSTGRES_MAX_CONNECTIONS;
  if (envRaw) {
    const parsed = Number(envRaw);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
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
  async initialize(deps?: { sqlClient?: ReturnType<typeof postgres> }): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    const pgConfig = this.pgConfig;
    // Track whether we created the connection (vs injected) for cleanup
    let createdSql: ReturnType<typeof postgres> | null = null;

    try {
      log.debug("Initializing PostgreSQL persistence provider");

      // Create PostgreSQL connection (use injected client or create new one)
      const sql =
        deps?.sqlClient ??
        postgres(pgConfig.connectionString, {
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

      // All checks passed — now cache
      this.sql = sql;
      this.db = db;
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

  async initialize(): Promise<void> {
    // Initialize base PostgreSQL functionality first
    await super.initialize();

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
   * Get vector storage instance (type-safe - only exists on vector provider)
   */
  getVectorStorage(dimension: number): VectorStorage {
    if (!this.isInitialized) {
      throw new Error("PostgresVectorPersistenceProvider not initialized");
    }

    if (!this.sql || !this.db) {
      throw new Error("Database connections not available");
    }

    return new PostgresVectorStorage(this.sql, this.db, dimension, {
      tableName: "tasks_embeddings",
      idColumn: "task_id",
      embeddingColumn: "vector",
      lastIndexedAtColumn: "indexed_at",
    });
  }

  getConnectionInfo(): string {
    const baseInfo = super.getConnectionInfo();
    return baseInfo.replace("PostgreSQL:", "PostgreSQL (with vectors):");
  }
}
