/**
 * SQLite Persistence Provider
 *
 * Local SQL database provider without vector support.
 */

import {
  PersistenceProvider,
  PersistenceCapabilities,
  PersistenceConfig,
  DatabaseStorage,
  CapabilityNotSupportedError,
} from "../types";
import type { VectorStorage } from "../../storage/vector/types";
import { log } from "../../../utils/logger";

/**
 * SQLite persistence provider implementation
 */
export class SqlitePersistenceProvider extends PersistenceProvider {
  private config: PersistenceConfig;
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
      log.debug(`Initializing SQLite persistence provider at ${this.config.sqlite!.dbPath}`);

      // TODO: Implement SQLite connection using better-sqlite3 or similar
      // For now, this is a stub implementation

      this.isInitialized = true;
      log.debug("SQLite persistence provider initialized");
    } catch (error) {
      log.error("Failed to initialize SQLite provider:", error);
      throw error;
    }
  }

  /**
   * Get storage instance for domain entities
   */
  getStorage<T, S>(): DatabaseStorage<T, S> {
    if (!this.isInitialized) {
      throw new Error("SqlitePersistenceProvider not initialized");
    }

    // Return a stub implementation
    return {
      get: async (id: string) => {
        throw new Error("SQLite storage not yet implemented");
      },
      save: async (id: string, data: T) => {
        throw new Error("SQLite storage not yet implemented");
      },
      update: async (id: string, updates: Partial<T>) => {
        throw new Error("SQLite storage not yet implemented");
      },
      delete: async (id: string) => {
        throw new Error("SQLite storage not yet implemented");
      },
      search: async (criteria: S) => {
        throw new Error("SQLite storage not yet implemented");
      },
    };
  }

  /**
   * Vector storage not supported by SQLite
   */
  async getVectorStorage(dimension: number): Promise<VectorStorage | null> {
    throw new CapabilityNotSupportedError("vectorStorage", "SQLite");
  }

  /**
   * Get direct database connection
   */
  async getDatabaseConnection(): Promise<null> {
    // TODO: Return actual SQLite connection when implemented
    return null;
  }

  /**
   * Get raw SQL connection for migrations and low-level operations
   */
  async getRawSqlConnection(): Promise<null> {
    // TODO: Return actual SQLite connection when implemented
    return null;
  }

  /**
   * Close database connections
   */
  async close(): Promise<void> {
    if (this.isInitialized) {
      // TODO: Close SQLite connection
      this.isInitialized = false;
      log.debug("SQLite connections closed");
    }
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
