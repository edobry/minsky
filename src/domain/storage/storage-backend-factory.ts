/**
 * Storage Backend Factory
 *
 * This module provides a factory for creating different storage backends
 * based on configuration and environment settings, with optional integrity checking.
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
import {
  DatabaseIntegrityChecker,
  type DatabaseIntegrityResult,
} from "./database-integrity-checker";

/**
 * Available storage backend types
 */
export type StorageBackendType = "json" | "sqlite" | "postgres";

/**
 * Storage configuration options with integrity checking
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

  /**
   * Whether to perform integrity checking before creating storage backend
   */
  enableIntegrityCheck?: boolean;

  /**
   * Whether to prompt user for action when integrity issues are found
   */
  promptOnIntegrityIssues?: boolean;

  /**
   * Whether to automatically migrate when safe migrations are available
   */
  autoMigrate?: boolean;
}

/**
 * Result of storage backend creation with integrity information
 */
export interface StorageResult {
  storage: DatabaseStorage<SessionRecord, SessionDbState>;
  integrityResult?: DatabaseIntegrityResult;
  warnings: string[];
  autoMigrationPerformed?: boolean;
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
        (process.env as any).MINSKY_POSTGRES_URL || "postgresql://localhost:5432/minsky",
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
  if (configBackend && (["json", "sqlite", "postgres"] as any).includes(configBackend)) {
    (defaults as any).backend = configBackend;
  } else {
    const envBackend = (process.env as any).MINSKY_SESSION_BACKEND as StorageBackendType;
    if (envBackend && (["json", "sqlite", "postgres"] as any).includes(envBackend)) {
      (defaults as any).backend = envBackend;
    }
  }

  // Override SQLite path from node-config first, then environment
  if (configSqlitePath) {
    (defaults.sqlite! as any).dbPath = configSqlitePath;
  } else if ((process.env as any).MINSKY_SQLITE_PATH) {
    (defaults.sqlite! as any).dbPath = (process.env as any).MINSKY_SQLITE_PATH as any;
  }

  // Override PostgreSQL URL from node-config first, then environment
  if (configPostgresUrl) {
    (defaults.postgres! as any).connectionUrl = configPostgresUrl;
  } else if ((process.env as any).MINSKY_POSTGRES_URL) {
    (defaults.postgres! as any).connectionUrl = (process.env as any).MINSKY_POSTGRES_URL as any;
  }

  // Apply any additional overrides and set integrity defaults
  const result = {
    ...defaults,
    ...overrides,
  };

  // Set integrity checking defaults if not specified
  if (result.enableIntegrityCheck === undefined) {
    result.enableIntegrityCheck = true; // Enable by default for safety
  }
  if (result.promptOnIntegrityIssues === undefined) {
    result.promptOnIntegrityIssues = false;
  }
  if (result.autoMigrate === undefined) {
    result.autoMigrate = false;
  }

  return result;
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
    const dbPath =
        (storageConfig.json as any).filePath || (getDefaultStorageConfig().json! as any).filePath;
    const baseDir = getMinskyStateDir();
    return new JsonFileStorage(dbPath, baseDir);
  }

  case "sqlite": {
    const sqliteConfig: SqliteStorageConfig = {
      dbPath:
          (storageConfig.sqlite as any).dbPath ||
          (getDefaultStorageConfig().sqlite! as any).dbPath!,
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
            postgres: ["PostgreSQL connection URL"],
          }
      );
      throw new Error(errorMessage as any);
    }
    return createPostgresStorage((storageConfig as any).postgres);
  }

  default: {
    const errorMessage = createBackendDetectionErrorMessage((storageConfig as any).backend, [
      "json",
      "sqlite",
      "postgres",
    ] as any[]);
    throw new Error(errorMessage as any);
  }
  }
}

/**
 * Create storage backend with integrity checking
 */
