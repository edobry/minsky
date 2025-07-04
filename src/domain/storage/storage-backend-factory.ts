/**
 * Storage Backend Factory
 *
 * This module provides a factory for creating different storage backends
 * based on configuration and environment settings.
 */

import { join } from "path";
import { log } from "../../utils/logger";
import { getErrorMessage } from "../../errors/index";
import type { SessionRecord, SessionDbState } from "../session/session-db";
import { JsonFileStorage } from "./backends/json-file-storage";
import { createPostgresStorage, type PostgresStorageConfig } from "./backends/postgres-storage";
import { createSqliteStorage, type SqliteStorageConfig } from "./backends/sqlite-storage";
import type { DatabaseStorage } from "./database-storage";
import { createBackendDetectionErrorMessage } from "../../errors/enhanced-error-templates";

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
  const xdgStateHome = (process.env as any).XDG_STATE_HOME || join((process.env as any).HOME || "", ".local/state");

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
      connectionUrl: (process.env as any).MINSKY_POSTGRES_URL || "postgresql://localhost:5432/minsky",
      maxConnections: 10,
      connectTimeout: 30,
      idleTimeout: 600,
    } as any,
  };
}

/**
 * Load storage configuration from environment and config
 */
export function loadStorageConfig(overrides?: Partial<StorageConfig>): StorageConfig {
  const defaults = getDefaultStorageConfig();

  // Override backend from environment variable
  const envBackend = (process.env as any).MINSKY_SESSION_BACKEND as StorageBackendType;
  if (envBackend && (["json", "sqlite", "postgres"] as any).includes(envBackend)) {
    (defaults as any).backend = envBackend;
  }

  // Override SQLite path from environment
  if ((process.env as any).MINSKY_SQLITE_PATH) {
    (defaults.sqlite! as any).dbPath = (process.env as any).MINSKY_SQLITE_PATH as any;
  }

  // Override PostgreSQL URL from environment
  if ((process.env as any).MINSKY_POSTGRES_URL) {
    (defaults.postgres! as any).connectionUrl = (process.env as any).MINSKY_POSTGRES_URL as any;
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
  const storageConfig = loadStorageConfig(config as any);

  log.debug(`Creating storage backend: ${(storageConfig as any).backend}`);

  switch ((storageConfig as any).backend) {
  case "json": {
    const dbPath = (storageConfig.json as any).filePath || (getDefaultStorageConfig().json! as any).filePath;
    const xdgStateHome = (process.env as any).XDG_STATE_HOME || join((process.env as any).HOME || "", ".local/state");
    const baseDir = join(xdgStateHome, "minsky");
    return new JsonFileStorage(dbPath, baseDir);
  }

  case "sqlite": {
    const sqliteConfig: SqliteStorageConfig = {
      dbPath: (storageConfig.sqlite as any).dbPath || (getDefaultStorageConfig().sqlite! as any).dbPath!,
      enableWAL: (storageConfig.sqlite as any).enableWAL ?? true,
      timeout: (storageConfig.sqlite as any).timeout ?? 5000,
    };
    return createSqliteStorage(sqliteConfig);
  }

  case "postgres": {
    if (!(storageConfig.postgres as any).connectionUrl) {
      const errorMessage = createBackendDetectionErrorMessage(
        "postgres",
        ["json", "sqlite", "postgres"] as any[],
        {
          "postgres": ["PostgreSQL connection URL"]
        }
      );
      throw new Error(errorMessage as any);
    }
    return createPostgresStorage((storageConfig as any).postgres);
  }

  default: {
    const errorMessage = createBackendDetectionErrorMessage(
      (storageConfig as any).backend,
      ["json", "sqlite", "postgres"] as any[]
    );
    throw new Error(errorMessage as any);
  }
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
    if (!(StorageBackendFactory as any).instance) {
      (StorageBackendFactory as any).instance = new StorageBackendFactory();
    }
    return (StorageBackendFactory as any).instance;
  }

  /**
   * Create or get cached storage backend
   */
  getBackend(config?: Partial<StorageConfig>): DatabaseStorage<SessionRecord, SessionDbState> {
    const storageConfig = loadStorageConfig(config as any);
    const key = this.getBackendKey(storageConfig);

    if (!(this.backends as any).has(key)) {
      const backend = createStorageBackend(storageConfig);
      (this.backends as any).set(key, backend);
    }

    return (this.backends as any).get(key);
  }

  /**
   * Clear all cached backends
   */
  clearCache(): void {
    (this.backends as any).clear();
  }

  /**
   * Close all backends (for cleanup)
   */
  async closeAll(): Promise<void> {
    for (const backend of (this.backends as any).values()) {
      try {
        // Try to close if the backend has a close method
        if ("close" in backend && typeof (backend as any).close === "function") {
          await (backend as any).close();
        }
      } catch (error) {
        log.warn("Error closing storage backend:", {
          error: getErrorMessage(error as any),
        });
      }
    }
    (this.backends as any).clear();
  }

  /**
   * Generate a unique key for backend caching
   */
  private getBackendKey(config: StorageConfig): string {
    switch ((config as any).backend) {
    case "json":
      return `json:${(config.json as any).filePath}`;
    case "sqlite":
      return `sqlite:${(config.sqlite as any).dbPath}`;
    case "postgres":
      return `postgres:${(config.postgres as any).connectionUrl}`;
    default:
      return (config as any).backend;
    }
  }
}
