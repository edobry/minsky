/**
 * Shared SessionDB Commands
 *
 * This module contains shared sessiondb command implementations for
 * database migration and management operations, as well as low-level query operations
 * for MCP agents to inspect raw session database records.
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
import { createSessionProvider } from "../../../domain/session";

/**
 * Parameters for the sessiondb search command
 */
const sessiondbSearchCommandParams: CommandParameterMap = {
  query: {
    schema: z.string().min(1),
    description: "Search query (searches in session name, repo name, branch, task ID)",
    required: true,
  },
  limit: {
    schema: z.number().int().positive(),
    description: "Maximum number of results to return",
    required: false,
    defaultValue: 10,
  },
};

// Register sessiondb search command
sharedCommandRegistry.registerCommand({
  id: "sessiondb.search",
  category: CommandCategory.SESSIONDB,
  name: "search",
  description:
    "Search sessions by query string across multiple fields (returns raw SessionRecord objects from database)",
  parameters: sessiondbSearchCommandParams,
  async execute(params: any, _context: CommandExecutionContext) {
    const { query, limit } = params;

    try {
      const sessionProvider = createSessionProvider();
      const sessions = await sessionProvider.listSessions();

      const lowerQuery = query.toLowerCase();

      // Search across multiple fields
      const matchingSessions = sessions.filter((session) => {
        return (
          session.session?.toLowerCase().includes(lowerQuery) ||
          session.repoName?.toLowerCase().includes(lowerQuery) ||
          session.repoUrl?.toLowerCase().includes(lowerQuery) ||
          session.taskId?.toLowerCase().includes(lowerQuery) ||
          session.branch?.toLowerCase().includes(lowerQuery) ||
          session.prState?.branchName?.toLowerCase().includes(lowerQuery)
        );
      });

      // Apply limit
      const limitedResults = matchingSessions.slice(0, limit);

      log.debug(`SessionDB search found ${matchingSessions.length} matches for query: ${query}`, {
        totalSessions: sessions.length,
        matchCount: matchingSessions.length,
        limitedCount: limitedResults.length,
        limit,
      });

      return {
        success: true,
        sessions: limitedResults,
        query,
        totalMatches: matchingSessions.length,
        limitedCount: limitedResults.length,
        totalSessions: sessions.length,
        limit,
        note: "Returns raw SessionRecord objects from database. Use 'session list' or 'session get' commands for mapped Session objects.",
      };
    } catch (error) {
      log.error("SessionDB search failed", {
        query,
        error: getErrorMessage(error),
      });
      throw error;
    }
  },
});

/**
 * Parameters for the sessiondb migrate command
 */
