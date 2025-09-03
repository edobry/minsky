/**
 * Shared Database Service
 *
 * Centralized service for managing database connections and providing
 * typed access to different domains (sessions, tasks, embeddings).
 * This service replaces individual connection management across the codebase.
 */

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { log } from "../../utils/logger";
import { getConfiguration } from "../configuration";

/**
 * Database connection configuration
 */
export interface DatabaseConfig {
  connectionString: string;
  maxConnections?: number;
  connectTimeout?: number;
  idleTimeout?: number;
  prepareStatements?: boolean;
}

/**
 * Migration configuration
 */
export interface MigrationConfig {
  migrationsFolder: string;
  runOnInit?: boolean;
}

/**
 * Shared database service configuration
 */
export interface SharedDatabaseConfig {
  database: DatabaseConfig;
  migrations?: MigrationConfig;
}

/**
 * Database connection information for monitoring
 */
export interface DatabaseConnectionInfo {
  isConnected: boolean;
  connectionString: string;
  poolSize: number;
  activeConnections?: number;
}

/**
 * Shared database service interface
 * Provides typed access to database connections for different domains
 */
export interface ISharedDatabaseService {
  /**
   * Get the Drizzle database instance
   */
  getDatabase(): Promise<PostgresJsDatabase>;

  /**
   * Get the raw Postgres SQL instance
   * Should be used sparingly, prefer getDatabase() for type safety
   */
  getSql(): Promise<ReturnType<typeof postgres>>;

  /**
   * Run database migrations
   */
  runMigrations(): Promise<void>;

  /**
   * Check if migrations are pending
   */
  hasPendingMigrations(): Promise<{
    pending: boolean;
    appliedCount: number;
    fileCount: number;
  }>;

  /**
   * Get connection information for monitoring
   */
  getConnectionInfo(): DatabaseConnectionInfo;

  /**
   * Close all database connections
   */
  close(): Promise<void>;

  /**
   * Test the database connection
   */
  testConnection(): Promise<boolean>;
}

/**
 * Shared database service implementation
 */
export class SharedDatabaseService implements ISharedDatabaseService {
  private static instance: SharedDatabaseService | null = null;

  private sql: ReturnType<typeof postgres> | null = null;
  private db: PostgresJsDatabase | null = null;
  private config: SharedDatabaseConfig;
  private isInitialized = false;

  private constructor(config?: SharedDatabaseConfig) {
    // Use provided config or load from configuration
    this.config = config || this.loadConfig();
  }

  /**
   * Get singleton instance of the service
   */
  static getInstance(config?: SharedDatabaseConfig): SharedDatabaseService {
    if (!SharedDatabaseService.instance) {
      SharedDatabaseService.instance = new SharedDatabaseService(config);
    }
    return SharedDatabaseService.instance;
  }

  /**
   * Reset singleton instance (primarily for testing)
   */
  static resetInstance(): void {
    if (SharedDatabaseService.instance) {
      SharedDatabaseService.instance.close().catch(() => {
        // Ignore errors during reset
      });
    }
    SharedDatabaseService.instance = null;
  }

  /**
   * Load configuration from runtime config
   */
  private loadConfig(): SharedDatabaseConfig {
    const runtimeConfig = getConfiguration();
    const connectionString = runtimeConfig?.sessiondb?.postgres?.connectionString;

    if (!connectionString) {
      throw new Error(
        "PostgreSQL connection string not configured (sessiondb.postgres.connectionString)"
      );
    }

    return {
      database: {
        connectionString,
        maxConnections: 10,
        connectTimeout: 30,
        idleTimeout: 600,
        prepareStatements: false,
      },
      migrations: {
        migrationsFolder: "./src/domain/storage/migrations/pg",
        runOnInit: false,
      },
    };
  }

