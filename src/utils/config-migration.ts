/**
 * Configuration Migration Utility
 *
 * Converts legacy sessiondb configuration blocks to the modern persistence configuration.
 * This migration utility ensures backward compatibility during the transition period.
 */

import { z } from "zod";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import * as yaml from "js-yaml";
import { log } from "./logger";

/**
 * Legacy SessionDB configuration schema (for validation)
 */
const legacySessionDbSchema = z.object({
  backend: z.enum(["sqlite", "postgres"]).default("sqlite"),
  baseDir: z.string().optional(),
  dbPath: z.string().optional(),
  connectionString: z.string().optional(),
  sqlite: z
    .object({
      path: z.string().optional(),
      baseDir: z.string().optional(),
    })
    .optional(),
  postgres: z
    .object({
      connectionString: z.string(),
    })
    .optional(),
});

/**
 * Modern persistence configuration schema (target)
 */
const persistenceConfigSchema = z.object({
  backend: z.enum(["postgres", "sqlite", "json"]),
  postgres: z
    .object({
      connectionString: z.string(),
      maxConnections: z.number().min(1).max(100).optional(),
      connectTimeout: z.number().min(1000).max(300000).optional(),
      idleTimeout: z.number().min(1000).max(600000).optional(),
      prepareStatements: z.boolean().optional(),
    })
    .optional(),
  sqlite: z
    .object({
      dbPath: z.string(),
    })
    .optional(),
  json: z
    .object({
      filePath: z.string(),
    })
    .optional(),
});

export interface MigrationResult {
  migrated: boolean;
  hasLegacyConfig: boolean;
  hasModernConfig: boolean;
  backupPath?: string;
  changes: string[];
  warnings: string[];
}

/**
 * Migrate sessiondb configuration to persistence configuration
 */
export function migrateSessionDbToPersistence(sessiondbConfig: any): any {
  const changes: string[] = [];
  const warnings: string[] = [];

  // Parse and validate legacy config
  let validated;
  try {
    validated = legacySessionDbSchema.parse(sessiondbConfig);
  } catch (error) {
    throw new Error(`Invalid sessiondb configuration: ${error}`);
  }

  const { backend } = validated;
  const persistenceConfig: any = {
    backend,
  };

  if (backend === "postgres") {
    // Migrate PostgreSQL configuration
    const connectionString = validated.postgres?.connectionString || validated.connectionString;

    if (!connectionString) {
      throw new Error("PostgreSQL backend requires connectionString");
    }

    persistenceConfig.postgres = {
      connectionString,
      maxConnections: 10, // Set sensible defaults
      connectTimeout: 30000, // 30 seconds
      idleTimeout: 10000, // 10 seconds
      prepareStatements: true,
    };

    changes.push("Migrated PostgreSQL configuration");
    if (validated.connectionString && !validated.postgres?.connectionString) {
      changes.push("Moved top-level connectionString to postgres.connectionString");
    }
  } else if (backend === "sqlite") {
    // Migrate SQLite configuration
    let dbPath = validated.sqlite?.path || validated.dbPath;

    if (!dbPath) {
      // Use default path based on baseDir or standard location
      const baseDir = validated.sqlite?.baseDir || validated.baseDir;
      if (baseDir) {
        dbPath = join(baseDir, "minsky.db");
        warnings.push(`Using computed dbPath: ${dbPath}`);
      } else {
        dbPath = "~/.local/state/minsky/minsky.db";
        warnings.push("Using default SQLite path");
      }
    }

    persistenceConfig.sqlite = {
      dbPath,
    };

    changes.push("Migrated SQLite configuration");
    if (validated.dbPath && !validated.sqlite?.path) {
      changes.push("Moved top-level dbPath to sqlite.dbPath");
    }
    if (validated.baseDir || validated.sqlite?.baseDir) {
      changes.push("Computed dbPath from baseDir (baseDir is no longer used directly)");
    }
  }

  return { config: persistenceConfig, changes, warnings };
}

/**
 * Migrate a complete configuration file from sessiondb to persistence
 */
