/**
 * Shared SessionDB Commands
 *
 * This module contains shared sessiondb command implementations for
 * database migration and management operations, as well as low-level query operations
 * for MCP agents to inspect raw session database records.
 */

import { z } from "zod";
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from "fs";
import { dirname, join } from "path";
import { getErrorMessage, ensureError } from "../../../errors/index";
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

// (Removed) PG-specific migrate wrapper; unified under sessiondb.migrate

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
          session.prBranch?.toLowerCase().includes(lowerQuery) ||
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

// (Removed) see unified 'sessiondb.migrate'

/**
 * Parameters for the sessiondb migrate command
 */
const sessiondbMigrateCommandParams: CommandParameterMap = {
  to: {
    schema: z.enum(["sqlite", "postgres"]).optional(),
    description: "Target backend type (if omitted, run schema migrations for current backend)",
    required: false,
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
  dryRun: {
    schema: z.boolean(),
    description: "For schema-only mode: show what would be executed without applying",
    required: false,
    defaultValue: false,
  },
  verbose: {
    schema: z.boolean(),
    description: "Verbose logging during schema migration",
    required: false,
    defaultValue: false,
  },
  debug: {
    schema: z.boolean(),
    description: "Enable debug mode for detailed output",
    required: false,
  },
  showSql: {
    schema: z.boolean(),
    description: "Show full SQL in errors (equivalent to --debug for SQL errors)",
    required: false,
  },
};

/**
 * Helper: run schema migrations for the configured backend
 */
async function runSchemaMigrationsForConfiguredBackend(
  options: { dryRun?: boolean; verbose?: boolean; showSql?: boolean } = {}
): Promise<any> {
  const { dryRun = false, verbose = false, showSql = false } = options;
  const { getConfiguration } = await import("../../../domain/configuration/index");
  const config = getConfiguration();
  const backend = (config.sessiondb?.backend || "sqlite") as "sqlite" | "postgres";

  if (backend === "sqlite") {
    // SQLite: bun:sqlite + drizzle migrator
    const dbPath =
      config.sessiondb?.sqlite?.path || config.sessiondb?.dbPath || getDefaultSqliteDbPath();
    if (dryRun) {
      // Build preview plan
      const migrationsFolder = "./src/domain/storage/migrations";
      const { readdirSync } = await import("fs");
      const { basename } = await import("path");
      let fileNames: string[] = [];
      try {
        fileNames = readdirSync(migrationsFolder)
          .filter((n) => n.endsWith(".sql"))
          .sort((a, b) => a.localeCompare(b));
      } catch {
        // ignore
      }

      let metaExists = false;
      let appliedCount = 0;
      let latestHash: string | undefined;
      let latestAt: string | undefined;
      try {
        const { Database } = await import("bun:sqlite");
        const db = new Database(dbPath);
        try {
          // Check meta table
          const tables = db
            .query(
              "SELECT name FROM sqlite_master WHERE type='table' AND name='__drizzle_migrations'"
            )
            .all();
          metaExists = Array.isArray(tables) && tables.length > 0;
          if (metaExists) {
            const cnt = db.query("SELECT COUNT(*) as count FROM __drizzle_migrations").get() as any;
            appliedCount = parseInt(String(cnt?.count || 0), 10);
            const last = db
              .query(
                "SELECT hash, created_at FROM __drizzle_migrations ORDER BY created_at DESC LIMIT 1"
              )
              .get() as any;
            latestHash = last?.hash || undefined;
            latestAt = last?.created_at ? String(last.created_at) : undefined;
          }
        } finally {
          db.close();
        }
      } catch {
        // Best effort
      }

      const summary = `Schema migration (dry run) for sqlite\nDatabase: ${dbPath}\nMigrations: ${migrationsFolder}\nPlan: ${fileNames.length} file(s), ${appliedCount} applied, ${Math.max(
        fileNames.length - appliedCount,
        0
      )} pending`;

      const plan = {
        success: true,
        backend,
        dryRun: true,
        sqlitePath: dbPath,
        migrationsFolder,
        message: `${summary}\n\n(use --execute to apply)`,
        status: { metaTable: metaExists ? "present" : "missing" },
        plan: {
          files: fileNames,
          fileCount: fileNames.length,
          appliedCount,
          pendingCount: Math.max(fileNames.length - appliedCount, 0),
          latestHash,
          latestAt,
        },
      } as const;

      if (verbose) {
        log.cli("=== SessionDB Schema Migration (sqlite) — DRY RUN ===");
        log.cli("");
        log.cli(`Database: ${dbPath}`);
        log.cli(`Migrations: ${migrationsFolder}`);
        log.cli("");
        log.cli(`Status: metaTable=${metaExists ? "present" : "missing"}`);
        log.cli(
          `Plan: ${fileNames.length} file(s), ${appliedCount} applied, ${Math.max(
            fileNames.length - appliedCount,
            0
          )} pending`
        );
        if (fileNames.length > 0) {
          log.cli("");
          log.cli("Files:");
          fileNames.forEach((f, i) => log.cli(`  ${i + 1}. ${basename(f)}`));
        }
        log.cli("");
        log.cli("(use --execute to apply)");
        log.cli("");
      }

      return plan as any;
    }

    const { Database } = await import("bun:sqlite");
    const { drizzle } = await import("drizzle-orm/bun-sqlite");
    const { migrate } = await import("drizzle-orm/bun-sqlite/migrator");

    const sqlite = new Database(dbPath);
    try {
      if (verbose) {
        log.cli("=== SessionDB Schema Migration (sqlite) ===");
        log.cli("");
        log.cli(`Database: ${dbPath}`);
        log.cli(`Migrations: ./src/domain/storage/migrations`);
        log.cli("");
      }
      const db = drizzle(sqlite, { logger: false });
      const start = Date.now();
      await migrate(db as any, { migrationsFolder: "./src/domain/storage/migrations" });
      if (verbose) {
        const ms = Date.now() - start;
        log.cli("");
        log.cli(`Applied migrations in ${ms}ms`);
      }
    } finally {
      sqlite.close();
    }

    return {
      success: true,
      applied: true,
      backend,
      migrationsFolder: "./src/domain/storage/migrations",
      message: `Schema migration applied for sqlite (migrations: ./src/domain/storage/migrations)`,
    };
  }

  if (backend === "postgres") {
    const connectionString =
      config.sessiondb?.postgres?.connectionString ||
      config.sessiondb?.connectionString ||
      (process.env as any).MINSKY_POSTGRES_URL;

    if (!connectionString) {
      throw new Error(
        "PostgreSQL connection string not found. Configure sessiondb.postgres.connectionString or set MINSKY_POSTGRES_URL."
      );
    }

    if (dryRun) {
      // Build preview plan
      const maskedConn = connectionString.replace(/:\/\/[^:]+:[^@]+@/, "://***:***@");
      const { readdirSync } = await import("fs");
      const { basename } = await import("path");
      const migrationsFolder = "./src/domain/storage/migrations/pg";
      let fileNames: string[] = [];
      try {
        fileNames = readdirSync(migrationsFolder)
          .filter((n) => n.endsWith(".sql"))
          .sort((a, b) => a.localeCompare(b));
      } catch {
        // ignore
      }

      const postgres = (await import("postgres")).default;
      const sql = postgres(connectionString, { prepare: false, onnotice: () => {}, max: 5 });
      let schemaExists = false;
      let metaExists = false;
      let appliedCount = 0;
      let latestHash: string | undefined;
      let latestAt: string | undefined;
      try {
        const sch = await sql<{ exists: boolean }[]>`
          SELECT EXISTS (
            SELECT 1 FROM information_schema.schemata WHERE schema_name = 'drizzle'
          ) as exists;
        `;
        schemaExists = Boolean(sch?.[0]?.exists);
        const meta = await sql<{ exists: boolean }[]>`
          SELECT EXISTS (
            SELECT 1 FROM information_schema.tables WHERE table_schema = 'drizzle' AND table_name = '__drizzle_migrations'
          ) as exists;
        `;
        metaExists = Boolean(meta?.[0]?.exists);
        if (metaExists) {
          const rows = await sql<{ hash: string | null; created_at: string | null }[]>`
            SELECT hash, created_at::text FROM "drizzle"."__drizzle_migrations" ORDER BY created_at DESC LIMIT 1;
          `;
          latestHash = rows?.[0]?.hash || undefined;
          latestAt = rows?.[0]?.created_at || undefined;
          const cnt = await sql<{ count: string }[]>`
            SELECT COUNT(*)::text as count FROM "drizzle"."__drizzle_migrations";
          `;
          appliedCount = parseInt(cnt?.[0]?.count || "0", 10);
        }
      } catch {
        // best-effort only
      } finally {
        await sql.end();
      }

      const summary = `Schema migration (dry run) for postgres\nDatabase: ${maskedConn}\nMigrations: ${migrationsFolder}\nPlan: ${fileNames.length} file(s), ${appliedCount} applied, ${Math.max(
        fileNames.length - appliedCount,
        0
      )} pending`;

      const plan = {
        success: true,
        backend,
        dryRun: true,
        connection: maskedConn,
        migrationsFolder,
        message: `${summary}\n\n(use --execute to apply)`,
        status: {
          schema: schemaExists ? "present" : "missing",
          metaTable: metaExists ? "present" : "missing",
        },
        plan: {
          files: fileNames,
          fileCount: fileNames.length,
          appliedCount,
          pendingCount: Math.max(fileNames.length - appliedCount, 0),
          latestHash,
          latestAt,
        },
      } as const;

      if (verbose) {
        log.cli("=== SessionDB Schema Migration (postgres) — DRY RUN ===");
        log.cli("");
        log.cli(`Database: ${maskedConn}`);
        log.cli(`Migrations: ${migrationsFolder}`);
        log.cli("");
        log.cli(
          `Status: schema=${schemaExists ? "present" : "missing"}, metaTable=${
            metaExists ? "present" : "missing"
          }`
        );
        if (metaExists) {
          log.cli(
            `Meta: applied=${appliedCount}${latestHash ? `, latest=${latestHash}` : ""}${
              latestAt ? `, last_at=${latestAt}` : ""
            }`
          );
        }
        log.cli(
          `Plan: ${fileNames.length} file(s), ${appliedCount} applied, ${Math.max(
            fileNames.length - appliedCount,
            0
          )} pending`
        );
        if (fileNames.length > 0) {
          log.cli("");
          log.cli("Files:");
          fileNames.forEach((f, i) => log.cli(`  ${i + 1}. ${basename(f)}`));
        }
        log.cli("");
        log.cli("(use --execute to apply)");
        log.cli("");
      }

      return plan as any;
    }

    const { drizzle } = await import("drizzle-orm/postgres-js");
    const { migrate } = await import("drizzle-orm/postgres-js/migrator");
    const postgres = (await import("postgres")).default;
    const { readdirSync } = await import("fs");
    const { basename } = await import("path");

    const sql = postgres(connectionString, { prepare: false, onnotice: () => {}, max: 10 });
    try {
      const db = drizzle(sql, { logger: false });

      const masked = (() => {
        try {
          const u = new URL(connectionString);
          return `${u.host}${u.pathname}`;
        } catch {
          return "<connection>";
        }
      })();

      const migrationsFolder = "./src/domain/storage/migrations/pg";
      const files = (() => {
        try {
          return readdirSync(migrationsFolder)
            .filter((n) => n.endsWith(".sql"))
            .sort((a, b) => a.localeCompare(b));
        } catch {
          return [] as string[];
        }
      })();

      // Pre-check applied vs files
      let appliedCount = 0;
      let latestHash: string | undefined;
      let latestAt: string | undefined;
      let schemaExists = false;
      let metaExists = false;
      try {
        const sch = await sql<{ exists: boolean }[]>`
          SELECT EXISTS (
            SELECT 1 FROM information_schema.schemata WHERE schema_name = 'drizzle'
          ) as exists;
        `;
        schemaExists = Boolean(sch?.[0]?.exists);
        const meta = await sql<{ exists: boolean }[]>`
          SELECT EXISTS (
            SELECT 1 FROM information_schema.tables WHERE table_schema = 'drizzle' AND table_name = '__drizzle_migrations'
          ) as exists;
        `;
        metaExists = Boolean(meta?.[0]?.exists);
        if (metaExists) {
          const rows = await sql<
            { count: string; hash: string | null; created_at: string | null }[]
          >`
            SELECT COUNT(*)::text as count,
                   MAX(hash) as hash,
                   MAX(created_at)::text as created_at
            FROM "drizzle"."__drizzle_migrations";
          `;
          appliedCount = parseInt(rows?.[0]?.count || "0", 10);
          latestHash = rows?.[0]?.hash || undefined;
          latestAt = rows?.[0]?.created_at || undefined;
        }
      } catch {
        // best-effort pre-checks
      }

      if (verbose) {
        log.cli("=== SessionDB Schema Migration (postgres) ===");
        log.cli("");
        log.cli(`Database: ${masked}`);
        log.cli(`Migrations: ${migrationsFolder}`);
        log.cli("");
        log.cli(
          `Status: schema=${schemaExists ? "present" : "missing"}, metaTable=${
            metaExists ? "present" : "missing"
          }`
        );
        if (metaExists) {
          log.cli(
            `Meta: applied=${appliedCount}${latestHash ? `, latest=${latestHash}` : ""}${
              latestAt ? `, last_at=${latestAt}` : ""
            }`
          );
        }
        log.cli(
          `Plan: ${files.length} file(s), ${appliedCount} applied, ${Math.max(
            files.length - appliedCount,
            0
          )} pending`
        );
        if (files.length > 0) {
          log.cli("");
          log.cli(`Files:`);
          files.forEach((f, i) => log.cli(`  ${i + 1}. ${basename(f)}`));
        }
        log.cli("");
        log.cli(`Executing...`);
        log.cli("");
      }

      const start = Date.now();
      await migrate(db, { migrationsFolder });
      if (verbose) {
        const ms = Date.now() - start;
        // Re-check applied count
        try {
          const cnt2 = await sql<{ count: string; last: string | null }[]>`
            SELECT COUNT(*)::text as count, MAX(hash) as last FROM "drizzle"."__drizzle_migrations";
          `;
          const applied2 = parseInt(cnt2?.[0]?.count || "0", 10);
          const last = cnt2?.[0]?.last || "";
          log.cli(`Applied ${Math.max(applied2 - appliedCount, 0)} migration(s) in ${ms}ms`);
          if (last) log.cli(`Latest applied: ${last}`);
        } catch {
          log.cli(`Applied migrations in ${ms}ms`);
        }
      }
    } finally {
      await sql.end();
    }

    return {
      success: true,
      applied: true,
      backend,
      migrationsFolder: "./src/domain/storage/migrations/pg",
      message: `Schema migration applied for postgres (migrations: ./src/domain/storage/migrations/pg)`,
    };
  }

  throw new Error(`Unsupported backend: ${backend}`);
}

/**
 * Helper: run schema migrations for an explicit backend (used during data migrations to prep target DB)
 */
async function runSchemaMigrationsForBackend(
  backend: "sqlite" | "postgres",
  options: { verbose?: boolean; sqlitePath?: string; connectionString?: string } = {}
): Promise<void> {
  const { verbose = false, sqlitePath, connectionString } = options;
  if (backend === "sqlite") {
    const dbPath = sqlitePath || getDefaultSqliteDbPath();
    const { Database } = await import("bun:sqlite");
    const { drizzle } = await import("drizzle-orm/bun-sqlite");
    const { migrate } = await import("drizzle-orm/bun-sqlite/migrator");
    const sqlite = new Database(dbPath);
    try {
      const db = drizzle(sqlite, { logger: verbose });
      await migrate(db as any, { migrationsFolder: "./src/domain/storage/migrations" });
    } finally {
      sqlite.close();
    }
    return;
  }
  if (backend === "postgres") {
    const conn = connectionString;
    if (!conn) return; // rely on storage.initialize() fallback
    const { drizzle } = await import("drizzle-orm/postgres-js");
    const { migrate } = await import("drizzle-orm/postgres-js/migrator");
    const postgres = (await import("postgres")).default;
    const sql = postgres(conn, { prepare: false, onnotice: () => {}, max: 10 });
    try {
      const db = drizzle(sql, { logger: verbose });
      await migrate(db, { migrationsFolder: "./src/domain/storage/migrations/pg" });
    } finally {
      await sql.end();
    }
    return;
  }
}

// Register sessiondb migrate command
sharedCommandRegistry.registerCommand({
  id: "sessiondb.migrate",
  category: CommandCategory.SESSIONDB,
  name: "migrate",
  description:
    "Migrate session database between backends, or run schema migrations when no target is provided",
  parameters: sessiondbMigrateCommandParams,
  async execute(params: any, context: CommandExecutionContext) {
    const {
      to,
      from,
      sqlitePath,
      backup = true,
      execute,
      setDefault,
      dryRun = false,
      verbose = false,
    } = params;

    // If no target backend provided, run schema migrations for current backend
    if (!to) {
      try {
        log.cli("🚀 SessionDB Schema Migration (configured backend)");
        // DEFAULT: dry-run; require --execute to apply
        const shouldApply = Boolean(execute);
        const result = await runSchemaMigrationsForConfiguredBackend({
          dryRun: !shouldApply,
          verbose,
          showSql: Boolean((params as any)?.showSql),
        });

        if (context.format === "human") {
          if (result.dryRun) {
            return `Schema migration (dry run) for ${result.backend || "sqlite"} using ${result.migrationsFolder}`;
          }
          return `Schema migration applied for ${result.backend || "sqlite"} using ${result.migrationsFolder}`;
        }

        return result;
      } catch (error) {
        // Re-throw as proper Error while preserving original message for handler parsing
        throw ensureError(error);
      }
    }

    // DEFAULT: preview unless user passes --execute
    const isPreviewMode = !execute;

    try {
      // Guard against unsupported targets (JSON removed)
      if (to !== "sqlite" && to !== "postgres") {
        throw new Error(
          `❌ Unsupported backend target: ${String(to)}. Supported backends: sqlite, postgres`
        );
      }

      // Import configuration system for config-driven behavior
      const { getConfiguration } = await import("../../../domain/configuration/index");
      const config = getConfiguration();

      // Check for drift in current configuration
      const configuredBackend = config.sessiondb?.backend;
      // JSON backend has been removed; retain guardrails without impossible comparisons
      // (no action needed here)

      log.cli(`🚀 SessionDB Migration - Target: ${to}`);
      log.cli("");
      log.cli(`Mode: ${isPreviewMode ? "PREVIEW" : "EXECUTE"}`);
      log.cli(`Backup: ${backup ? "YES" : "NO"}`);

      // Read source data
      let sourceData: Record<string, any> = {};
      let sourceCount = 0;
      let sourceDescription = "configured session backend";
      let sourceBackendKind: "sqlite" | "postgres" | "file-json" | "unknown" = "unknown";
      let sqliteSourcePath: string | undefined;

      if (from && existsSync(from)) {
        // Read from specific file
        const fileContent = readFileSync(from, "utf8").toString();
        sourceData = JSON.parse(fileContent);
        sourceCount = Object.keys(sourceData).length;
        sourceDescription = `backup file: ${from}`;
        sourceBackendKind = "file-json";
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
          sourceBackendKind = "sqlite";
          sqliteSourcePath = dbPath;
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
          sourceBackendKind = "postgres";
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
              prBranch:
                (typedSessionData as any).prBranch || (typedSessionData as any).branch || "",
              ...typedSessionData,
            });
          }
        }
      }

      // Filter out legacy sessions without taskId
      const filteredRecords = sessionRecords.filter(
        (s) => typeof s.taskId === "string" && s.taskId.trim().length > 0
      );
      const skippedLegacy = sessionRecords.length - filteredRecords.length;

      // No need to normalize branch now that column is represented as prBranch in schema
      const normalizedRecords = filteredRecords;

      // Prepare operations plan
      const operations: string[] = [];
      operations.push(`Read source sessions (${sourceCount}) from ${sourceDescription}`);
      if (skippedLegacy > 0) {
        operations.push(`Skip ${skippedLegacy} legacy session(s) without a taskId`);
      }
      if (backup) {
        if (sourceBackendKind === "sqlite" && sqliteSourcePath) {
          operations.push(`Create SQLite file backup of source before migration`);
        } else {
          operations.push(`Create JSON backup of source before migration`);
        }
      }
      operations.push(
        `Write ${normalizedRecords.length} session(s) to target '${to}' backend (full replacement)`
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
          plannedInsertCount: normalizedRecords.length,
          operations,
        };
      }

      // Create backup if requested
      let backupPath: string | undefined;
      if (backup) {
        const stateDir = getMinskyStateDir();
        if (sourceBackendKind === "sqlite" && sqliteSourcePath) {
          // Create a real SQLite copy backup
          backupPath = join(stateDir, `session-backup-${Date.now()}.db`);
          const backupDir = dirname(backupPath);
          if (!existsSync(backupDir)) {
            mkdirSync(backupDir, { recursive: true });
          }
          copyFileSync(sqliteSourcePath, backupPath);
          log.cli(`SQLite backup created: ${backupPath}`);
        } else {
          // JSON backup of the read state
          backupPath = join(stateDir, `session-backup-${Date.now()}.json`);
          const backupDir = dirname(backupPath);
          if (!existsSync(backupDir)) {
            mkdirSync(backupDir, { recursive: true });
          }
          writeFileSync(backupPath, JSON.stringify(sourceData, null, 2));
          log.cli(`Backup created: ${backupPath}`);
        }
      }

      // Create target storage with config-driven approach
      const targetConfig: any = { backend: to };
      let targetSqlitePath: string | undefined;
      let targetPostgresConn: string | undefined;

      if (to === "sqlite") {
        targetSqlitePath = sqlitePath || getDefaultSqliteDbPath();
        targetConfig.sqlite = {
          dbPath: targetSqlitePath,
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
          `Using PostgreSQL connection: ${connectionString.replace(/:\/\/[^:]+:[^@]+@/, "://***:***@")}`
        );
        targetPostgresConn = connectionString;
        targetConfig.postgres = { connectionString: connectionString };
      }

      const targetStorage = createStorageBackend(targetConfig);
      await targetStorage.initialize();

      // Ensure target schema is fully migrated before writing
      await runSchemaMigrationsForBackend(to, {
        verbose,
        sqlitePath: targetSqlitePath,
        connectionString: targetPostgresConn,
      });

      // Show execute plan (same as preview) before applying
      log.cli("");
      log.cli("📝 Migration plan (execute):");
      operations.forEach((op, idx) => log.cli(`  ${idx + 1}. ${op}`));
      // Add a blank line after the plan for nicer spacing before any subsequent output
      log.cli("");

      // Write to target backend
      const targetState = {
        sessions: normalizedRecords,
        baseDir: getMinskyStateDir(),
      };

      const writeResult = await targetStorage.writeState(targetState);
      if (!writeResult.success) {
        const msg = writeResult.error?.message || "database operation failed";
        throw new Error(`Failed to write to target backend: ${msg}`);
      }
      log.cli(
        `✅ Data successfully migrated to target backend (${normalizedRecords.length} sessions)`
      );

      const targetCount = normalizedRecords.length;
      log.cli(
        `Migration completed: ${sourceCount} source sessions -> ${targetCount} target sessions`
      );

      // Handle setDefault option
      if (setDefault) {
        log.cli(`\n🔧 Updating configuration to use ${to} backend as default...`);
        log.cli(`✅ Configuration update requested. Please manually update your config file:`);
        log.cli(`\n[sessiondb]`);
        log.cli(`backend = "${to}"`);

        if (to === "postgres") {
          const connectionString = targetPostgresConn;
          if (connectionString) {
            log.cli(`\n[sessiondb.postgres]`);
            log.cli(`connectionString = "${connectionString}"`);
          }
        } else if (to === "sqlite" && targetSqlitePath) {
          log.cli(`\n[sessiondb.sqlite]`);
          log.cli(`path = "${targetSqlitePath}"`);
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
      // Re-throw as proper Error while preserving original message for handler parsing
      throw ensureError(error);
    }
  },
});

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

        // Guard against unsupported historical backends
        if (configuredBackend && !["sqlite", "postgres"].includes(configuredBackend as string)) {
          throw new Error(
            `❌ CRITICAL: Unsupported backend configured: ${configuredBackend}. ` +
              "Supported backends: sqlite, postgres"
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

        if (
          Array.isArray((validationResult as any).issues) &&
          (validationResult as any).issues.length > 0
        ) {
          log.cli(`\n⚠️ Issues Found:`);
          (validationResult as any).issues.forEach((issue: string, idx: number) => {
            log.cli(`  ${idx + 1}. ${issue}`);
          });
        }

        if (
          Array.isArray((validationResult as any).suggestions) &&
          (validationResult as any).suggestions.length > 0
        ) {
          log.cli(`\n💡 Suggestions:`);
          (validationResult as any).suggestions.forEach((suggestion: string, idx: number) => {
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
      if (Array.isArray(integrityResult.issues) && integrityResult.issues.length > 0) {
        issues.push(...integrityResult.issues);
      }
      if (
        Array.isArray(integrityResult.suggestedActions) &&
        integrityResult.suggestedActions.length > 0
      ) {
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
