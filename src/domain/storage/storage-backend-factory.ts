/**
 * Storage Backend Factory
 *
 * This module provides a factory for creating different storage backends
 * based on configuration and environment settings.
 */

import { join } from "path";
import { log } from "../../utils/logger";
import { getErrorMessage } from "../../errors/index";
import { getMinskyStateDir, getDefaultJsonDbPath, getDefaultSqliteDbPath } from "../../utils/paths";
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
  return {
    backend: "json",
    json: {
      filePath: getDefaultJsonDbPath(),
    },
    sqlite: {
      dbPath: getDefaultSqliteDbPath(),
      enableWAL: true,
      timeout: 5000,
    },
    postgres: {
      connectionUrl:
        (process.env as unknown).MINSKY_POSTGRES_URL || "postgresql://localhost:5432/minsky",
      maxConnections: 10,
      connectTimeout: 30,
      idleTimeout: 600,
    } as unknown,
  };
}

/**
 * Load storage configuration from environment and config
 */
export function loadStorageConfig(overrides?: Partial<StorageConfig>): StorageConfig {
  const defaults = getDefaultStorageConfig();

  // First, try to get configuration from node-config
  let configBackend: string | undefined;
  let configSqlitePath: string | undefined;
  let configPostgresUrl: string | undefined;

  try {
    const config = require("config");
    if (config.has("sessiondb")) {
      const sessiondbConfig = config.get("sessiondb");
      configBackend = sessiondbConfig.backend;
      configSqlitePath = sessiondbConfig.dbPath;
      configPostgresUrl = sessiondbConfig.connectionString;
    }
  } catch (error) {
    // node-config not available or misconfigured, continue with environment variables
  }

  // Override backend from node-config first, then environment variable
  if (configBackend && (["json", "sqlite", "postgres"] as unknown).includes(configBackend)) {
    (defaults as unknown).backend = configBackend;
  } else {
    const envBackend = (process.env as unknown).MINSKY_SESSION_BACKEND as StorageBackendType;
    if (envBackend && (["json", "sqlite", "postgres"] as unknown).includes(envBackend)) {
      (defaults as unknown).backend = envBackend;
    }
  }

  // Override SQLite path from node-config first, then environment
  if (configSqlitePath) {
    (defaults.sqlite! as unknown).dbPath = configSqlitePath;
  } else if ((process.env as unknown).MINSKY_SQLITE_PATH) {
    (defaults.sqlite! as unknown).dbPath = (process.env as unknown).MINSKY_SQLITE_PATH as unknown;
  }

  // Override PostgreSQL URL from node-config first, then environment
  if (configPostgresUrl) {
    (defaults.postgres! as unknown).connectionUrl = configPostgresUrl;
  } else if ((process.env as unknown).MINSKY_POSTGRES_URL) {
    (defaults.postgres! as unknown).connectionUrl = (process.env as unknown).MINSKY_POSTGRES_URL as unknown;
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
  const storageConfig = loadStorageConfig(config as unknown);

  log.debug(`Creating storage backend: ${(storageConfig as unknown).backend}`);

  switch ((storageConfig as unknown).backend) {
  case "json": {
    const dbPath =
        (storageConfig.json as unknown).filePath || (getDefaultStorageConfig().json! as unknown).filePath;
    const baseDir = getMinskyStateDir();
    return new JsonFileStorage(dbPath, baseDir);
  }

  case "sqlite": {
    const sqliteConfig: SqliteStorageConfig = {
      dbPath:
          (storageConfig.sqlite as unknown).dbPath ||
          (getDefaultStorageConfig().sqlite! as unknown).dbPath!,
      enableWAL: (storageConfig.sqlite as unknown).enableWAL ?? true,
      timeout: (storageConfig.sqlite as unknown).timeout ?? 5000,
    };
    return createSqliteStorage(sqliteConfig);
  }

  case "postgres": {
    if (!(storageConfig.postgres as unknown).connectionUrl) {
      const errorMessage = createBackendDetectionErrorMessage(
        "postgres",
          ["json", "sqlite", "postgres"] as any[],
          {
            postgres: ["PostgreSQL connection URL"],
          }
      );
      throw new Error(errorMessage as unknown);
    }
    return createPostgresStorage((storageConfig as unknown).postgres);
  }

  default: {
    const errorMessage = createBackendDetectionErrorMessage((storageConfig as unknown).backend, [
      "json",
      "sqlite",
      "postgres",
    ] as any[]);
    throw new Error(errorMessage as unknown);
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
    if (!(StorageBackendFactory as unknown).instance) {
      (StorageBackendFactory as unknown).instance = new StorageBackendFactory();
    }
    return (StorageBackendFactory as unknown).instance;
  }

  /**
   * Create or get cached storage backend
   */
  getBackend(config?: Partial<StorageConfig>): DatabaseStorage<SessionRecord, SessionDbState> {
    const storageConfig = loadStorageConfig(config as unknown);
    const key = this.getBackendKey(storageConfig);

    if (!(this.backends as unknown).has(key)) {
      const backend = createStorageBackend(storageConfig);
      (this.backends as unknown).set(key, backend);
    }

    return (this.backends as unknown).get(key);
  }

  /**
   * Clear all cached backends
   */
  clearCache(): void {
    (this.backends as unknown).clear();
  }

  /**
   * Close all backends (for cleanup)
   */
  async closeAll(): Promise<void> {
    for (const backend of (this.backends as unknown).values()) {
      try {
        // Try to close if the backend has a close method
        if ("close" in backend && typeof (backend as unknown).close === "function") {
          await (backend as unknown).close();
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
    switch ((config as unknown).backend) {
    case "json":
      return `json:${(config.json as unknown).filePath}`;
    case "sqlite":
      return `sqlite:${(config.sqlite as unknown).dbPath}`;
    case "postgres":
      return `postgres:${(config.postgres as unknown).connectionUrl}`;
    default:
      return (config as unknown).backend;
    }
  }
}