const sessiondbMigrateCommandParams: CommandParameterMap = {
  to: {
    schema: z.enum(["sqlite", "postgres"]),
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
  backup: {
    schema: z.boolean().default(true),
    description: "Create backup before migration (default: true)",
    required: false,
  },
  execute: {
    schema: z.boolean(),
    description: "Actually perform the migration (default is preview mode)",
    required: false,
  },
  setDefault: {
    schema: z.boolean(),
    description: "Update configuration to use migrated backend as default",
    required: false,
  },
};

/**
 * Parameters for the sessiondb check command
 */
const sessiondbCheckCommandParams: CommandParameterMap = {
  file: {
    schema: z.string(),
    description: "Path to database file to check (SQLite only)",
    required: false,
  },
  backend: {
    schema: z.enum(["sqlite", "postgres"]),
    description: "Force specific backend validation",
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
  category: CommandCategory.SESSIONDB,
  name: "migrate",
  description: "Migrate session database between backends",
  parameters: sessiondbMigrateCommandParams,
  async execute(params: any, context: CommandExecutionContext) {
    const { to, from, sqlitePath, backup = true, execute, setDefault } = params;

    // Default is preview mode unless --execute is specified
    const isPreviewMode = !execute;

    try {
      // Check for JSON backend deprecation
      if (to === "json") {
        throw new Error(
          "❌ CRITICAL: JSON backend is deprecated and no longer supported. " +
            "Please use 'sqlite' or 'postgres' as target backend."
        );
      }

      // Import configuration system for config-driven behavior
      const { getConfiguration } = await import("../../../domain/configuration/index");
      const config = getConfiguration();

      // Check for drift in current configuration
      const configuredBackend = config.sessiondb?.backend;
      if (configuredBackend === "json") {
        log.cli("⚠️  WARNING: JSON backend configured but deprecated. Migration recommended.");
      }

      log.cli(`🚀 SessionDB Migration - Target: ${to}`);
      log.cli(`Mode: ${isPreviewMode ? "PREVIEW" : "EXECUTE"}`);
      log.cli(`Backup: ${backup ? "YES" : "NO"}`);

      // Read source data
      let sourceData: Record<string, any> = {};
      let sourceCount = 0;
      let sourceDescription = "configured session backend";

      if (from && existsSync(from)) {
        // Read from specific file
        const fileContent = readFileSync(from, "utf8").toString();
        sourceData = JSON.parse(fileContent);
        sourceCount = Object.keys(sourceData).length;
        sourceDescription = `backup file: ${from}`;
        log.cli(`Reading from backup file: ${from} (${sourceCount} sessions)`);
      } else {
        // Read from CURRENT configured backend (no JSON fallback)
        const configuredBackend = config.sessiondb?.backend as "sqlite" | "postgres";
        if (!configuredBackend) {
          throw new Error("No sessiondb backend configured. Configure sqlite or postgres.");
        }

        const sourceConfig: any = { backend: configuredBackend };
        if (configuredBackend === "sqlite") {
          // Use configured path or default
          const dbPath =
            config.sessiondb?.sqlite?.path || config.sessiondb?.dbPath || getDefaultSqliteDbPath();
          sourceConfig.sqlite = { dbPath };
          sourceDescription = `SQLite backend: ${dbPath}`;
        } else if (configuredBackend === "postgres") {
          const connectionString =
            config.sessiondb?.postgres?.connectionString ||
            config.sessiondb?.connectionString ||
            process.env.MINSKY_POSTGRES_URL;
          if (!connectionString) {
            throw new Error(
              "PostgreSQL connection string not found in configuration or MINSKY_POSTGRES_URL."
            );
          }
          sourceConfig.postgres = { connectionString };
          sourceDescription = "PostgreSQL backend (configured)";
        }

        const sourceStorage = createStorageBackend(sourceConfig);
        await sourceStorage.initialize();
        const readResult = await sourceStorage.readState();
        if (readResult.success && readResult.data) {
          sourceData = readResult.data;
          sourceCount = readResult.data.sessions?.length || 0;
          log.cli(`Reading from ${sourceDescription} (${sourceCount} sessions)`);
        } else {
          log.warn("Failed to read from configured session backend; proceeding with 0 sessions");
          sourceData = { sessions: [], baseDir: getMinskyStateDir() };
          sourceCount = 0;
        }
      }

      // Build normalized list of session records
      const sessionRecords: SessionRecord[] = [];
      if (Array.isArray(sourceData.sessions)) {
        sessionRecords.push(...sourceData.sessions);
      } else if (typeof sourceData === "object" && sourceData !== null) {
        // Handle sessions stored as key-value pairs
        for (const [sessionId, sessionData] of Object.entries(sourceData)) {
          if (typeof sessionData === "object" && sessionData !== null) {
            const typedSessionData = sessionData as Partial<SessionRecord>;
            sessionRecords.push({
              session: sessionId,
              repoName: typedSessionData.repoName || sessionId,
              repoUrl: typedSessionData.repoUrl || sessionId,
              createdAt: typedSessionData.createdAt || new Date().toISOString(),
              taskId: typedSessionData.taskId || "",
              branch: typedSessionData.branch || "main",
              ...typedSessionData,
            });
          }
        }
      }

      // Prepare operations plan
      const operations: string[] = [];
      operations.push(`Read source sessions (${sourceCount}) from ${sourceDescription}`);
      if (backup) {
        operations.push(`Create JSON backup of source before migration`);
      }
      operations.push(
        `Write ${sessionRecords.length} session(s) to target '${to}' backend (full replacement)`
      );
      if (setDefault) {
        operations.push(`Update configuration to set default backend to '${to}'`);
      }

      // PREVIEW MODE: show plan and exit
      if (isPreviewMode) {
        log.cli("\n📝 Migration plan (preview):");
        operations.forEach((op, idx) => log.cli(`  ${idx + 1}. ${op}`));
        log.cli("\n(No changes will be made in preview mode)\n");
        return {
          success: true,
          preview: true,
          sourceCount,
          targetBackend: to,
          plannedInsertCount: sessionRecords.length,
          operations,
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
        log.cli(`Backup created: ${backupPath}`);
      }

      // Create target storage with config-driven approach
      const targetConfig: any = { backend: to };

      if (to === "sqlite") {
        targetConfig.sqlite = {
          dbPath: sqlitePath || getDefaultSqliteDbPath(),
        };
      } else if (to === "postgres") {
        // Use config-driven PostgreSQL connection
        const connectionString =
          config.sessiondb?.postgres?.connectionString ||
          config.sessiondb?.connectionString ||
          process.env.MINSKY_POSTGRES_URL;

        if (!connectionString) {
          throw new Error(
            "PostgreSQL connection string not found. " +
              "Please configure sessiondb.postgres.connectionString in config file or set MINSKY_POSTGRES_URL environment variable."
          );
        }

        log.cli(
          `Using PostgreSQL connection: ${connectionString.replace(/:\/\/[^:]+:[^@]+@/, "://***:***@")}\n`
        );
        targetConfig.postgres = { connectionString: connectionString };
      }

      const targetStorage = createStorageBackend(targetConfig);
      await targetStorage.initialize();

      // Show execute plan (same as preview) before applying
      log.cli("\n📝 Migration plan (execute):");
      operations.forEach((op, idx) => log.cli(`  ${idx + 1}. ${op}`));

      // Write to target backend
      const targetState = {
        sessions: sessionRecords,
        baseDir: getMinskyStateDir(),
      };

      const writeResult = await targetStorage.writeState(targetState);
      if (!writeResult.success) {
        const msg = writeResult.error?.message || "database operation failed";
        throw new Error(`Failed to write to target backend: ${msg}`);
      }
      log.cli(
        `✅ Data successfully migrated to target backend (${sessionRecords.length} sessions)`
      );

      const targetCount = sessionRecords.length;
      log.info(
        `Migration completed: ${sourceCount} source sessions -> ${targetCount} target sessions`
      );

      // Handle setDefault option
      if (setDefault) {
        log.cli(`\n🔧 Updating configuration to use ${to} backend as default...`);
        log.cli(`✅ Configuration update requested. Please manually update your config file:`);
        log.cli(`\n[sessiondb]`);
        log.cli(`backend = "${to}"`);

        if (to === "postgres") {
          const connectionString =
            config.sessiondb?.postgres?.connectionString ||
            config.sessiondb?.connectionString ||
            process.env.MINSKY_POSTGRES_URL;
          log.cli(`\n[sessiondb.postgres]`);
          log.cli(`connectionString = "${connectionString}"`);
        } else if (to === "sqlite" && sqlitePath) {
          log.cli(`\n[sessiondb.sqlite]`);
          log.cli(`path = "${sqlitePath}"`);
        }

        log.cli(`\n💡 To revert: Change backend back to your previous setting`);
      }

      const result = {
        success: true,
        sourceCount,
        targetCount,
        targetBackend: to,
        backupPath,
        setDefaultApplied: setDefault,
        operations,
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
      const msg = getErrorMessage(error).split("\n")[0];
      throw new Error(`Migration failed: ${msg}`);
    }
  },
});

// Register sessiondb check command
sharedCommandRegistry.registerCommand({
  id: "sessiondb.check",
  category: CommandCategory.SESSIONDB,
  name: "check",
  description: "Check database integrity and detect issues",
  parameters: sessiondbCheckCommandParams,
  async execute(params: any, _context: CommandExecutionContext) {
    const { file, backend, fix, report } = params;

    try {
      // Import configuration system
      const { getConfiguration } = await import("../../../domain/configuration/index");

      // Determine which backend to validate
      let targetBackend: "sqlite" | "postgres";
      let sourceInfo: string;

      if (backend) {
        // Force specific backend validation
        targetBackend = backend;
        sourceInfo = `Backend forced to: ${backend}`;
      } else {
        // Auto-detect from configuration
        const config = getConfiguration();
        const configuredBackend = config.sessiondb?.backend;

        // Check for drift (configured vs runtime mismatch)
        if (configuredBackend === "json") {
          throw new Error(
            "❌ CRITICAL: JSON backend is deprecated and no longer supported. " +
              "Please migrate to SQLite or PostgreSQL using 'minsky sessiondb migrate'."
          );
        }

        if (!configuredBackend || !["sqlite", "postgres"].includes(configuredBackend)) {
          throw new Error(
            `❌ CRITICAL: Invalid or unsupported backend configured: ${configuredBackend}. ` +
              "Supported backends: sqlite, postgres"
          );
        }

        targetBackend = configuredBackend as "sqlite" | "postgres";
        sourceInfo = `Backend auto-detected from configuration: ${targetBackend}`;
      }

      log.cli(`🔍 SessionDB Check - ${sourceInfo}`);

      // Perform backend-specific validation
      let validationResult: {
        success: boolean;
        details: string;
        issues?: string[];
        suggestions?: string[];
      };

      if (targetBackend === "sqlite") {
        validationResult = await validateSqliteBackend(file);
      } else if (targetBackend === "postgres") {
        validationResult = await validatePostgresBackend();
      } else {
        throw new Error(`Unknown backend: ${targetBackend}`);
      }

      // Show results
      if (report || !validationResult.success) {
        log.cli(`\n📊 Validation Results:`);
        log.cli(`Status: ${validationResult.success ? "✅ HEALTHY" : "❌ ISSUES FOUND"}`);
        log.cli(`Details: ${validationResult.details}`);

        if (validationResult.issues && validationResult.issues.length > 0) {
          log.cli(`\n⚠️ Issues Found:`);
          validationResult.issues.forEach((issue, idx) => {
            log.cli(`  ${idx + 1}. ${issue}`);
          });
        }

        if (validationResult.suggestions && validationResult.suggestions.length > 0) {
          log.cli(`\n💡 Suggestions:`);
          validationResult.suggestions.forEach((suggestion, idx) => {
            log.cli(`  ${idx + 1}. ${suggestion}`);
          });
        }
      }

      // Auto-fix if requested (basic implementation)
      if (fix && !validationResult.success) {
        log.cli(`\n🔧 Auto-fix requested but not yet implemented for ${targetBackend} backend`);
        log.cli("Manual intervention required for now.");
      }

      return {
        success: validationResult.success,
        backend: targetBackend,
        sourceInfo,
        validationResult,
      };
    } catch (error) {
      log.error("Database check failed", { error: getErrorMessage(error) });
      throw error;
    }
  },
});

/**
 * Validate SQLite backend
 */
async function validateSqliteBackend(
  filePath: string | undefined
): Promise<{ success: boolean; details: string; issues?: string[]; suggestions?: string[] }> {
  const issues: string[] = [];
  const suggestions: string[] = [];

  try {
    // Import configuration to get proper paths
    const { getConfiguration } = await import("../../../domain/configuration/index");
    const config = getConfiguration();

    // Determine SQLite file path
    let dbPath: string;
    if (filePath) {
      dbPath = filePath;
      log.cli(`Using specified file: ${dbPath}`);
    } else {
      // Use configured path or default
      dbPath =
        config.sessiondb?.sqlite?.path || config.sessiondb?.dbPath || getDefaultSqliteDbPath();
      log.cli(`Using configured/default file: ${dbPath}`);
    }

    // Check file existence
    if (!existsSync(dbPath)) {
      issues.push(`SQLite database file not found: ${dbPath}`);
      suggestions.push("Run 'minsky session list' to initialize database");
      return {
        success: false,
        details: `SQLite file not found at ${dbPath}`,
        issues,
        suggestions,
      };
    }

    // Basic file validation
    const { DatabaseIntegrityChecker } = await import(
      "../../../domain/storage/database-integrity-checker"
    );

    const integrityResult = await DatabaseIntegrityChecker.checkIntegrity("sqlite", dbPath);

    if (!integrityResult.isValid) {
      issues.push("SQLite integrity check failed");
      if (integrityResult.errors) {
        issues.push(...integrityResult.errors.map((err) => err.description));
      }
      if (integrityResult.suggestedActions) {
        suggestions.push(...integrityResult.suggestedActions.map((action) => action.description));
      }
    }

    return {
      success: integrityResult.isValid,
      details: `SQLite database validation at ${dbPath}`,
      issues: issues.length > 0 ? issues : undefined,
      suggestions: suggestions.length > 0 ? suggestions : undefined,
    };
  } catch (error) {
    issues.push(`SQLite validation error: ${getErrorMessage(error)}`);
    return {
      success: false,
      details: "SQLite validation failed with error",
      issues,
      suggestions: ["Check file permissions and SQLite installation"],
    };
  }
}

/**
 * Validate PostgreSQL backend
 */
async function validatePostgresBackend(): Promise<{
  success: boolean;
  details: string;
  issues?: string[];
  suggestions?: string[];
}> {
  const issues: string[] = [];
  const suggestions: string[] = [];

  try {
    // Import configuration to get connection details
    const { getConfiguration } = await import("../../../domain/configuration/index");
    const config = getConfiguration();

    // Get PostgreSQL connection string
    const connectionString =
      config.sessiondb?.postgres?.connectionString ||
      config.sessiondb?.connectionString ||
      process.env.MINSKY_POSTGRES_URL;

    if (!connectionString) {
      issues.push("No PostgreSQL connection string configured");
      suggestions.push(
        "Set sessiondb.postgres.connectionString in config or MINSKY_POSTGRES_URL env var"
      );
      return {
        success: false,
        details: "PostgreSQL connection not configured",
        issues,
        suggestions,
      };
    }

    log.cli(
      `Testing connection to: ${connectionString.replace(/:\/\/[^:]+:[^@]+@/, "://***:***@")}`
    );

    // Basic connection test
    const { createStorageBackend } = await import(
      "../../../domain/storage/storage-backend-factory"
    );

    try {
      // Use direct PostgreSQL connection to avoid Drizzle logging
      const { Pool } = require("pg");
      const pool = new Pool({ connectionString });

      try {
        const client = await pool.connect();

        try {
          // Test basic connectivity
          await client.query("SELECT 1");

          // Test if sessions table exists (schema validation)
          const tableResult = await client.query(`
            SELECT EXISTS (
              SELECT FROM information_schema.tables
              WHERE table_schema = 'public'
              AND table_name = 'sessions'
            );
          `);

          const tableExists = tableResult.rows[0].exists;
          if (!tableExists) {
            throw new Error("sessions table does not exist");
          }
        } finally {
          client.release();
        }
      } finally {
        await pool.end();
      }

      return {
        success: true,
        details: `PostgreSQL connection and schema validated successfully`,
      };
    } catch (error) {
      const errorMessage = getErrorMessage(error);

      // Check if this is a schema/table issue vs connection issue
      if (
        errorMessage.includes("sessions table does not exist") ||
        errorMessage.includes('relation "sessions" does not exist') ||
        errorMessage.includes('table "sessions"') ||
        errorMessage.includes('select "session"')
      ) {
        issues.push("PostgreSQL connection successful, but schema is missing or incorrect");
        suggestions.push("Run database migrations to create the required 'sessions' table");
        suggestions.push("Verify the database has been properly initialized for Minsky");

        return {
          success: false,
          details: "PostgreSQL connection successful but schema validation failed",
          issues,
          suggestions,
        };
      } else {
        // This is likely a connection issue
        issues.push(`PostgreSQL connection failed: ${errorMessage}`);
        suggestions.push(
          "Check connection string, network connectivity, and PostgreSQL service status"
        );

        return {
          success: false,
          details: "PostgreSQL connection test failed",
          issues,
          suggestions,
        };
      }
    }
  } catch (error) {
    issues.push(`PostgreSQL validation error: ${getErrorMessage(error)}`);
    return {
      success: false,
      details: "PostgreSQL validation failed with error",
      issues,
      suggestions: ["Check PostgreSQL configuration and connection details"],
    };
  }
}

/**
 * Register all sessiondb commands
 */
export function registerSessiondbCommands(): void {
  // Commands are registered above when this module is imported
  log.debug("SessionDB commands registered");
}
