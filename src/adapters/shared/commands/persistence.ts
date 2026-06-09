/**
 * Shared Persistence Commands
 *
 * This module contains shared persistence command implementations for
 * database migration and management operations, as well as low-level query operations
 * for MCP agents to inspect database records across all persistence backends.
 */

import { z } from "zod";
import { writeFileSync, existsSync, mkdirSync, copyFileSync } from "fs";
import { readTextFileSync } from "@minsky/shared/fs";
import { dirname, join } from "path";
import { getErrorMessage, ensureError } from "@minsky/domain/errors/index";
import { sharedCommandRegistry, CommandCategory } from "../../shared/command-registry";
import { PersistenceProviderFactory } from "@minsky/domain/persistence/factory";
import { log } from "@minsky/shared/logger";
import type { SessionRecord } from "@minsky/domain/session/session-db";
import { getMinskyStateDir, getDefaultSqliteDbPath } from "@minsky/shared/paths";
import { runSchemaMigrationsForConfiguredBackend } from "@minsky/domain/persistence/migration-operations";
import {
  validateSqliteBackend,
  validatePostgresBackend,
} from "@minsky/domain/persistence/validation-operations";
import { getEffectivePersistenceConfig } from "@minsky/domain/configuration/persistence-config";
import type { AppContainerInterface } from "@minsky/domain/composition/types";

/**
 * Parameters for the persistence migrate command
 */
const persistenceMigrateCommandParams = {
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
  // verbose removed: full details shown by default
  debug: {
    schema: z.boolean(),
    description: "Enable debug mode for detailed output",
    required: false,
  },
};

/**
 * Parameters for the persistence check command
 */
