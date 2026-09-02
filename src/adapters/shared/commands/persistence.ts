/**
 * Shared Persistence Commands
 *
 * This module contains shared persistence command implementations for
 * database migration and management operations, as well as low-level query operations
 * for MCP agents to inspect database records across all persistence backends.
 */

import { z } from "zod";
import { writeFileSync, existsSync, mkdirSync } from "fs";
import { readTextFileSync } from "@minsky/shared/fs";
import { dirname, join } from "path";
import { getErrorMessage, ensureError } from "@minsky/domain/errors/index";
import { sharedCommandRegistry, CommandCategory } from "../../shared/command-registry";
import type { SharedCommandRegistry } from "../../shared/command-registry";
import { PersistenceProviderFactory } from "@minsky/domain/persistence/factory";
import { log } from "@minsky/shared/logger";
import type { SessionRecord } from "@minsky/domain/session/session-db";
import { getMinskyStateDir } from "@minsky/shared/paths";
import { runSchemaMigrationsForConfiguredBackend } from "@minsky/domain/persistence/migration-operations";
import { validatePostgresBackend } from "@minsky/domain/persistence/validation-operations";
import {
  connectionTargetHost,
  getEffectivePersistenceConfig,
  resolvePersistenceTargetHost,
} from "@minsky/domain/configuration/persistence-config";
import type { AppContainerInterface } from "@minsky/domain/composition/types";

/**
 * Parameters for the persistence migrate command
 */
