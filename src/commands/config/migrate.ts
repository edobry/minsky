/**
 * minsky config migrate command
 *
 * Migrates legacy sessiondb configuration to modern persistence configuration
 */

import { Command } from "commander";
import { join } from "path";
import { existsSync } from "fs";
import { log } from "../../utils/logger";
import {
  migrateConfigurationFile,
  MigrationResult,
  validateMigration,
} from "../../utils/config-migration";
import { getConfiguration } from "../../domain/configuration";

interface MigrateOptions {
  dryRun?: boolean;
  backup?: boolean;
  format?: "yaml" | "json";
  configPath?: string;
  validate?: boolean;
}

/**
 * Dependencies for executeConfigMigrate - used for dependency injection in tests
 */
export interface ConfigMigrateDependencies {
  migrateConfigurationFile: typeof migrateConfigurationFile;
  getConfiguration: typeof getConfiguration;
  console: {
    log: (message: string) => void;
    warn: (message: string) => void;
    error: (message: string) => void;
  };
}

/**
 * Execute the config migrate action - extracted for testability
 */
export async function executeConfigMigrate(
  options: MigrateOptions,
  deps?: ConfigMigrateDependencies
): Promise<MigrationResult> {
  // Set up dependencies with defaults
  const dependencies = {
    migrateConfigurationFile: deps?.migrateConfigurationFile || migrateConfigurationFile,
    getConfiguration: deps?.getConfiguration || getConfiguration,
    console: deps?.console || console,
  };

  try {
    // Determine configuration file path
    let configPath = options.configPath;

    if (!configPath) {
      // Auto-detect configuration files
      const possiblePaths = [
        ".minsky/config.yaml",
        ".minsky/config.yml",
        ".minsky/config.json",
        "minsky.config.yaml",
        "minsky.config.yml",
        "minsky.config.json",
      ];

      for (const path of possiblePaths) {
        if (existsSync(path)) {
          configPath = path;
          break;
        }
      }

      if (!configPath) {
        throw new Error(
          "No configuration file found. Specify --config-path or create .minsky/config.yaml"
        );
      }
    }

    dependencies.console.log(`Found configuration file: ${configPath}`);

    // Determine format from file extension if not specified
    let format = options.format;
    if (!format) {
      format = configPath.endsWith(".json") ? "json" : "yaml";
    }

    // Perform migration
    const result = dependencies.migrateConfigurationFile(configPath, {
      dryRun: options.dryRun || false,
      backup: options.backup !== false, // default to true
      format,
    });

    // Display results
    displayMigrationResult(result, options.dryRun || false, dependencies.console);

    // Validate migration if requested
    if (options.validate && result.migrated && !options.dryRun) {
      await validateMigrationResult(configPath, dependencies);
    }

    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    dependencies.console.error(`Migration failed: ${message}`);
    throw error;
  }
}

/**
 * Display migration results to the console
 */
function displayMigrationResult(
  result: MigrationResult,
  dryRun: boolean,
  logger: { log: (msg: string) => void; warn: (msg: string) => void }
): void {
  if (dryRun) {
    logger.log("=== DRY RUN - No changes made ===");
  }

  if (!result.hasLegacyConfig) {
    logger.log("✅ No sessiondb configuration found - no migration needed");
    return;
  }

  if (result.hasModernConfig && result.hasLegacyConfig) {
    logger.warn("⚠️  Both sessiondb and persistence configurations exist");
    logger.warn("   Manual review recommended after migration");
  }

  if (result.migrated && !dryRun) {
    logger.log("✅ Configuration migrated successfully");
    if (result.backupPath) {
      logger.log(`📁 Backup created: ${result.backupPath}`);
    }
  } else if (dryRun) {
    logger.log("✅ Migration validation successful - ready to migrate");
  }

  if (result.changes.length > 0) {
    logger.log("\n📋 Changes applied:");
    for (const change of result.changes) {
      logger.log(`   • ${change}`);
    }
  }

  if (result.warnings.length > 0) {
    logger.log("\n⚠️  Warnings:");
    for (const warning of result.warnings) {
      logger.warn(`   • ${warning}`);
    }
  }

  if (!dryRun && result.migrated) {
    logger.log("\n🔄 Next steps:");
    logger.log("   1. Verify your application still works with the new configuration");
    logger.log("   2. Remove the sessiondb configuration block once you're confident");
    logger.log("   3. Update any documentation to use 'persistence:' instead of 'sessiondb:'");
  }
}

/**
 * Validate the migration by loading the new configuration
 */
async function validateMigrationResult(
  configPath: string,
  deps: ConfigMigrateDependencies
): Promise<void> {
  try {
    deps.console.log("\n🔍 Validating migrated configuration...");

    // Try to load the configuration
    const config = deps.getConfiguration();

    if (config.persistence) {
      deps.console.log("✅ New persistence configuration loaded successfully");
      deps.console.log(`   Backend: ${config.persistence.backend}`);
    } else {
      deps.console.warn("⚠️  Could not find persistence configuration in loaded config");
    }

    // Check if sessiondb still exists (expected during transition)
    if (config.sessiondb) {
      deps.console.log("ℹ️  Legacy sessiondb configuration still present (OK during transition)");
    }
  } catch (error) {
    deps.console.error(`❌ Validation failed: ${error}`);
    throw error;
  }
}

/**
 * Create the CLI command
 */
export function createConfigMigrateCommand(): Command {
  const cmd = new Command("migrate");

  cmd
    .description("Migrate sessiondb configuration to persistence configuration")
    .option("--dry-run", "Preview changes without applying them", false)
    .option("--no-backup", "Skip creating backup file", false)
    .option("--format <format>", "Configuration format (yaml|json)", undefined)
    .option("--config-path <path>", "Path to configuration file", undefined)
    .option("--validate", "Validate configuration after migration", false)
    .action(async (options: MigrateOptions) => {
      try {
        const result = await executeConfigMigrate(options);
        process.exit(result.migrated || options.dryRun ? 0 : 1);
      } catch (error) {
        log.error("Config migration failed:", error);
        process.exit(1);
      }
    });

  // Add examples
  cmd.addHelpText(
    "after",
    `

Examples:
  minsky config migrate --dry-run           Preview migration changes
  minsky config migrate                     Migrate configuration with backup
  minsky config migrate --no-backup        Migrate without creating backup
  minsky config migrate --validate         Migrate and validate the result
  minsky config migrate --config-path ./custom-config.yaml

Migration Details:
  • Converts sessiondb: blocks to persistence: blocks
  • Maintains backward compatibility during transition
  • Creates backups by default for safety
  • Validates configuration structure

Legacy sessiondb configuration:
  sessiondb:
    backend: postgres
    connectionString: postgresql://...

New persistence configuration:  
  persistence:
    backend: postgres
    postgres:
      connectionString: postgresql://...
      maxConnections: 10
      connectTimeout: 30000
`
  );

  return cmd;
}

// Export types for testing
export type { MigrateOptions, ConfigMigrateDependencies };