const persistenceCheckCommandParams = {
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

/**
 * Register all persistence commands
 */
export function registerPersistenceCommands(container?: AppContainerInterface): void {
  // Lazy-deps closure — matches session/git commands pattern (mt#929)
  const getPersistenceDeps = () => ({
    sessionProvider: container?.has("sessionProvider")
      ? container.get("sessionProvider")
      : undefined,
    persistence: container?.has("persistence") ? container.get("persistence") : undefined,
  });

  // Register persistence migrate command
  sharedCommandRegistry.registerCommand({
    id: "persistence.migrate",
    category: CommandCategory.PERSISTENCE,
    name: "migrate",
    description:
      "Migrate session database between backends, or run schema migrations when no target is provided",
    requiresSetup: false,
    parameters: persistenceMigrateCommandParams,
    async execute(params, context) {
      const {
        to,
        from,
        // sqlitePath param retained on the schema but unused: SQLite is no longer a
        // valid migration target (sessions are Postgres-only, mt#2329).
        sqlitePath: _sqlitePath,
        backup = true,
        execute,
        setDefault,
        dryRun: _dryRun = false,
      } = params;

      // If no target backend provided, run schema migrations for current backend
      if (!to) {
        try {
          // Auto-detect backend and run appropriate migration flow
          const { getConfiguration } = await import("@minsky/domain/configuration/index");
          const config = getConfiguration();
          const backend = getEffectivePersistenceConfig(config).backend as "sqlite" | "postgres";

          const shouldApply = Boolean(execute);

          if (backend === "postgres") {
            if (!shouldApply) {
              const result = await runSchemaMigrationsForConfiguredBackend({ dryRun: true });
              return result;
            }

            const result = await runSchemaMigrationsForConfiguredBackend({ dryRun: false });
            return result;
          }

          // SQLite: reuse existing helper (preview or apply)
          const result = await runSchemaMigrationsForConfiguredBackend({ dryRun: !shouldApply });

          if (context.format === "human") {
            // eslint-disable-next-line custom/no-excessive-as-unknown -- migration result union lacks index signature; cast required for backward-compatible key-based rendering
            const resultObj = result as unknown as Record<string, unknown>;
            if (resultObj && typeof resultObj === "object" && resultObj.message) {
              return resultObj.message as string;
            }
            if (resultObj.dryRun) {
              return `Schema migration (dry run) for ${resultObj.backend || "sqlite"}`;
            }
            return `Schema migration applied for ${resultObj.backend || "sqlite"}`;
          }

          return result;
        } catch (error) {
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
        // mt#2329 / ADR-018: sessions are Postgres-only. Session writes go through
        // the Postgres-only DrizzleSessionRepository, so a SQLite TARGET can no
        // longer perform a session migration (migrating FROM sqlite TO postgres
        // remains the valid direction). Fail fast with a clear message rather than
        // throwing deep in the repository. The broader SQLite removal is mt#2349.
        if (to === "sqlite") {
          throw new Error(
            "❌ Session migration to a SQLite target is no longer supported: sessions are " +
              "Postgres-only (ADR-018 / mt#2329). Migrate to postgres instead. " +
              "SQLite removal is tracked by mt#2349."
          );
        }

        // Import configuration system for config-driven behavior
        const { getConfiguration } = await import("@minsky/domain/configuration/index");
        const config = getConfiguration();

        log.cli(`🚀 Persistence Migration - Target: ${to}`);
        log.cli("");
        log.cli(`Mode: ${isPreviewMode ? "PREVIEW" : "EXECUTE"}`);
        log.cli(`Backup: ${backup ? "YES" : "NO"}`);

        // Read source data
        let sourceData: Record<string, unknown> = {};
        let sourceCount = 0;
        let sourceDescription = "configured session backend";
        let sourceBackendKind: "sqlite" | "postgres" | "file-json" | "unknown" = "unknown";
        let sqliteSourcePath: string | undefined;

        if (from && existsSync(from)) {
          // Read from specific file
          const fileContent = readTextFileSync(from);
          sourceData = JSON.parse(fileContent);
          sourceCount = Object.keys(sourceData).length;
          sourceDescription = `backup file: ${from}`;
          sourceBackendKind = "file-json";
          log.cli(`Reading from backup file: ${from} (${sourceCount} sessions)`);
        } else {
          // Read from CURRENT configured backend (no JSON fallback)
          const effectivePersistence = getEffectivePersistenceConfig(config);
          const configuredBackend = effectivePersistence.backend as "sqlite" | "postgres";
          if (!configuredBackend) {
            throw new Error(
              "No persistence backend configured. Configure sqlite or postgres in persistence config."
            );
          }

          const sourceConfig: Record<string, unknown> = { backend: configuredBackend };
          if (configuredBackend === "sqlite") {
            const dbPath = effectivePersistence.dbPath ?? getDefaultSqliteDbPath();
            sourceConfig.sqlite = { dbPath };
            sourceDescription = `SQLite backend: ${dbPath}`;
            sourceBackendKind = "sqlite";
            sqliteSourcePath = dbPath;
          } else if (configuredBackend === "postgres") {
            const connectionString = effectivePersistence.connectionString;
            if (!connectionString) {
              throw new Error(
                "PostgreSQL connection string not found in configuration or MINSKY_POSTGRES_URL."
              );
            }
            // Use the full postgres sub-object so pool settings (maxConnections, etc.) are preserved.
            sourceConfig.postgres = effectivePersistence.postgres ?? { connectionString };
            sourceDescription = "PostgreSQL backend (configured)";
            sourceBackendKind = "postgres";
          }

          // Get sessions through SessionProviderInterface via DI closure
          const { sessionProvider } = getPersistenceDeps();
          if (!sessionProvider) {
            throw new Error(
              "DI container missing 'sessionProvider'. Ensure container.initialize() was called before command execution."
            );
          }
          const sessions = await sessionProvider.listSessions();
          sourceData = { sessions, baseDir: getMinskyStateDir() };
          sourceCount = sessions.length;
          log.cli(`Reading from ${sourceDescription} (${sourceCount} sessions)`);
        }

        // Build normalized list of session records
        const sessionRecords: SessionRecord[] = [];
        if (Array.isArray(sourceData.sessions)) {
          sessionRecords.push(...sourceData.sessions);
        } else if (typeof sourceData === "object" && sourceData !== null) {
          for (const [sessionId, sessionData] of Object.entries(sourceData)) {
            if (typeof sessionData === "object" && sessionData !== null) {
              const typedSessionData = sessionData as Partial<SessionRecord>;
              sessionRecords.push({
                sessionId: sessionId,
                repoName: typedSessionData.repoName || sessionId,
                repoUrl: typedSessionData.repoUrl || sessionId,
                createdAt: typedSessionData.createdAt || new Date().toISOString(),
                taskId: typedSessionData.taskId || "",
                prBranch:
                  typedSessionData.prBranch ||
                  ((typedSessionData as Record<string, unknown>)["branch"] as string) ||
                  "",
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
            backupPath = join(stateDir, `session-backup-${Date.now()}.db`);
            const backupDir = dirname(backupPath);
            if (!existsSync(backupDir)) {
              mkdirSync(backupDir, { recursive: true });
            }
            copyFileSync(sqliteSourcePath, backupPath);
            log.cli(`SQLite backup created: ${backupPath}`);
          } else {
            backupPath = join(stateDir, `session-backup-${Date.now()}.json`);
            const backupDir = dirname(backupPath);
            if (!existsSync(backupDir)) {
              mkdirSync(backupDir, { recursive: true });
            }
            writeFileSync(backupPath, JSON.stringify(sourceData, null, 2));
            log.cli(`Backup created: ${backupPath}`);
          }
        }

        // Create target storage. `to` is narrowed to "postgres" by the
        // SQLite-target guard above (sessions are Postgres-only, ADR-018 / mt#2329).
        const targetConfig: Record<string, unknown> = { backend: to };
        const effectiveTarget = getEffectivePersistenceConfig(config);
        const connectionString = effectiveTarget.connectionString;
        if (!connectionString) {
          throw new Error(
            "PostgreSQL connection string not found. " +
              "Please configure persistence.postgres.connectionString in config file or set MINSKY_POSTGRES_URL environment variable."
          );
        }
        log.cli(
          `Using PostgreSQL connection: ${connectionString.replace(/:\/\/[^:]+:[^@]+@/, "://***:***@")}`
        );
        // Use the full postgres sub-object so pool settings are preserved.
        targetConfig.postgres = effectiveTarget.postgres ?? { connectionString };

        // Source sessions for the write: use the normalized records computed
        // above — they honor `--from` when a backup file was supplied and skip
        // legacy taskId-less rows. (R2 BLOCKING fix: EXECUTE previously did a
        // second listSessions() re-read, ignoring `--from`. The bug pre-dates this
        // PR — the top-of-command source read already used listSessions for the
        // configured backend — but it is fixed here while this path is touched.)
        const sourceState = {
          sessions: normalizedRecords,
          baseDir: getMinskyStateDir(),
        };

        log.cli(`✅ Migrating ${sourceState.sessions.length} session(s) to the target backend`);

        // Create target provider with new backend
        const newTargetConfig = { ...targetConfig, backend: to };
        const targetProvider = await PersistenceProviderFactory.create(newTargetConfig);
        await targetProvider.initialize();

        // Full replacement (preserves the retired writeState semantics that the
        // plan text above promises): clear the target sessions table and bulk-
        // insert the source rows in ONE transaction. (R3 BLOCKING: the per-record
        // addSession loop did blind inserts — not a replacement — which could
        // conflict on a same-DB target and contradicted the "full replacement"
        // plan wording.) Sessions are Postgres-only (ADR-018); the broader migrate
        // rework is mt#2349.
        const { postgresSessions, toPostgresInsert } = await import(
          "@minsky/domain/storage/schemas/session-schema"
        );
        const targetDb = (await targetProvider.getDatabaseConnection?.()) as
          | import("drizzle-orm/postgres-js").PostgresJsDatabase
          | undefined;
        if (!targetDb) {
          throw new Error(
            "Target provider returned no Postgres connection for the migration write."
          );
        }
        await targetDb.transaction(async (tx) => {
          await tx.delete(postgresSessions);
          const BATCH_SIZE = 250;
          for (let i = 0; i < sourceState.sessions.length; i += BATCH_SIZE) {
            const slice = sourceState.sessions.slice(i, i + BATCH_SIZE);
            if (slice.length > 0) {
              await tx.insert(postgresSessions).values(slice.map((s) => toPostgresInsert(s)));
            }
          }
        });

        log.cli(
          `✅ Data successfully migrated to ${to} backend (${sourceState.sessions.length} sessions)`
        );
      } catch (error) {
        throw ensureError(error);
      }
    },
  });

  // Register persistence check command
  sharedCommandRegistry.registerCommand({
    id: "persistence.check",
    category: CommandCategory.PERSISTENCE,
    name: "check",
    description: "Check database integrity and detect issues",
    requiresSetup: false,
    parameters: persistenceCheckCommandParams,
    async execute(params, context) {
      const { file, backend, fix, report } = params;

      try {
        const { getConfiguration } = await import("@minsky/domain/configuration/index");

        let targetBackend: "sqlite" | "postgres";
        let sourceInfo: string;

        if (backend) {
          targetBackend = backend;
          sourceInfo = `Backend forced to: ${backend}`;
        } else {
          const config = getConfiguration();
          const configuredBackend = getEffectivePersistenceConfig(config).backend;

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

        log.cli(`🔍 Persistence Check - ${sourceInfo}`);

        let validationResult: {
          success: boolean;
          details: string;
          issues?: string[];
          suggestions?: string[];
        };

        if (targetBackend === "sqlite") {
          validationResult = await validateSqliteBackend(file);
        } else if (targetBackend === "postgres") {
          const { persistence: persistenceProvider } = getPersistenceDeps();
          if (!persistenceProvider) {
            throw new Error("persistenceProvider is required for postgres backend validation");
          }
          validationResult = await validatePostgresBackend(persistenceProvider);
        } else {
          const { getAvailableBackendsString } = await import("@minsky/domain/tasks/taskConstants");
          throw new Error(
            `Unknown backend: ${targetBackend}. Available backends: ${getAvailableBackendsString()}`
          );
        }

        if (report || !validationResult.success) {
          log.cli(`\n📊 Validation Results:`);
          log.cli(`Status: ${validationResult.success ? "✅ HEALTHY" : "❌ ISSUES FOUND"}`);
          log.cli(`Details: ${validationResult.details}`);

          if (Array.isArray(validationResult.issues) && validationResult.issues.length > 0) {
            log.cli(`\n⚠️ Issues Found:`);
            validationResult.issues.forEach((issue: string, idx: number) => {
              log.cli(`  ${idx + 1}. ${issue}`);
            });
          }

          if (
            Array.isArray(validationResult.suggestions) &&
            validationResult.suggestions.length > 0
          ) {
            log.cli(`\n💡 Suggestions:`);
            validationResult.suggestions.forEach((suggestion: string, idx: number) => {
              log.cli(`  ${idx + 1}. ${suggestion}`);
            });
          }
        }

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

  log.debug("Persistence commands registered");
}