  /**
   * Initialize the database connection
   */
  private async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    try {
      log.debug("Initializing shared database connection");

      // Create Postgres connection
      this.sql = postgres(this.config.database.connectionString, {
        max: this.config.database.maxConnections || 10,
        connect_timeout: this.config.database.connectTimeout || 30,
        idle_timeout: this.config.database.idleTimeout || 600,
        prepare: this.config.database.prepareStatements || false,
        onnotice: () => {}, // Suppress NOTICE messages
      });

      // Create Drizzle instance
      this.db = drizzle(this.sql);

      // Run migrations if configured
      if (this.config.migrations?.runOnInit) {
        await this.runMigrations();
      }

      this.isInitialized = true;
      log.debug("Shared database connection initialized successfully");
    } catch (error) {
      log.error("Failed to initialize shared database connection:", error);
      throw new Error(`Database initialization failed: ${error}`);
    }
  }

  /**
   * Get the Drizzle database instance
   */
  async getDatabase(): Promise<PostgresJsDatabase> {
    if (!this.isInitialized) {
      await this.initialize();
    }

    if (!this.db) {
      throw new Error("Database not initialized");
    }

    return this.db;
  }

  /**
   * Get the raw Postgres SQL instance
   */
  async getSql(): Promise<ReturnType<typeof postgres>> {
    if (!this.isInitialized) {
      await this.initialize();
    }

    if (!this.sql) {
      throw new Error("SQL connection not initialized");
    }

    return this.sql;
  }

  /**
   * Run database migrations
   */
  async runMigrations(): Promise<void> {
    const db = await this.getDatabase();

    if (!this.config.migrations?.migrationsFolder) {
      throw new Error("Migrations folder not configured");
    }

    try {
      log.info(`Running migrations from ${this.config.migrations.migrationsFolder}`);
      await migrate(db, {
        migrationsFolder: this.config.migrations.migrationsFolder,
      });
      log.info("Migrations completed successfully");
    } catch (error) {
      log.error("Migration failed:", error);
      throw new Error(`Migration failed: ${error}`);
    }
  }

  /**
   * Check if migrations are pending
   */
  async hasPendingMigrations(): Promise<{
    pending: boolean;
    appliedCount: number;
    fileCount: number;
  }> {
    const sql = await this.getSql();

    // Count migration files
    const migrationsFolder =
      this.config.migrations?.migrationsFolder || "./src/domain/storage/migrations/pg";
    let fileCount = 0;

    try {
      const fs = await import("fs");
      const entries = fs.readdirSync(migrationsFolder);
      fileCount = entries.filter((name) => name.endsWith(".sql")).length;
    } catch {
      fileCount = 0;
    }

    // Check if migrations table exists
    const existsRes = await sql<{ exists: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'drizzle' AND table_name = '__drizzle_migrations'
      ) as exists;
    `;
    const metaExists = Boolean(existsRes?.[0]?.exists);

    if (!metaExists) {
      return { pending: fileCount > 0, appliedCount: 0, fileCount };
    }

    // Count applied migrations
    const countRes = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text as count FROM "drizzle"."__drizzle_migrations";
    `;
    const appliedCount = parseInt(countRes?.[0]?.count || "0", 10);

    return {
      pending: appliedCount < fileCount,
      appliedCount,
      fileCount,
    };
  }

  /**
   * Get connection information for monitoring
   */
  getConnectionInfo(): DatabaseConnectionInfo {
    const masked = (() => {
      try {
        const url = new URL(this.config.database.connectionString);
        return `postgresql://${url.host}${url.pathname}`;
      } catch {
        return "postgresql://<redacted>";
      }
    })();

    return {
      isConnected: this.isInitialized,
      connectionString: masked,
      poolSize: this.config.database.maxConnections || 10,
    };
  }

  /**
   * Close all database connections
   */
  async close(): Promise<void> {
    if (this.sql) {
      try {
        await this.sql.end();
      } catch (error) {
        log.error("Error closing database connections:", error);
      }
    }

    this.sql = null;
    this.db = null;
    this.isInitialized = false;
  }

  /**
   * Test the database connection
   */
  async testConnection(): Promise<boolean> {
    try {
      const sql = await this.getSql();
      const result = await sql`SELECT 1 as test`;
      return result?.[0]?.test === 1;
    } catch (error) {
      log.error("Database connection test failed:", error);
      return false;
    }
  }
}

/**
 * Get the shared database service instance
 * Using a getter function to avoid immediate initialization
 */
export function getSharedDatabaseService(): ISharedDatabaseService {
  return SharedDatabaseService.getInstance();
}

/**
 * Convenience export for backward compatibility
 * @deprecated Use getSharedDatabaseService() instead
 */
export const sharedDatabaseService = {
  getDatabase: () => getSharedDatabaseService().getDatabase(),
  getSql: () => getSharedDatabaseService().getSql(),
  runMigrations: () => getSharedDatabaseService().runMigrations(),
  hasPendingMigrations: () => getSharedDatabaseService().hasPendingMigrations(),
  getConnectionInfo: () => getSharedDatabaseService().getConnectionInfo(),
  close: () => getSharedDatabaseService().close(),
  testConnection: () => getSharedDatabaseService().testConnection(),
};