const persistenceMigrateCommandParams = {
  to: {
    schema: z.enum(["postgres"]).optional(),
    description: "Target backend type (if omitted, run schema migrations for current backend)",
    required: false,
  },
  from: {
    schema: z.string(),
    description: "Source file path (auto-detect if not provided)",
    required: false,
  },
  backup: {
    schema: z.boolean().default(true),
    description: "Create backup before migration (default: true)",
    required: false,
  },
  execute: {
    schema: z.boolean(),
    description:
      "Actually perform the migration (default is preview mode). Ignored when --dry-run " +
      "is also set — --dry-run always wins.",
    required: false,
  },
  dryRun: {
    schema: z.boolean(),
    description:
      "Force preview mode and take precedence over --execute, so `--dry-run --execute` " +
      "previews rather than applies. Applies to both schema-only mode and backend migration.",
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
  backend: {
    schema: z.enum(["postgres"]),
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
 * Resolve whether a `persistence migrate` invocation runs in preview
 * (dry-run) mode.
 *
 * `--dry-run` FORCES preview and takes precedence over `--execute` — an
 * operator who explicitly asks for a dry run must never have `--execute`
 * silently win (mt#3191). This is a single, explicit, unit-testable seam
 * shared by both the schema-only migration path and the backend-migration
 * path in the `persistence.migrate` handler below, rather than the
 * precedence falling out incidentally from two separate computations.
 */
export function resolveMigratePreviewMode(params: {
  execute?: boolean;
  dryRun?: boolean;
}): boolean {
  return Boolean(params.dryRun) || !params.execute;
}

/**
 * Test-only override hooks for `registerPersistenceCommands`.
 *
 * `runSchemaMigrations` lets a handler-level test stub out the real
 * migration runner (which otherwise requires a live Postgres connection)
 * while still exercising the actual `persistence.migrate` command handler —
 * DI-via-optional-parameter, per the project's `custom/no-global-module-mocks`
 * ESLint rule (mirrors the `listReviewsImpl` pattern in
 * `asks-github-client.ts`). Defaults to the real imported function in
 * production; unused outside tests.
 */
export interface PersistenceCommandOverrides {
  runSchemaMigrations?: typeof runSchemaMigrationsForConfiguredBackend;
}

/**
 * Render the resolved persistence target HOST for operator output (mt#4789).
 *
 * Host only: the connection string carries the password, and this text goes to
 * a terminal whose output is persisted and ingested.
 *
 * **Never throws.** A diagnostic line must not be able to fail the operation it
 * describes — and `getConfiguration()` DOES throw when configuration was never
 * initialized, which is the normal state for the handler tests that exercise
 * these commands through DI overrides. Reporting a migrate as failed because
 * its "which database?" banner could not render would be strictly worse than
 * the silence this task set out to fix. The reason is surfaced in the line
 * rather than swallowed.
 */
async function describeResolvedTargetHost(): Promise<string> {
  try {
    const { getConfiguration } = await import("@minsky/domain/configuration/index");
    return resolvePersistenceTargetHost(getConfiguration()) ?? "(none configured)";
  } catch (err) {
    return `(unresolved: ${getErrorMessage(err)})`;
  }
}

/**
 * Register all persistence commands.
 *
 * `registry` mirrors the `registerProvenanceCommands(container?, registry?)`
 * convention (`./provenance.ts`) — defaults to the shared singleton in
 * production, but accepts an isolated `createSharedCommandRegistry()`
 * instance so handler-level tests can register + exercise the real command
 * without touching global registry state.
 */
export function registerPersistenceCommands(
  container?: AppContainerInterface,
  registry?: SharedCommandRegistry,
  overrides?: PersistenceCommandOverrides
): void {
  const targetRegistry = registry ?? sharedCommandRegistry;
  const runSchemaMigrations =
    overrides?.runSchemaMigrations ?? runSchemaMigrationsForConfiguredBackend;

  // Lazy-deps closure — matches session/git commands pattern (mt#929)
  const getPersistenceDeps = () => ({
    sessionProvider: container?.has("sessionProvider")
      ? container.get("sessionProvider")
      : undefined,
    persistence: container?.has("persistence") ? container.get("persistence") : undefined,
  });

  // Register persistence migrate command
  targetRegistry.registerCommand({
    id: "persistence.migrate",
    category: CommandCategory.PERSISTENCE,
    name: "migrate",
    // mt#3924: drift-gated — runs schema migrations; stale migration code against a
    // newer database is the corruption path the gate exists for.
    mutating: true,
    description:
      "Migrate session database between backends, or run schema migrations when no target is provided",
    requiresSetup: false,
    parameters: persistenceMigrateCommandParams,
    async execute(params, context) {
      const { to, from, backup = true, execute, dryRun = false } = params;

      // DEFAULT: preview unless --execute is passed. --dry-run forces preview
      // and takes precedence over --execute — computed once, here, and shared
      // by both the schema-only path (immediately below) and the backend
      // migration path further down (mt#3191).
      const isPreviewMode = resolveMigratePreviewMode({ execute, dryRun });

      // If no target backend provided, run schema migrations for the configured
      // (Postgres-only, ADR-018 / mt#2349) backend.
      if (!to) {
        try {
          // mt#4789 (PR #3573 R1): this path APPLIES MIGRATIONS to whatever the
          // configuration resolves to, and was the one branch of this family
          // that never said which database that is — the most expensive place
          // to stay silent, not the least.
          log.cli(`🎯 Resolved target host: ${await describeResolvedTargetHost()}`);

          const result = await runSchemaMigrations({ dryRun: isPreviewMode });

          if (context.format === "human") {
            // eslint-disable-next-line custom/no-excessive-as-unknown -- migration result union lacks index signature; cast required for backward-compatible key-based rendering
            const resultObj = result as unknown as Record<string, unknown>;
            if (resultObj && typeof resultObj === "object" && resultObj.message) {
              return resultObj.message as string;
            }
            if (resultObj.dryRun) {
              return `Schema migration (dry run) for ${resultObj.backend || "postgres"}`;
            }
            return `Schema migration applied for ${resultObj.backend || "postgres"}`;
          }

          return result;
        } catch (error) {
          throw ensureError(error);
        }
      }

      try {
        // `to` is constrained to "postgres" by the param schema (sessions are
        // Postgres-only, ADR-018 / mt#2329). Import configuration system for
        // config-driven behavior.
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

        if (from && existsSync(from)) {
          // Read from specific file
          const fileContent = readTextFileSync(from);
          sourceData = JSON.parse(fileContent);
          sourceCount = Object.keys(sourceData).length;
          sourceDescription = `backup file: ${from}`;
          log.cli(`Reading from backup file: ${from} (${sourceCount} sessions)`);
        } else {
          // Read from CURRENT configured backend (no JSON fallback)
          const effectivePersistence = getEffectivePersistenceConfig(config);
          const configuredBackend = effectivePersistence.backend;
          if (!configuredBackend) {
            throw new Error(
              "No persistence backend configured. Configure postgres in persistence config."
            );
          }

          const sourceConfig: Record<string, unknown> = { backend: configuredBackend };
          const connectionString = effectivePersistence.connectionString;
          if (!connectionString) {
            throw new Error(
              "PostgreSQL connection string not found in configuration or MINSKY_POSTGRES_URL."
            );
          }
          // Use the full postgres sub-object so pool settings (maxConnections, etc.) are preserved.
          sourceConfig.postgres = effectivePersistence.postgres ?? { connectionString };
          sourceDescription = "PostgreSQL backend (configured)";

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
          operations.push(`Create JSON backup of source before migration`);
        }
        operations.push(
          `Write ${normalizedRecords.length} session(s) to target '${to}' backend (full replacement)`
        );

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

        // Create backup if requested (JSON snapshot of the source data)
        let backupPath: string | undefined;
        if (backup) {
          const stateDir = getMinskyStateDir();
          backupPath = join(stateDir, `session-backup-${Date.now()}.json`);
          const backupDir = dirname(backupPath);
          mkdirSync(backupDir, { recursive: true });
          writeFileSync(backupPath, JSON.stringify(sourceData, null, 2));
          log.cli(`Backup created: ${backupPath}`);
        }

        // Create target storage. `to` is "postgres" (sessions are Postgres-only,
        // ADR-018 / mt#2329).
        const targetConfig: Record<string, unknown> = { backend: to };
        const effectiveTarget = getEffectivePersistenceConfig(config);
        const connectionString = effectiveTarget.connectionString;
        if (!connectionString) {
          throw new Error(
            "PostgreSQL connection string not found. " +
              "Please configure persistence.postgres.connectionString in config file or set MINSKY_POSTGRES_URL environment variable."
          );
        }
        // mt#4789: this was a hand-rolled redaction regex over the full connection
        // string. A redaction pattern that matches nothing emits its input
        // UNCHANGED and is indistinguishable from one that fired — this repo has
        // already leaked a production password exactly that way, on a
        // `postgres://` vs `postgresql://` mismatch (see
        // `terminal-command-best-practices.mdc §Secret handling`). This pattern
        // has the same shape of hole: a connection string with no userinfo, or
        // one carrying its password outside `user:pass@`, passes through intact.
        // The host cannot carry a credential, so print that instead.
        log.cli(
          `🎯 Resolved target host: ${connectionTargetHost(connectionString) ?? "(none configured)"}`
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
  targetRegistry.registerCommand({
    id: "persistence.check",
    category: CommandCategory.PERSISTENCE,
    name: "check",
    description: "Check database integrity and detect issues",
    requiresSetup: false,
    parameters: persistenceCheckCommandParams,
    async execute(params, _context) {
      const { backend, fix, report } = params;

      try {
        const { getConfiguration } = await import("@minsky/domain/configuration/index");

        let targetBackend: "postgres";
        let sourceInfo: string;

        if (backend) {
          targetBackend = backend;
          sourceInfo = `Backend forced to: ${backend}`;
        } else {
          const config = getConfiguration();
          const configuredBackend = getEffectivePersistenceConfig(config).backend;

          if (!configuredBackend || configuredBackend !== "postgres") {
            throw new Error(
              `❌ CRITICAL: Invalid or unsupported backend configured: ${configuredBackend}. ` +
                "Supported backend: postgres"
            );
          }

          targetBackend = "postgres";
          sourceInfo = `Backend auto-detected from configuration: ${targetBackend}`;
        }

        log.cli(`🔍 Persistence Check - ${sourceInfo}`);

        // mt#4789: "which database am I about to talk to?" is the question whose
        // silent wrong answer is production. Routed through the same non-throwing
        // helper as the migrate paths — with `--backend` forced, this command
        // never reads config, so an unconditional `getConfiguration()` here had
        // the same latent throw the reviewer found on the schema-only path.
        log.cli(`🎯 Resolved target host: ${await describeResolvedTargetHost()}`);

        const { persistence: persistenceProvider } = getPersistenceDeps();
        if (!persistenceProvider) {
          throw new Error("persistenceProvider is required for postgres backend validation");
        }
        const validationResult: {
          success: boolean;
          details: string;
          issues?: string[];
          suggestions?: string[];
        } = await validatePostgresBackend(persistenceProvider);

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
          // Suppress the formatter's trailing status line only when this run
          // actually printed a VERDICT, which is the same condition that gates
          // the "📊 Validation Results / Status:" block above (mt#3961, PR
          // #2859 R1).
          //
          // The per-check ✅ lines are not a verdict. On the happy path without
          // `--report` they are all that prints, and the formatter's
          // "✅ Success" is what tells the operator the run passed overall —
          // suppressing it there would remove the outcome rather than a
          // duplicate of it.
          ...(report || !validationResult.success ? { printed: true } : {}),
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