export function migrateConfigurationFile(
  configPath: string,
  options: {
    dryRun?: boolean;
    backup?: boolean;
    format?: "yaml" | "json";
  } = {}
): MigrationResult {
  const { dryRun = false, backup = true, format = "yaml" } = options;

  if (!existsSync(configPath)) {
    throw new Error(`Configuration file not found: ${configPath}`);
  }

  // Read and parse existing configuration
  const configContent = readFileSync(configPath, "utf-8");
  let config: any;

  try {
    if (format === "yaml") {
      config = yaml.load(configContent) as any;
    } else {
      config = JSON.parse(configContent);
    }
  } catch (error) {
    throw new Error(`Failed to parse configuration file: ${error}`);
  }

  const result: MigrationResult = {
    migrated: false,
    hasLegacyConfig: !!config.sessiondb,
    hasModernConfig: !!config.persistence,
    changes: [],
    warnings: [],
  };

  // Check if migration is needed
  if (!result.hasLegacyConfig) {
    result.warnings.push("No sessiondb configuration found to migrate");
    return result;
  }

  if (result.hasModernConfig) {
    result.warnings.push(
      "Both sessiondb and persistence configurations exist. Manual review recommended."
    );
  }

  // Perform migration
  try {
    const migrationResult = migrateSessionDbToPersistence(config.sessiondb);

    // Create new configuration
    const newConfig = { ...config };
    newConfig.persistence = migrationResult.config;

    // Add deprecation comment to sessiondb block
    if (!newConfig.persistence) {
      newConfig.persistence = migrationResult.config;
    }

    result.changes = migrationResult.changes;
    result.warnings.push(...migrationResult.warnings);

    if (!dryRun) {
      // Create backup if requested
      if (backup) {
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        const backupPath = `${configPath}.backup-${timestamp}`;
        writeFileSync(backupPath, configContent);
        result.backupPath = backupPath;
        log.info(`Backup created: ${backupPath}`);
      }

      // Write new configuration
      let newContent: string;
      if (format === "yaml") {
        newContent = yaml.dump(newConfig, {
          indent: 2,
          quotingType: '"',
          forceQuotes: false,
        });
      } else {
        newContent = JSON.stringify(newConfig, null, 2);
      }

      writeFileSync(configPath, newContent);
      result.migrated = true;
      log.info(`Migrated configuration file: ${configPath}`);
    }

    return result;
  } catch (error) {
    throw new Error(`Migration failed: ${error}`);
  }
}

/**
 * Validate that a persistence configuration is equivalent to a sessiondb configuration
 */
export function validateMigration(sessiondbConfig: any, persistenceConfig: any): boolean {
  try {
    const legacyValidated = legacySessionDbSchema.parse(sessiondbConfig);
    const modernValidated = persistenceConfigSchema.parse(persistenceConfig);

    // Check backend consistency
    if (legacyValidated.backend !== modernValidated.backend) {
      return false;
    }

    // Backend-specific validation
    if (modernValidated.backend === "postgres") {
      const legacyConnectionString =
        legacyValidated.postgres?.connectionString || legacyValidated.connectionString;
      const modernConnectionString = modernValidated.postgres?.connectionString;

      return legacyConnectionString === modernConnectionString;
    }

    if (modernValidated.backend === "sqlite") {
      const legacyPath = legacyValidated.sqlite?.path || legacyValidated.dbPath;
      const modernPath = modernValidated.sqlite?.dbPath;

      // Allow computed paths for baseDir migration
      if (legacyPath) {
        return legacyPath === modernPath;
      }

      // Check if baseDir was used to compute path
      const baseDir = legacyValidated.sqlite?.baseDir || legacyValidated.baseDir;
      if (baseDir) {
        const expectedPath = join(baseDir, "minsky.db");
        return expectedPath === modernPath;
      }

      // Default path migration
      return modernPath === "~/.local/state/minsky/minsky.db";
    }

    return true;
  } catch (error) {
    log.error("Migration validation error:", error);
    return false;
  }
}

export type { MigrationResult };
