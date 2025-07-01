/**
 * SessionDB Migration CLI Commands
 * 
 * Provides command-line interface for migrating session data between
 * different storage backends (JSON, SQLite, PostgreSQL).
 */

import { Command } from "commander";
import { MigrationService, MigrationOptions } from "../../domain/storage/migration/migration-service";
import { SessionDbConfig } from "../../domain/configuration/types";
import config from "config";
import { log } from "../../utils/logger";
import { join } from "path";
import { exit } from "../../utils/process.js";

export function createSessionDbMigrateCommand(): Command {
  const migrateCmd = new Command("migrate")
    .description("Migrate session database between storage backends")
    .addHelpText(
      "after",
      `
Examples:
  # Migrate from JSON to SQLite
  minsky sessiondb migrate --to sqlite --backup ./backups

  # Dry run migration to PostgreSQL
  minsky sessiondb migrate --to postgres --connection-string postgresql://user:pass@host/db --dry-run

  # Migrate with verification
  minsky sessiondb migrate --to sqlite --verify

  # Restore from backup
  minsky sessiondb restore --backup ./backups/session-backup-2025-01-20.json --to sqlite
`
    );

  // Main migrate command
  migrateCmd
    .command("to")
    .argument("<backend>", "Target backend (json, sqlite, postgres)")
    .option("--from <backend>", "Source backend (auto-detect if not specified)")
    .option("--sqlite-path <path>", "SQLite database file path")
    .option("--connection-string <url>", "PostgreSQL connection string")
    .option("--base-dir <path>", "Base directory for session workspaces")
    .option("--backup <path>", "Create backup in specified directory")
    .option("--dry-run", "Simulate migration without making changes")
    .option("--verify", "Verify migration after completion")
    .option("--json", "Output results in JSON format")
    .description("Migrate to specified backend")
    .action(async (targetBackend: string, options: any) => {
      try {
        await handleMigration(targetBackend, options);
      } catch (error) {
        console.error(`Migration failed: ${error instanceof Error ? error.message : String(error)}`);
        exit(1);
      }
    });

  // Restore from backup command
  migrateCmd
    .command("restore")
    .requiredOption("--backup <file>", "Backup file to restore from")
    .requiredOption("--to <backend>", "Target backend (json, sqlite, postgres)")
    .option("--sqlite-path <path>", "SQLite database file path")
    .option("--connection-string <url>", "PostgreSQL connection string")
    .option("--base-dir <path>", "Base directory for session workspaces")
    .option("--json", "Output results in JSON format")
    .description("Restore session database from backup")
    .action(async (options: any) => {
      try {
        await handleRestore(options);
      } catch (error) {
        console.error(`Restore failed: ${error instanceof Error ? error.message : String(error)}`);
        exit(1);
      }
    });

  // Status and recommendations command
  migrateCmd
    .command("status")
    .option("--json", "Output results in JSON format")
    .description("Show current backend status and migration recommendations")
    .action(async (options: any) => {
      try {
        await handleStatus(options);
      } catch (error) {
        console.error(`Status check failed: ${error instanceof Error ? error.message : String(error)}`);
        exit(1);
      }
    });

  return migrateCmd;
}