export async function createStorageBackendWithIntegrity(
  config?: Partial<StorageConfig>
): Promise<StorageResult> {
  const storageConfig = loadStorageConfig(config);
  const result: StorageResult = {
    storage: null as any,
    warnings: [],
  };

  try {
    // Get file path for integrity checking
    const filePath = getFilePath(storageConfig);

    // Perform integrity check if enabled
    if (storageConfig.enableIntegrityCheck !== false && filePath) {
      log.debug("Performing database integrity check...");

      const integrityResult = await DatabaseIntegrityChecker.checkIntegrity(
        storageConfig.backend,
        filePath
      );

      result.integrityResult = integrityResult;

      // Handle integrity issues
      if (!integrityResult.isValid || integrityResult.issues.length > 0) {
        const handled = await handleIntegrityIssues(integrityResult, storageConfig);

        if (handled.autoMigrationPerformed) {
          result.autoMigrationPerformed = true;
        }

        if (handled.shouldContinue) {
          result.warnings.push(...integrityResult.warnings);
        } else {
          throw new Error(
            `Database integrity check failed:\n${DatabaseIntegrityChecker.formatIntegrityReport(integrityResult)}`
          );
        }
      }

      // Add warnings even if valid
      if (integrityResult.warnings.length > 0) {
        result.warnings.push(...integrityResult.warnings);
      }
    }

    // Create the actual storage backend
    result.storage = createStorageBackend(storageConfig);

    // Initialize the storage
    const initialized = await result.storage.initialize();
    if (!initialized) {
      throw new Error("Failed to initialize storage backend");
    }

    log.debug("Storage backend created successfully", {
      backend: storageConfig.backend,
      integrityChecked: storageConfig.enableIntegrityCheck !== false,
      warnings: result.warnings.length,
    });

    return result;
  } catch (error) {
    const errorMessage = getErrorMessage(error);
    log.error("Failed to create storage backend", { error: errorMessage });
    throw error;
  }
}

/**
 * Get file path for integrity checking
 */
function getFilePath(config: StorageConfig): string | null {
  switch (config.backend) {
  case "json":
    return config.json?.filePath || getDefaultJsonDbPath();
  case "sqlite":
    return config.sqlite?.dbPath || getDefaultSqliteDbPath();
  case "postgres":
    return null; // PostgreSQL doesn't have local file paths
  default:
    return null;
  }
}

/**
 * Handle integrity issues
 */
async function handleIntegrityIssues(
  integrityResult: DatabaseIntegrityResult,
  config: StorageConfig
): Promise<{ shouldContinue: boolean; autoMigrationPerformed: boolean }> {
  // For now, implement simple handling - in the future this could be more sophisticated
  if (config.autoMigrate && integrityResult.suggestedActions.some(action => action.autoExecutable)) {
    // Auto-migration logic would go here
    log.debug("Auto-migration would be performed here");
    return { shouldContinue: true, autoMigrationPerformed: false };
  }

  if (config.promptOnIntegrityIssues) {
    // In a real implementation, this would prompt the user
    log.warn("Database integrity issues found - would prompt user for action");
    return { shouldContinue: false, autoMigrationPerformed: false };
  }

  // By default, continue with warnings
  return { shouldContinue: true, autoMigrationPerformed: false };
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
   * Create or get cached storage backend (simple interface for backward compatibility)
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
   * Create or get cached storage backend with integrity checking
   */
  async getBackendWithIntegrity(config?: Partial<StorageConfig>): Promise<StorageResult> {
    const storageConfig = loadStorageConfig(config);
    const key = this.getBackendKey(storageConfig);

    if (!(this.backends as any).has(key)) {
      const result = await createStorageBackendWithIntegrity(storageConfig);
      (this.backends as any).set(key, result.storage);
      return result;
    }

    const cachedBackend = (this.backends as any).get(key);
    return {
      storage: cachedBackend,
      warnings: [],
    };
  }

  /**
   * Clear all cached backends
   */
  clearCache(): void {
    (this.backends as any).clear();
  }

  /**
   * Close all cached backends
   */
  async closeAll(): Promise<void> {
    for (const backend of (this.backends as any).values()) {
      try {
        if (backend && typeof backend.close === "function") {
          await backend.close();
        }
      } catch (error) {
        log.error("Error closing storage backend", { error: getErrorMessage(error as any) });
      }
    }
    this.clearCache();
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

/**
 * Create storage backend with strict integrity checking
 */
export async function createStrictStorageBackend(
  config?: Partial<StorageConfig>
): Promise<DatabaseStorage<SessionRecord, SessionDbState>> {
  const result = await createStorageBackendWithIntegrity({
    ...config,
    enableIntegrityCheck: true,
    autoMigrate: false,
  });

  if (result.warnings.length > 0) {
    log.warn("Storage backend created with warnings:", result.warnings);
  }

  return result.storage;
}

/**
 * Create storage backend with auto-migration enabled
 */
export async function createAutoMigratingStorageBackend(
  config?: Partial<StorageConfig>
): Promise<DatabaseStorage<SessionRecord, SessionDbState>> {
  const result = await createStorageBackendWithIntegrity({
    ...config,
    enableIntegrityCheck: true,
    autoMigrate: true,
  });

  if (result.autoMigrationPerformed) {
    log.debug("Auto-migration was performed during storage backend creation");
  }

  if (result.warnings.length > 0) {
    log.warn("Storage backend created with warnings:", result.warnings);
  }

  return result.storage;
}
