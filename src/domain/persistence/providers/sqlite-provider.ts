/**
 * SQLite Persistence Provider
 *
 * Provides full SQLite database support through the persistence provider interface.
 */

import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import {
  PersistenceProvider,
  PersistenceCapabilities,
  PersistenceConfig,
  DatabaseStorage,
} from "../types";
import { SqliteStorage } from "../../storage/backends/sqlite-storage";
import type { SqliteStorageConfig } from "../../storage/backends/sqlite-storage";
import { log } from "../../../utils/logger";
import { mkdirSync, existsSync } from "fs";
import { dirname } from "path";

/**
 * SQLite persistence provider implementation
 */
export class SqlitePersistenceProvider extends PersistenceProvider {
  private config: PersistenceConfig;
  private db: Database | null = null;
  private drizzleDb: ReturnType<typeof drizzle> | null = null;
  private storage: SqliteStorage<any, any> | null = null;
  private isInitialized = false;

  /**
   * Capabilities of SQLite provider
   */
  readonly capabilities: PersistenceCapabilities = {
    sql: true,
    transactions: true,
    jsonb: false, // SQLite doesn't have native JSONB
    vectorStorage: false, // No vector extension for SQLite
    migrations: true,
  };

  constructor(config: PersistenceConfig) {
    super();
    if (config.backend !== "sqlite" || !config.sqlite) {
      throw new Error("SqlitePersistenceProvider requires sqlite configuration");
    }
    this.config = config;
  }

  /**
   * Initialize SQLite connection
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    try {
      if (!this.config.sqlite) {
        throw new Error("SQLite configuration required for sqlite backend");
      }

      const dbPath = this.config.sqlite.dbPath;
      log.debug(`Initializing SQLite persistence provider at ${dbPath}`);

      // Ensure directory exists
      const dbDir = dirname(dbPath);
      if (!existsSync(dbDir)) {
        mkdirSync(dbDir, { recursive: true });
      }

      // Open database with Bun's native SQLite driver
      this.db = new Database(dbPath);

      // Create Drizzle instance
      this.drizzleDb = drizzle(this.db);

      // Enable WAL mode for better performance
      this.db.exec("PRAGMA journal_mode = WAL;");
      this.db.exec("PRAGMA synchronous = NORMAL;");
      this.db.exec("PRAGMA cache_size = 1000;");
      this.db.exec("PRAGMA temp_store = memory;");
      this.db.exec("PRAGMA busy_timeout = 5000;");

      // Create storage instance
      const storageConfig: SqliteStorageConfig = {
        dbPath,
        enableWAL: true,
        timeout: 5000,
      };

      this.storage = new SqliteStorage(storageConfig);
      await this.storage.initialize();

      this.isInitialized = true;
      log.info(`SQLite database initialized: ${dbPath}`);
    } catch (error) {
      log.error("Failed to initialize SQLite provider:", error);
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
    if (!this.storage) {
      throw new Error("SqlitePersistenceProvider not initialized");
    }
    return this.storage as DatabaseStorage<T, S>;
  }

  /**
   * Get direct database connection
   */
  async getDatabaseConnection() {
    if (!this.isInitialized) {
      throw new Error("SqlitePersistenceProvider not initialized");
    }
    return this.drizzleDb;
  }

  /**
   * Get raw SQL connection for migrations and low-level operations
   */
  async getRawSqlConnection() {
    if (!this.isInitialized) {
      throw new Error("SqlitePersistenceProvider not initialized");
    }
    return this.db;
  }

  /**
   * Close database connections
   */
  async close(): Promise<void> {
    if (this.storage) {
      await this.storage.close();
      this.storage = null;
    }
    if (this.db) {
      this.db.close();
      this.db = null;
    }
    this.drizzleDb = null;
    this.isInitialized = false;
    log.debug("SQLite connections closed");
  }

  /**
   * Get connection information
   */
  getConnectionInfo(): string {
    if (!this.config.sqlite) {
      return "SQLite: Not configured";
    }

    return `SQLite: ${this.config.sqlite.dbPath} (${this.isInitialized ? "connected" : "disconnected"})`;
  }
}
