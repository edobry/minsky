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

      return {
        success: result.success,
        recordsMigrated: result.recordsMigrated,
        backupPath: result.backupPath,
        errors: result.errors,
        warnings: result.warnings,
        verificationResult: result.verificationResult,
      };
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
