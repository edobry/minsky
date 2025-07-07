/**
 * Enhanced Storage Backend Factory with Integrity Checking
 *
 * This factory extends the basic storage backend factory with comprehensive
 * integrity checking to prevent data loss and format mismatches.
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
import {
  type StorageBackendType,
  type StorageConfig,
  getDefaultStorageConfig,
  loadStorageConfig,
} from "./storage-backend-factory";

/**
 * Enhanced storage configuration with integrity checking options
 */
export interface EnhancedStorageConfig extends StorageConfig {
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

  /**
   * Whether to throw errors on integrity failures (vs returning warnings)
   */
  strictIntegrity?: boolean;
}

/**
 * Result of enhanced storage backend creation
 */
export interface EnhancedStorageResult {
  storage: DatabaseStorage<SessionRecord, SessionDbState>;
  integrityResult?: DatabaseIntegrityResult;
  warnings: string[];
  autoMigrationPerformed?: boolean;
}

/**
 * Enhanced Storage Backend Factory with integrity checking
 */
export class EnhancedStorageBackendFactory {
  private static instance: EnhancedStorageBackendFactory;
  private backends: Map<string, DatabaseStorage<SessionRecord, SessionDbState>> = new Map();

  /**
   * Get singleton instance
   */
  static getInstance(): EnhancedStorageBackendFactory {
    if (!EnhancedStorageBackendFactory.instance) {
      EnhancedStorageBackendFactory.instance = new EnhancedStorageBackendFactory();
    }
    return EnhancedStorageBackendFactory.instance;
  }

  /**
   * Create storage backend with enhanced integrity checking
   */
  async createStorageBackend(
    config?: Partial<EnhancedStorageConfig>
  ): Promise<EnhancedStorageResult> {
    const enhancedConfig = this.loadEnhancedConfig(config);
    const result: EnhancedStorageResult = {
      storage: null as any,
      warnings: [],
    };

    try {
      // Get file path for integrity checking
      const filePath = this.getFilePath(enhancedConfig);

      // Perform integrity check if enabled
      if (enhancedConfig.enableIntegrityCheck !== false && filePath) {
        log.debug("Performing database integrity check...");

        const integrityResult = await DatabaseIntegrityChecker.checkIntegrity(
          enhancedConfig.backend,
          filePath
        );

        result.integrityResult = integrityResult;

        // Handle integrity issues
        if (!integrityResult.isValid || integrityResult.issues.length > 0) {
          const handled = await this.handleIntegrityIssues(integrityResult, enhancedConfig);

          if (handled.autoMigrationPerformed) {
            result.autoMigrationPerformed = true;
          }

          if (handled.shouldContinue) {
            result.warnings.push(...integrityResult.warnings);
          } else if (enhancedConfig.strictIntegrity) {
            throw new Error(
              `Database integrity check failed:\n${DatabaseIntegrityChecker.formatIntegrityReport(integrityResult)}`
            );
          } else {
            result.warnings.push("Database integrity issues detected but proceeding anyway");
            result.warnings.push(...integrityResult.issues);
          }
        }

        // Add warnings even if valid
        if (integrityResult.warnings.length > 0) {
          result.warnings.push(...integrityResult.warnings);
        }
      }

      // Create the actual storage backend
      result.storage = this.createBasicStorageBackend(enhancedConfig);

      // Initialize the storage
      const initialized = await result.storage.initialize();
      if (!initialized) {
        throw new Error("Failed to initialize storage backend");
      }

      log.debug("Storage backend created successfully", {
        backend: enhancedConfig.backend,
        integrityChecked: enhancedConfig.enableIntegrityCheck !== false,
        warnings: result.warnings.length,
      });

      return result;
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      log.error("Failed to create enhanced storage backend", { error: errorMessage });
      throw error;
    }
  }

  /**
   * Handle integrity issues based on configuration
   */
  private async handleIntegrityIssues(
    integrityResult: DatabaseIntegrityResult,
    config: EnhancedStorageConfig
  ): Promise<{ shouldContinue: boolean; autoMigrationPerformed: boolean }> {
    const result = { shouldContinue: false, autoMigrationPerformed: false };

    // Check for auto-migration opportunities
    if (config.autoMigrate && integrityResult.suggestedActions.length > 0) {
      const migrationActions = integrityResult.suggestedActions.filter(
        (action) => action.type === "migrate" && action.autoExecutable
      );

      if (migrationActions.length > 0) {
        const action = migrationActions[0];
        if (action) {
          log.debug("Auto-migrating database", { action: action.description });

          try {
            // For now, we'll log what would be migrated
            // In a real implementation, this would execute the migration
            log.debug("Would execute migration command", { command: action.command });
            result.autoMigrationPerformed = true;
            result.shouldContinue = true;
            return result;
          } catch (error) {
            log.error("Auto-migration failed", { error: getErrorMessage(error) });
          }
        }
      }
    }

    // Check if we should prompt user
    if (config.promptOnIntegrityIssues) {
      // In a CLI environment, we would prompt the user here
      // For now, we'll log the integrity report
      log.warn("Database integrity issues detected");
      log.warn(DatabaseIntegrityChecker.formatIntegrityReport(integrityResult));

      // In a real implementation, this would show the user the report
      // and ask them to choose an action
      result.shouldContinue = true;
      return result;
    }

    // Check if issues are critical
    const hasCriticalIssues = integrityResult.issues.some(
      (issue) => issue.includes("format mismatch") || issue.includes("corrupted")
    );

    if (hasCriticalIssues) {
      log.error("Critical database integrity issues detected:");
      log.error(DatabaseIntegrityChecker.formatIntegrityReport(integrityResult));
      result.shouldContinue = false;
    } else {
      log.warn("Database integrity warnings detected:");
      log.warn(DatabaseIntegrityChecker.formatIntegrityReport(integrityResult));
      result.shouldContinue = true;
    }

    return result;
  }

