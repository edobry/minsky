/**
 * Storage Backend Factory
 *
 * This module provides a factory for creating different storage backends
 * based on configuration and environment settings.
 */

import { join } from "path";
import { log } from "../../utils/logger";
import type { DatabaseStorage } from "./database-storage";
import type { SessionRecord, SessionDbState } from "../session/session-db";
import { JsonFileStorage } from "./backends/json-file-storage";
import { createSqliteStorage, type SqliteStorageConfig } from "./backends/sqlite-storage";
import { createPostgresStorage, type PostgresStorageConfig } from "./backends/postgres-storage";

/**
 * Available storage backend types
 */
export type StorageBackendType = "json" | "sqlite" | "postgres";

/**
 * Storage configuration options
 */
export interface StorageConfig {
  /**
   * Backend type to use
   */
  backend: StorageBackendType;

  /**
   * Configuration for JSON file storage
   */
  json?: {
    filePath?: string;
  };

  /**
   * Configuration for SQLite storage
   */
  sqlite?: Omit<SqliteStorageConfig, "dbPath"> & {
    dbPath?: string;
  };

  /**
   * Configuration for PostgreSQL storage
   */
  postgres?: PostgresStorageConfig;
}

/**
 * Default storage configuration
 */
export function getDefaultStorageConfig(): StorageConfig {
  const xdgStateHome = process.env.XDG_STATE_HOME || join(process.env.HOME || "", ".local/state");

  return {
    backend: "json",
    json: {
      filePath: join(xdgStateHome, "minsky", "session-db.json"),
    },
    sqlite: {
      dbPath: join(xdgStateHome, "minsky", "sessions.db"),
      enableWAL: true,
      timeout: 5000,
    },
    postgres: {
      connectionUrl: process.env.MINSKY_POSTGRES_URL || "postgresql://localhost:5432/minsky",
      maxConnections: 10,
      connectTimeout: 30,
      idleTimeout: 600,
    },
  };
}

/**
 * Load storage configuration from environment and config
 */
export function loadStorageConfig(overrides?: Partial<StorageConfig>): StorageConfig {
  const defaults = getDefaultStorageConfig();

  // Override backend from environment variable
  const envBackend = process.env.MINSKY_SESSION_BACKEND as StorageBackendType;
  if (envBackend && ["json", "sqlite", "postgres"].includes(envBackend)) {
    defaults.backend = envBackend;
  }

  // Override SQLite path from environment
  if (process.env.MINSKY_SQLITE_PATH) {
    defaults.sqlite!.dbPath = process.env.MINSKY_SQLITE_PATH;
  }

  // Override PostgreSQL URL from environment
  if (process.env.MINSKY_POSTGRES_URL) {
    defaults.postgres!.connectionUrl = process.env.MINSKY_POSTGRES_URL;
  }

  // Apply any additional overrides
  return {
    ...defaults,
    ...overrides,
  };
}

/**
 * Create a storage backend instance
 */
export function createStorageBackend(
  config?: Partial<StorageConfig>
): DatabaseStorage<SessionRecord, SessionDbState> {
  const storageConfig = loadStorageConfig(config);

  log.debug(`Creating storage backend: ${storageConfig.backend}`);

  switch (storageConfig.backend) {
  case "json":
    return new JsonFileStorage(
      storageConfig.json?.filePath || getDefaultStorageConfig().json!.filePath!
    );

  case "sqlite":
    const sqliteConfig: SqliteStorageConfig = {
      dbPath: storageConfig.sqlite?.dbPath || getDefaultStorageConfig().sqlite!.dbPath!,
      enableWAL: storageConfig.sqlite?.enableWAL ?? true,
      timeout: storageConfig.sqlite?.timeout ?? 5000,
    };
    return createSqliteStorage(sqliteConfig);

  case "postgres":
    if (!storageConfig.postgres?.connectionUrl) {
      throw new Error("PostgreSQL connection URL is required for postgres backend");
    }
    return createPostgresStorage(storageConfig.postgres);

  default:
    throw new Error(`Unsupported storage backend: ${storageConfig.backend}`);
  }
}

/**
 * Storage Backend Factory class for advanced usage
 */
export class StorageBackendFactory {
  private static instance: StorageBackendFactory;
  private backends: Map<string, DatabaseStorage<SessionRecord, SessionDbState>> = new Map();

  /**
   * Get singleton instance
   */
  static getInstance(): StorageBackendFactory {
    if (!StorageBackendFactory.instance) {
      StorageBackendFactory.instance = new StorageBackendFactory();
    }
    return StorageBackendFactory.instance;
  }

  /**
   * Create or get cached storage backend
   */
  getBackend(config?: Partial<StorageConfig>): DatabaseStorage<SessionRecord, SessionDbState> {
    const storageConfig = loadStorageConfig(config);
    const key = this.getBackendKey(storageConfig);

    if (!this.backends.has(key)) {
      const backend = createStorageBackend(storageConfig);
      this.backends.set(key, backend);
    }

    return this.backends.get(key)!;
  }

  /**
   * Clear all cached backends
   */
  clearCache(): void {
    this.backends.clear();
  }

  /**
   * Close all backends (for cleanup)
   */
  async closeAll(): Promise<void> {
    for (const backend of this.backends.values()) {
      try {
        // Try to close if the backend has a close method
        if ("close" in backend && typeof backend.close === "function") {
          await (backend as any).close();
        }
      } catch (error) {
        log.warn("Error closing storage backend:", error);
      }
    }
    this.backends.clear();
  }

  /**
   * Generate a unique key for backend caching
   */
  private getBackendKey(config: StorageConfig): string {
    switch (config.backend) {
    case "json":
      return `json:${config.json?.filePath}`;
    case "sqlite":
      return `sqlite:${config.sqlite?.dbPath}`;
    case "postgres":
      return `postgres:${config.postgres?.connectionUrl}`;
    default:
      return config.backend;
    }
  }
}
