/**
 * Shared SessionDB Commands
 *
 * This module contains shared sessiondb command implementations for
 * database migration and management operations.
 */

import { z } from "zod";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { getErrorMessage } from "../../../errors/index";
import {
  sharedCommandRegistry,
  CommandCategory,
  type CommandParameterMap,
  type CommandExecutionContext,
} from "../../shared/command-registry";
import { createStorageBackend } from "../../../domain/storage/storage-backend-factory";
import { log } from "../../../utils/logger";
import type { SessionRecord } from "../../../domain/session/session-db";
import type { StorageBackendType } from "../../../domain/storage/storage-backend-factory";
import {
  getXdgStateHome,
  getMinskyStateDir,
  getDefaultSqliteDbPath,
  getDefaultJsonDbPath,
} from "../../../utils/paths";

/**
 * Parameters for the sessiondb migrate command
 */
const sessiondbMigrateCommandParams: CommandParameterMap = {
  to: {
    schema: z.enum(["json", "sqlite", "postgres"]),
    description: "Target backend type",
    required: true,
  },
  from: {
    schema: z.string(),
    description: "Source file path (auto-detect if not provided)",
    required: false,
  },
  sqlitePath: {
    schema: z.string(),
    description: "SQLite database path",
    required: false,
  },
  connectionString: {
    schema: z.string(),
    description: "PostgreSQL connection string",
    required: false,
  },
  backup: {
    schema: z.boolean(),
    description: "Create backup before migration",
    required: false,
  },
  dryRun: {
    schema: z.boolean(),
    description: "Show what would be migrated without doing it",
    required: false,
  },
};

/**
 * Parameters for the sessiondb check command
 */
const sessiondbCheckCommandParams: CommandParameterMap = {
  file: {
    schema: z.string(),
    description: "Path to database file to check",
    required: false,
  },
  backend: {
    schema: z.enum(["json", "sqlite", "postgres"]),
    description: "Expected backend type",
    required: false,
  },
  fix: {
    schema: z.boolean(),
    description: "Automatically fix issues when possible",
    required: false,
  },
  report: {
    schema: z.boolean(),
    description: "Show detailed integrity report",
    required: false,
  },
};

// Register sessiondb migrate command
sharedCommandRegistry.registerCommand({
  id: "sessiondb.migrate",
  category: CommandCategory.SESSION,
  name: "migrate",
  description: "Migrate session database between backends",
  parameters: sessiondbMigrateCommandParams,
  async execute(params: any, context: CommandExecutionContext) {
    const { to, from, sqlitePath, connectionString, backup, dryRun } = params;

    try {
      // Read source data
      let sourceData: Record<string, any> = {};
      let sourceCount = 0;

      if (from && existsSync(from)) {
        // Read from specific file
        const fileContent = readFileSync(from, "utf8").toString();
        sourceData = JSON.parse(fileContent);
        sourceCount = Object.keys(sourceData).length;
        log.info(`Reading from backup file: ${from} (${sourceCount} sessions)`);
      } else {
        // Auto-detect current backend
        const jsonPath = getDefaultJsonDbPath();
        const currentSqlitePath = getDefaultSqliteDbPath();

        if (existsSync(jsonPath)) {
          const fileContent = readFileSync(jsonPath, "utf8").toString();
          sourceData = JSON.parse(fileContent);
          sourceCount = Object.keys(sourceData).length;
          log.info(`Reading from JSON backend: ${jsonPath} (${sourceCount} sessions)`);
        } else if (existsSync(currentSqlitePath)) {
          // Read from SQLite
          const sourceStorage = createStorageBackend({ backend: "sqlite" });
          await sourceStorage.initialize();
          const readResult = await sourceStorage.readState();
          if (readResult.success && readResult.data) {
            sourceData = readResult.data;
            sourceCount = (readResult.data as unknown).sessions?.length || 0;
            log.info(`Reading from SQLite backend: ${currentSqlitePath} (${sourceCount} sessions)`);
          }
        } else {
          throw new Error("No source database found. Use --from to specify a backup file.");
        }
      }

      if (dryRun) {
        log.info("DRY RUN - No changes will be made");
        log.info(`Would migrate ${sourceCount} sessions from source to ${to} backend`);
        return {
          success: true,
          dryRun: true,
          sourceCount,
          targetBackend: to,
        };
      }

      // Create backup if requested
      let backupPath: string | undefined;
      if (backup) {
        backupPath = join(getMinskyStateDir(), `session-backup-${Date.now()}.json`);
        const backupDir = dirname(backupPath);
        if (!existsSync(backupDir)) {
          mkdirSync(backupDir, { recursive: true });
        }
        writeFileSync(backupPath, JSON.stringify(sourceData, null, 2));
        log.info(`Backup created: ${backupPath}`);
      }

      // Create target storage
      const targetConfig: any = { backend: to };

      if (to === "sqlite") {
        targetConfig.sqlite = {
          dbPath: sqlitePath || getDefaultSqliteDbPath(),
        };
      } else if (to === "postgres") {
        if (!connectionString) {
          throw new Error("PostgreSQL connection string required for postgres backend");
        }
        targetConfig.postgres = { connectionUrl: connectionString };
      } else if (to === "json") {
        targetConfig.json = {
          filePath: getDefaultJsonDbPath(),
        };
      }

      const targetStorage = createStorageBackend(targetConfig);
      await targetStorage.initialize();

      // Migrate sessions
      const sessionRecords: SessionRecord[] = [];
      if (Array.isArray((sourceData as unknown).sessions)) {
        sessionRecords.push(...(sourceData as unknown).sessions);
      } else if (typeof sourceData === "object" && sourceData !== null) {
        // Handle sessions stored as key-value pairs
        for (const [sessionId, sessionData] of Object.entries(sourceData)) {
          if (typeof sessionData === "object" && sessionData !== null) {
            sessionRecords.push({
              session: sessionId,
              ...(sessionData as unknown),
            });
          }
        }
      }

      // Write to target backend
      const targetState = {
        sessions: sessionRecords,
        baseDir: getMinskyStateDir(),
      };

      const writeResult = await targetStorage.writeState(targetState);
      if (!writeResult.success) {
        throw new Error(
          `Failed to write to target backend: ${writeResult.error?.message || "Unknown error"}`
        );
      }

      const targetCount = sessionRecords.length;
      log.info(
        `Migration completed: ${sourceCount} source sessions -> ${targetCount} target sessions`
      );

      const result = {
        success: true,
        sourceCount,
        targetCount,
        targetBackend: to,
        backupPath,
        errors: [] as string[],
      };

      // Format human-readable output
      if (context.format === "human") {
        let output = `Migration ${result.success ? "completed" : "failed"}\n`;
        output += `Source sessions: ${result.sourceCount}\n`;
        output += `Target sessions: ${result.targetCount}\n`;
        if (result.backupPath) {
          output += `Backup created: ${result.backupPath}\n`;
        }
        if (result.errors && result.errors.length > 0) {
          output += `Errors: ${result.errors.length}\n`;
          result.errors.forEach((error) => {
            output += `  - ${error}\n`;
          });
        }
        return output;
      }

      return result;
    } catch (error) {
      log.error("Migration failed", { error: getErrorMessage(error) });
      throw error;
    }
  },
});

