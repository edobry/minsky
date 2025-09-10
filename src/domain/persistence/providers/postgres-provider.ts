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
  DatabaseStorage,
  CapabilityNotSupportedError,
} from "../types";
import type { VectorStorage } from "../../storage/vector/types";
import { log } from "../../../utils/logger";
import { PostgresVectorStorage } from "../../storage/vector/postgres-vector-storage";

/**
 * PostgreSQL persistence provider implementation
 */
export class PostgresPersistenceProvider 
  extends PersistenceProvider 
  implements VectorCapablePersistenceProvider, SqlCapablePersistenceProvider {
  private db: PostgresJsDatabase | null = null;
  private sql: ReturnType<typeof postgres> | null = null;
  private config: PersistenceConfig;
  private isInitialized = false;

  /**
   * Capabilities of PostgreSQL provider (type-safe)
   */
  readonly capabilities = {
    sql: true,
    transactions: true,
    jsonb: true,
    vectorStorage: true,
    migrations: true,
  } as const;

  // Note: Capabilities are returned by getCapabilities() method below

  constructor(config: PersistenceConfig) {
    super();
    if (config.backend !== "postgres" || !config.postgres) {
      throw new Error("PostgresPersistenceProvider requires postgres configuration");
    }
    this.config = config;
  }

  /**
   * Initialize PostgreSQL connection
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    const pgConfig = this.config.postgres!;

    try {
      log.debug("Initializing PostgreSQL persistence provider");

      // Create PostgreSQL connection
      this.sql = postgres(pgConfig.connectionString, {
        max: pgConfig.maxConnections || 10,
        connect_timeout: pgConfig.connectTimeout || 10,
        idle_timeout: pgConfig.idleTimeout || 10,
        prepare: pgConfig.prepareStatements ?? false,
      });

      // Create Drizzle instance
      this.db = drizzle(this.sql);

      // Verify connection
      await this.sql`SELECT 1`;

      // Validate required pgvector extension (fail-fast for type safety)
      const result = await this.sql`
        SELECT EXISTS (
          SELECT 1 FROM pg_extension WHERE extname = 'vector'
        ) as exists
      `;
      
      if (!result[0].exists) {
        throw new Error(
          "PostgresPersistenceProvider requires pgvector extension, but it's not installed. " +
          "Install with: CREATE EXTENSION vector;"
        );
      }
      
      log.debug("pgvector extension verified");

      this.isInitialized = true;
      log.debug("PostgreSQL persistence provider initialized");
    } catch (error) {
      log.error("Failed to initialize PostgreSQL provider:", error);
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
  getStorage<T, S>(): DatabaseStorage<T, S> {
    if (!this.isInitialized) {
      throw new Error("PostgresPersistenceProvider not initialized");
    }

    // Return the actual PostgreSQL storage implementation
    const { PostgresStorage } = require("../../storage/backends/postgres-storage");
    const storage = new PostgresStorage({
      connectionString: this.config.postgres!.connectionString,
      maxConnections: this.config.postgres!.maxConnections || 10,
      connectTimeout: this.config.postgres!.connectTimeout || 30,
    });
    // Initialize the storage before returning
    storage.initialize().catch((err: any) => {
      log.error("Failed to initialize PostgreSQL storage:", err);
    });
    return storage as DatabaseStorage<T, S>;
  }

  /**
   * Get vector storage instance (type-safe - only exists on vector-capable providers)
   */
  getVectorStorage(dimension: number): VectorStorage {
    if (!this.isInitialized) {
      throw new Error("PostgresPersistenceProvider not initialized");
    }

    if (!this.sql || !this.db) {
      throw new Error("Database connections not available");
    }

    // Type system guarantees this provider supports vectors
    return new PostgresVectorStorage(this.sql, this.db, dimension, {
      tableName: "tasks_embeddings", 
      idColumn: "task_id",
      embeddingColumn: "vector",
      lastIndexedAtColumn: "indexed_at",
    });
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
      log.error("Failed to run migrations:", error);
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
      log.error("Error closing PostgreSQL connections:", error);
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
