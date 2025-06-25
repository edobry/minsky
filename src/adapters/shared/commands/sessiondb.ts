/**
 * Shared SessionDB Commands
 *
 * This module contains shared sessiondb command implementations that can be
 * registered in the shared command registry and exposed through
 * multiple interfaces (CLI, MCP).
 */

import { z } from "zod";
import {
  sharedCommandRegistry,
  CommandCategory,
  type CommandParameterMap,
  type CommandExecutionContext,
} from "../command-registry";
import { MigrationService } from "../../../domain/storage/migration/migration-service";
import { SessionDbConfig } from "../../../domain/configuration/types";
import { configurationService } from "../../../domain/configuration";
import { log } from "../../../utils/logger";
import { join } from "path";

/**
 * Parameters for sessiondb migrate command
 */
const sessionDbMigrateParams: CommandParameterMap = {
  to: {
    schema: z.enum(["json", "sqlite", "postgres"]),
    description: "Target backend (json, sqlite, postgres)",
    required: true,
  },
  from: {
    schema: z.enum(["json", "sqlite", "postgres"]).optional(),
    description: "Source backend (auto-detect if not specified)",
    required: false,
  },
  sqlitePath: {
    schema: z.string().optional(),
    description: "SQLite database file path",
    required: false,
  },
  connectionString: {
    schema: z.string().optional(),
    description: "PostgreSQL connection string",
    required: false,
  },
  baseDir: {
    schema: z.string().optional(),
    description: "Base directory for session workspaces",
    required: false,
  },
  backup: {
    schema: z.string().optional(),
    description: "Create backup in specified directory",
    required: false,
  },
  dryRun: {
    schema: z.boolean().default(false),
    description: "Simulate migration without making changes",
    required: false,
  },
  verify: {
    schema: z.boolean().default(false),
    description: "Verify migration after completion",
    required: false,
  },
  json: {
    schema: z.boolean().default(false),
    description: "Output results in JSON format",
    required: false,
  },
};

/**
 * SessionDB migrate command definition
 */
const sessionDbMigrateRegistration = {
  id: "sessiondb.migrate",
  category: CommandCategory.CONFIG,
  name: "migrate",
  description: "Migrate session database between storage backends",
  parameters: sessionDbMigrateParams,
  execute: async (params, ctx: CommandExecutionContext) => {
    const targetBackend = params.to;

    try {
      // Validate target backend
      const validBackends = ["json", "sqlite", "postgres"];
      if (!validBackends.includes(targetBackend)) {
        return {
          success: false,
          error: `Invalid backend: ${targetBackend}. Valid options: ${validBackends.join(", ")}`,
        };
      }

      // Load current configuration
      const config = await configurationService.loadConfiguration(process.cwd());
      const currentConfig = config.resolved.sessiondb || { backend: "json" };

      // Determine source backend
      const sourceBackend = params.from || currentConfig.backend || "json";
      if (sourceBackend === targetBackend) {
        return {
          success: true,
          message: `Already using ${targetBackend} backend. No migration needed.`,
        };
      }

      // Build source and target configurations
      const sourceConfig: SessionDbConfig = {
        backend: sourceBackend as "json" | "sqlite" | "postgres",
        dbPath: currentConfig.dbPath || generateDefaultPath(sourceBackend),
        baseDir: currentConfig.baseDir,
        connectionString: currentConfig.connectionString,
      };

      const targetConfig: SessionDbConfig = {
        backend: targetBackend as "json" | "sqlite" | "postgres",
        dbPath: params.sqlitePath || generateDefaultPath(targetBackend),
        baseDir: params.baseDir || currentConfig.baseDir,
        connectionString: params.connectionString,
      };

      // Validate target configuration
      if (targetBackend === "postgres" && !targetConfig.connectionString) {
        return {
          success: false,
          error: "PostgreSQL connection string is required (--connection-string)",
        };
      }

      // Set up migration options
      const migrationOptions = {
        sourceConfig,
        targetConfig,
        backupPath: params.backup,
        dryRun: params.dryRun,
        verify: params.verify,
      };

      // Perform migration
      log.debug(`Migrating session database: ${sourceBackend} → ${targetBackend}`);
      if (params.dryRun) {
        log.debug("(DRY RUN - no changes will be made)");
      }

      const result = await MigrationService.migrate(migrationOptions);

      // Format output for CLI display
      if (!params.json) {
        console.log(`\nMigrating session database: ${sourceBackend} → ${targetBackend}`);
        if (params.dryRun) {
          console.log("(DRY RUN - no changes will be made)\n");
        }

        console.log("\n=== Migration Results ===");
        console.log(`Status: ${result.success ? "SUCCESS" : "FAILED"}`);
        console.log(`Records migrated: ${result.recordsMigrated}`);

        if (result.backupPath) {
          console.log(`Backup created: ${result.backupPath}`);
        }

        if (result.errors.length > 0) {
          console.log("\nErrors:");
          result.errors.forEach((error) => console.log(`  - ${error}`));
        }

        if (result.warnings.length > 0) {
          console.log("\nWarnings:");
          result.warnings.forEach((warning) => console.log(`  - ${warning}`));
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
            result.verificationResult.inconsistencies.forEach((inc) => console.log(`  - ${inc}`));
          }
        }

        if (result.success && !params.dryRun) {
          console.log("\n=== Next Steps ===");
          console.log("1. Update your configuration to use the new backend:");
          console.log(`   sessiondb.backend: "${targetBackend}"`);
          console.log("2. Test session operations to verify everything works");
          console.log("3. Remove old database files if no longer needed");
        }
      }

      // Return full result for JSON mode, simple result for CLI mode
      if (params.json) {
        return {
          success: result.success,
          recordsMigrated: result.recordsMigrated,
          backupPath: result.backupPath,
          errors: result.errors,
          warnings: result.warnings,
          verificationResult: result.verificationResult,
        };
      } else {
        // For CLI mode, just return success status since we already printed the details
        return {
          success: result.success,
        };
      }
    } catch (error) {
      log.error("Migration failed", {
        targetBackend,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },
};

/**
 * Generate default path for backend
 */
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

/**
 * Register all sessiondb commands
 */
export function registerSessionDbCommands() {
  sharedCommandRegistry.registerCommand(sessionDbMigrateRegistration);
}
