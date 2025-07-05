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
} from "../../shared/command-registry.js";
import { createStorageBackend } from "../../../domain/storage/storage-backend-factory.js";
import { log } from "../../../utils/logger.js";
import type { SessionRecord } from "../../../domain/session/session-db.js";

/**
 * Parameters for the sessiondb migrate command
 */
const sessiondbMigrateCommandParams: CommandParameterMap = {
  to: {
    schema: z.enum(["json", "sqlite", "postgres"]),
    description: "Target backend (json, sqlite, postgres)",
    required: true,
  },
  from: {
    schema: z.string().optional(),
    description: "Source backend or file path (auto-detect if not specified)",
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
  backup: {
    schema: z.string().optional(),
    description: "Create backup in specified directory",
    required: false,
  },
  dryRun: {
    schema: z.boolean().optional().default(false),
    description: "Simulate migration without making changes",
    required: false,
  },
  verify: {
    schema: z.boolean().optional().default(false),
    description: "Verify migration after completion",
    required: false,
  },
  json: {
    schema: z.boolean().optional().default(false),
    description: "Output results in JSON format",
    required: false,
  },
};

/**
 * Migrate sessions from one backend to another
 */
async function migrateSessionData(options: {
  to: "json" | "sqlite" | "postgres";
  from?: string;
  sqlitePath?: string;
  connectionString?: string;
  backup?: string;
  dryRun?: boolean;
  verify?: boolean;
}): Promise<{
  success: boolean;
  sourceCount: number;
  targetCount: number;
  backupPath?: string;
  errors?: string[];
}> {
  const { to, from, sqlitePath, connectionString, backup, dryRun = false, verify = false } = options;

  // Determine source
  let sourceData: Record<string, SessionRecord> = {};
  let sourceCount = 0;

  if (from && existsSync(from)) {
    // Read from specific file
    const fileContent = readFileSync(from, "utf8") as string;
    sourceData = JSON.parse(fileContent);
    sourceCount = Object.keys(sourceData).length;
    log.info(`Reading from backup file: ${from} (${sourceCount} sessions)`);
  } else {
    // Auto-detect current backend
    const homeDir = process.env.HOME || "";
    const jsonPath = join(homeDir, ".local/state/minsky/session-db.json");
    const currentSqlitePath = join(homeDir, ".local/state/minsky/sessions.db");
    
    if (existsSync(jsonPath)) {
      const fileContent = readFileSync(jsonPath, "utf8") as string;
      sourceData = JSON.parse(fileContent);
      sourceCount = Object.keys(sourceData).length;
      log.info(`Auto-detected JSON backend with ${sourceCount} sessions`);
    } else if (existsSync(currentSqlitePath)) {
      // Read from SQLite (current backend)
      try {
        const storage = createStorageBackend({
          backend: "sqlite",
          sqlite: { dbPath: currentSqlitePath },
        });
        await storage.initialize();
        const result = await storage.readState();
        if (result.success && result.data) {
          result.data.sessions.forEach(session => {
            sourceData[session.session] = session;
          });
          sourceCount = result.data.sessions.length;
          log.info(`Auto-detected SQLite backend with ${sourceCount} sessions`);
        }
      } catch (error) {
        log.error("Failed to read from SQLite backend:", error as Error);
        throw new Error(`Failed to read from SQLite: ${getErrorMessage(error)}`);
      }
    } else {
      throw new Error("No session database found. Use --from to specify a source file.");
    }
  }

  // Create backup if requested
  let backupPath: string | undefined;
  if (backup && !dryRun) {
    if (!existsSync(backup)) {
      mkdirSync(backup, { recursive: true });
    }
    backupPath = join(backup, `session-backup-${Date.now()}.json`);
    writeFileSync(backupPath, JSON.stringify(sourceData, null, 2));
    log.info(`Created backup: ${backupPath}`);
  }

  if (dryRun) {
    log.info(`DRY RUN: Would migrate ${sourceCount} sessions to ${to} backend`);
    return {
      success: true,
      sourceCount,
      targetCount: 0,
      backupPath,
    };
  }

  // Create target storage
  const targetConfig: any = { backend: to };
  
  if (to === "sqlite") {
    targetConfig.sqlite = {
      dbPath: sqlitePath || join(process.env.HOME || "", ".local/state/minsky/sessions.db"),
    };
  } else if (to === "postgres") {
    if (!connectionString) {
      throw new Error("PostgreSQL connection string required for postgres backend");
    }
    targetConfig.postgres = { connectionUrl: connectionString };
  } else if (to === "json") {
    targetConfig.json = {
      filePath: join(process.env.HOME || "", ".local/state/minsky/session-db.json"),
    };
  }

  const targetStorage = createStorageBackend(targetConfig);
  await targetStorage.initialize();

  // Migrate sessions
  const sessionRecords = Object.values(sourceData);
  let successCount = 0;
  const errors: string[] = [];

  for (const session of sessionRecords) {
    try {
      // Check if session already exists
      const existing = await targetStorage.getEntity(session.session);
      if (existing) {
        log.debug(`Session ${session.session} already exists, skipping`);
        successCount++;
        continue;
      }

      // Create the session
      await targetStorage.createEntity(session);
      successCount++;
      log.debug(`Migrated session: ${session.session}`);
    } catch (error) {
      const errorMsg = `Failed to migrate session ${session.session}: ${getErrorMessage(error)}`;
      errors.push(errorMsg);
      log.error(errorMsg);
    }
  }

  // Verify if requested
  if (verify) {
    const verifyResult = await targetStorage.readState();
    if (!verifyResult.success || !verifyResult.data) {
      errors.push("Verification failed: could not read target database");
    } else {
      const targetCount = verifyResult.data.sessions.length;
      if (targetCount !== sourceCount) {
        errors.push(`Verification failed: expected ${sourceCount} sessions, found ${targetCount}`);
      }
    }
  }

  log.info(`Migration complete: ${successCount} successful, ${errors.length} errors`);

  return {
    success: errors.length === 0,
    sourceCount,
    targetCount: successCount,
    backupPath,
    errors: errors.length > 0 ? errors : undefined,
  };
}

/**
 * Register the sessiondb commands in the shared command registry
 */
export function registerSessiondbCommands(): void {
  // Register sessiondb migrate command
  sharedCommandRegistry.registerCommand({
    id: "sessiondb.migrate",
    category: CommandCategory.SESSIONDB, // Use SESSIONDB category for the new top-level command
    name: "migrate",
    description: "Migrate session database between backends",
    parameters: sessiondbMigrateCommandParams,
    execute: async (params: Record<string, any>, context: CommandExecutionContext) => {
      log.debug("Executing sessiondb.migrate command", { params, context });

      try {
        const result = await migrateSessionData({
          to: params.to,
          from: params.from,
          sqlitePath: params.sqlitePath,
          connectionString: params.connectionString,
          backup: params.backup,
          dryRun: params.dryRun,
          verify: params.verify,
        });

        if (params.json) {
          return result;
        }

        // Format human-readable output
        let output = `Migration ${result.success ? "completed" : "failed"}\n`;
        output += `Source sessions: ${result.sourceCount}\n`;
        output += `Target sessions: ${result.targetCount}\n`;
        if (result.backupPath) {
          output += `Backup created: ${result.backupPath}\n`;
        }
        if (result.errors && result.errors.length > 0) {
          output += `Errors: ${result.errors.length}\n`;
          result.errors.forEach(error => {
            output += `  - ${error}\n`;
          });
        }

        return {
          success: result.success,
          output,
          sourceCount: result.sourceCount,
          targetCount: result.targetCount,
          backupPath: result.backupPath,
          errors: result.errors,
        };
      } catch (error) {
        log.error("Failed to migrate session database", {
          error: getErrorMessage(error),
        });
        throw error;
      }
    },
  });
} 