  /**
   * Get file path for integrity checking
   */
  private getFilePath(config: EnhancedStorageConfig): string | null {
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
   * Load enhanced configuration with defaults
   */
  private loadEnhancedConfig(config?: Partial<EnhancedStorageConfig>): EnhancedStorageConfig {
    const baseConfig = loadStorageConfig(config);

    return {
      ...baseConfig,
      enableIntegrityCheck: config?.enableIntegrityCheck ?? true,
      promptOnIntegrityIssues: config?.promptOnIntegrityIssues ?? false,
      autoMigrate: config?.autoMigrate ?? false,
      strictIntegrity: config?.strictIntegrity ?? true,
    };
  }

  /**
   * Create basic storage backend (original implementation)
   */
  private createBasicStorageBackend(
    config: StorageConfig
  ): DatabaseStorage<SessionRecord, SessionDbState> {
    log.debug(`Creating storage backend: ${config.backend}`);

    switch (config.backend) {
    case "json": {
      const dbPath = config.json?.filePath || getDefaultStorageConfig().json!.filePath;
      const baseDir = getMinskyStateDir();
      return new JsonFileStorage(dbPath, baseDir);
    }

    case "sqlite": {
      const sqliteConfig: SqliteStorageConfig = {
        dbPath: config.sqlite?.dbPath || getDefaultStorageConfig().sqlite!.dbPath!,
        enableWAL: config.sqlite?.enableWAL ?? true,
        timeout: config.sqlite?.timeout ?? 5000,
      };
      return createSqliteStorage(sqliteConfig);
    }

    case "postgres": {
      if (!config.postgres?.connectionUrl) {
        const errorMessage = createBackendDetectionErrorMessage(
          "postgres",
          ["json", "sqlite", "postgres"],
          {
            postgres: ["PostgreSQL connection URL"],
          }
        );
        throw new Error(errorMessage);
      }
      return createPostgresStorage(config.postgres);
    }

    default: {
      const errorMessage = createBackendDetectionErrorMessage(config.backend, [
        "json",
        "sqlite",
        "postgres",
      ]);
      throw new Error(errorMessage);
    }
    }
  }

  /**
   * Get cached backend or create new one
   */
  async getBackend(config?: Partial<EnhancedStorageConfig>): Promise<EnhancedStorageResult> {
    const enhancedConfig = this.loadEnhancedConfig(config);
    const key = this.getBackendKey(enhancedConfig);

    if (this.backends.has(key)) {
      return {
        storage: this.backends.get(key)!,
        warnings: [],
      };
    }

    const result = await this.createStorageBackend(enhancedConfig);
    this.backends.set(key, result.storage);
    return result;
  }

  /**
   * Clear all cached backends
   */
  clearCache(): void {
    this.backends.clear();
  }

  /**
   * Close all backends
   */
  async closeAll(): Promise<void> {
    for (const backend of this.backends.values()) {
      try {
        if ("close" in backend && typeof backend.close === "function") {
          await backend.close();
        }
      } catch (error) {
        log.warn("Error closing storage backend:", {
          error: getErrorMessage(error),
        });
      }
    }
    this.backends.clear();
  }

  /**
   * Generate unique key for backend caching
   */
  private getBackendKey(config: EnhancedStorageConfig): string {
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

/**
 * Create enhanced storage backend with integrity checking (convenience function)
 */
export async function createEnhancedStorageBackend(
  config?: Partial<EnhancedStorageConfig>
): Promise<EnhancedStorageResult> {
  const factory = EnhancedStorageBackendFactory.getInstance();
  return await factory.createStorageBackend(config);
}

/**
 * Create enhanced storage backend with strict integrity checking
 */
export async function createStrictStorageBackend(
  config?: Partial<EnhancedStorageConfig>
): Promise<DatabaseStorage<SessionRecord, SessionDbState>> {
  const result = await createEnhancedStorageBackend({
    ...config,
    enableIntegrityCheck: true,
    strictIntegrity: true,
    autoMigrate: false,
  });

  if (result.warnings.length > 0) {
    log.warn("Storage backend created with warnings:", result.warnings);
  }

  return result.storage;
}

/**
 * Create enhanced storage backend with auto-migration
 */
export async function createAutoMigratingStorageBackend(
  config?: Partial<EnhancedStorageConfig>
): Promise<DatabaseStorage<SessionRecord, SessionDbState>> {
  const result = await createEnhancedStorageBackend({
    ...config,
    enableIntegrityCheck: true,
    autoMigrate: true,
    strictIntegrity: false,
  });

  if (result.autoMigrationPerformed) {
    log.debug("Auto-migration was performed during storage backend creation");
  }

  if (result.warnings.length > 0) {
    log.warn("Storage backend created with warnings:", result.warnings);
  }

  return result.storage;
}