// Register sessiondb check command
sharedCommandRegistry.registerCommand({
  id: "sessiondb.check",
  category: CommandCategory.SESSION,
  name: "check",
  description: "Check database integrity and detect issues",
  parameters: sessiondbCheckCommandParams,
  async execute(params: any, context: CommandExecutionContext) {
    const { file, backend, fix, report } = params;

    try {
      // Import integrity checker
      const { DatabaseIntegrityChecker } = await import(
        "../../../domain/storage/database-integrity-checker"
      );
      const { loadStorageConfig } = await import("../../../domain/storage/storage-backend-factory");

      // Determine file path and backend
      let filePath: string;
      let expectedBackend: StorageBackendType;

      if (file && backend) {
        filePath = file;
        expectedBackend = backend;
      } else {
        // Auto-detect from current configuration
        const config = loadStorageConfig();
        expectedBackend = config.backend;

        if (config.backend === "json") {
          filePath = config.json?.filePath || "session-db.json";
        } else if (config.backend === "sqlite") {
          filePath = config.sqlite?.dbPath || "sessions.db";
        } else {
          throw new Error("PostgreSQL databases do not support file-based integrity checking");
        }
      }

      // Run integrity check
      const integrityResult = await DatabaseIntegrityChecker.checkIntegrity(
        expectedBackend,
        filePath
      );

      // Show results
      if (report || !integrityResult.isValid) {
        const reportText = DatabaseIntegrityChecker.formatIntegrityReport(integrityResult);
        log.cli(reportText);
      }

      // Auto-fix if requested
      if (fix && integrityResult.suggestedActions.length > 0) {
        const autoFixableActions = integrityResult.suggestedActions.filter(
          (action) => action.autoExecutable && action.type === "migrate"
        );

        if (autoFixableActions.length > 0) {
          const action = autoFixableActions[0];
          if (action) {
            log.cli(`\n🔧 Auto-fixing: ${action.description}`);

            if (action.command) {
              log.cli(`Would execute: ${action.command}`);
              log.cli("(Auto-fix implementation would go here)");
            }
          }
        } else {
          log.cli("\n⚠️  No auto-fixable issues found. Manual intervention required.");
        }
      }

      return {
        success: integrityResult.isValid,
        integrityResult,
        filePath,
        expectedBackend,
      };
    } catch (error) {
      log.error("Database integrity check failed", { error: getErrorMessage(error) });
      throw error;
    }
  },
});

/**
 * Register all sessiondb commands
 */
export function registerSessiondbCommands(): void {
  // Commands are registered above when this module is imported
  log.debug("SessionDB commands registered");
}