async function handleMigration(targetBackend: string, options: any): Promise<void> {
  // Validate target backend
  const validBackends = ["json", "sqlite", "postgres"];
  if (!validBackends.includes(targetBackend)) {
    throw new Error(`Invalid backend: ${targetBackend}. Valid options: ${validBackends.join(", ")}`);
  }

  // Load current configuration using node-config directly
  const currentConfig = config.get("sessiondb") as SessionDbConfig;

  // Determine source backend
  const sourceBackend = options.from || currentConfig.backend;
  if (sourceBackend === targetBackend) {
    console.log(`Already using ${targetBackend} backend. No migration needed.`);
    return;
  }

  // Build source and target configurations
  const sourceConfig: SessionDbConfig = {
    backend: sourceBackend,
    dbPath: currentConfig.dbPath,
    baseDir: currentConfig.baseDir,
    connectionString: currentConfig.connectionString,
  };

  const targetConfig: SessionDbConfig = {
    backend: targetBackend as "json" | "sqlite" | "postgres",
    dbPath: options.sqlitePath || generateDefaultPath(targetBackend),
    baseDir: options.baseDir || currentConfig.baseDir,
    connectionString: options.connectionString,
  };

  // Validate target configuration
  if (targetBackend === "postgres" && !targetConfig.connectionString) {
    throw new Error("PostgreSQL connection string is required (--connection-string)");
  }

  // Set up migration options
  const migrationOptions: MigrationOptions = {
    sourceConfig,
    targetConfig,
    backupPath: options.backup,
    dryRun: options.dryRun,
    verify: options.verify,
  };

  // Perform migration
  console.log(`\nMigrating session database: ${sourceBackend} → ${targetBackend}`);
  if (options.dryRun) {
    console.log("(DRY RUN - no changes will be made)\n");
  }

  const result = await MigrationService.migrate(migrationOptions);

  // Output results
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log("\n=== Migration Results ===");
    console.log(`Status: ${result.success ? "SUCCESS" : "FAILED"}`);
    console.log(`Records migrated: ${result.recordsMigrated}`);
    
    if (result.backupPath) {
      console.log(`Backup created: ${result.backupPath}`);
    }

    if (result.errors.length > 0) {
      console.log("\nErrors:");
      result.errors.forEach(error => console.log(`  - ${error}`));
    }

    if (result.warnings.length > 0) {
      console.log("\nWarnings:");
      result.warnings.forEach(warning => console.log(`  - ${warning}`));
    }

    if (result.verificationResult) {
      console.log("\n=== Verification Results ===");
      console.log(`Status: ${result.verificationResult.success ? "PASSED" : "FAILED"}`);
      console.log(`Source records: ${result.verificationResult.sourceCount}`);
      console.log(`Target records: ${result.verificationResult.targetCount}`);
      
      if (result.verificationResult.missingRecords.length > 0) {
        console.log(`Missing records: ${result.verificationResult.missingRecords.join(", ")}`);
      }
      
      if (result.verificationResult.inconsistencies.length > 0) {
        console.log("Inconsistencies:");
        result.verificationResult.inconsistencies.forEach(inc => console.log(`  - ${inc}`));
      }
    }

    if (result.success && !options.dryRun) {
      console.log("\n=== Next Steps ===");
      console.log("1. Update your configuration to use the new backend:");
      console.log(`   sessiondb.backend: "${targetBackend}"`);
      console.log("2. Test session operations to verify everything works");
      console.log("3. Remove old database files if no longer needed");
    }
  }
}

async function handleRestore(options: any): Promise<void> {
  const targetBackend = options.to;
  const validBackends = ["json", "sqlite", "postgres"];
  
  if (!validBackends.includes(targetBackend)) {
    throw new Error(`Invalid backend: ${targetBackend}. Valid options: ${validBackends.join(", ")}`);
  }

  // Build target configuration
  const targetConfig: SessionDbConfig = {
    backend: targetBackend,
    dbPath: options.sqlitePath || generateDefaultPath(targetBackend),
    baseDir: options.baseDir,
    connectionString: options.connectionString,
  };

  // Validate configuration
  if (targetBackend === "postgres" && !targetConfig.connectionString) {
    throw new Error("PostgreSQL connection string is required (--connection-string)");
  }

  console.log(`\nRestoring session database from: ${options.backup}`);
  console.log(`Target backend: ${targetBackend}\n`);

  const result = await MigrationService.restoreFromBackup(options.backup, targetConfig);

  // Output results
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log("\n=== Restore Results ===");
    console.log(`Status: ${result.success ? "SUCCESS" : "FAILED"}`);
    console.log(`Records restored: ${result.recordsMigrated}`);

    if (result.errors.length > 0) {
      console.log("\nErrors:");
      result.errors.forEach(error => console.log(`  - ${error}`));
    }

    if (result.success) {
      console.log("\n=== Next Steps ===");
      console.log("1. Update your configuration to use the restored backend");
      console.log("2. Test session operations to verify everything works");
    }
  }
}

async function handleStatus(options: any): Promise<void> {
  const currentConfig = config.get("sessiondb") as SessionDbConfig;

  const recommendations = MigrationService.getMigrationRecommendations(currentConfig);

  if (options.json) {
    console.log(JSON.stringify({
      currentBackend: currentConfig.backend,
      configuration: currentConfig,
      recommendations,
    }, null, 2));
  } else {
    console.log("\n=== SessionDB Status ===");
    console.log(`Current backend: ${currentConfig.backend}`);
    console.log(`Database path: ${currentConfig.dbPath || "default"}`);
    console.log(`Base directory: ${currentConfig.baseDir || "default"}`);
    
    if (currentConfig.connectionString) {
      console.log(`Connection: ${currentConfig.connectionString.replace(/:[^:@]*@/, ":***@")}`);
    }

    console.log("\n=== Recommendations ===");
    if (recommendations.length > 0) {
      recommendations.forEach(rec => console.log(`  - ${rec}`));
    } else {
      console.log("  No recommendations - current setup looks good!");
    }
  }
}

function generateDefaultPath(backend: string): string | undefined {
  const xdgStateHome = process.env.XDG_STATE_HOME || join(process.env.HOME || "", ".local/state");
  
  switch (backend) {
  case "sqlite":
    return join(xdgStateHome, "minsky", "sessions.db");
  case "json":
    return join(xdgStateHome, "minsky", "session-db.json");
  default:
    return undefined;
  }
} 
