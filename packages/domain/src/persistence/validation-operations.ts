/**
 * Validation Operations
 *
 * Domain logic for persistence backend validation.
 * Extracted from adapters/shared/commands/persistence.ts to maintain
 * clean architecture boundaries.
 */

import { getErrorMessage } from "../errors/index";
import { log } from "@minsky/shared/logger";
import { getEffectivePersistenceConfig } from "../configuration/persistence-config";
import type { PersistenceProvider } from "./types";
import { getPostgresMigrationsStatus } from "./migration-operations";
import { logPostgresNotice } from "./postgres-notice-handler";
import { maskConnectionString } from "./connection-string";

/**
 * Probe basic connectivity to a Postgres connection string by running a
 * trivial `SELECT 1`. Unlike {@link validatePostgresBackend} (which validates
 * the *configured* backend via an initialized PersistenceProvider), this works
 * against an EXPLICIT connection string and does not read global config — so
 * the `setup db` onboarding wizard can verify a string the user just supplied
 * BEFORE it is written to config (mt#2429).
 *
 * Never throws: connection/auth/timeout failures are returned as
 * `{ ok: false, error }` with the password masked so the caller can render a
 * clean, actionable message.
 */
export async function verifyPostgresConnectivity(
  connectionString: string,
  options: { connectTimeoutSeconds?: number } = {}
): Promise<{ ok: boolean; error?: string }> {
  const { connectTimeoutSeconds = 10 } = options;
  const postgres = (await import("postgres")).default;
  const sql = postgres(connectionString, {
    prepare: false,
    onnotice: logPostgresNotice,
    max: 1,
    connect_timeout: connectTimeoutSeconds,
  });
  try {
    await sql`SELECT 1 as ok`;
    return { ok: true };
  } catch (error) {
    // Mask any embedded credentials — postgres-js errors can include the
    // connection string verbatim (PR #1666 review).
    return { ok: false, error: maskConnectionString(getErrorMessage(error)) };
  } finally {
    try {
      await sql.end({ timeout: 5 });
    } catch {
      // Best-effort cleanup; a failure to close the probe connection must not
      // mask the connectivity result.
    }
  }
}

/**
 * Validate PostgreSQL backend
 */
export async function validatePostgresBackend(persistenceProvider: PersistenceProvider): Promise<{
  success: boolean;
  details: string;
  issues?: string[];
  suggestions?: string[];
}> {
  const issues: string[] = [];
  const suggestions: string[] = [];

  try {
    // Import configuration to get connection details
    const { getConfiguration } = await import("../configuration/index");
    const config = getConfiguration();

    // Get PostgreSQL connection string
    const connectionString = getEffectivePersistenceConfig(config).connectionString;

    if (!connectionString) {
      issues.push("No PostgreSQL connection string configured");
      suggestions.push(
        "Set persistence.postgres.connectionString in config or MINSKY_POSTGRES_URL env var"
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

    const provider: PersistenceProvider = persistenceProvider;

    // Test basic connectivity
    if (provider.getCapabilities().sql) {
      const rawConnection = (await provider.getRawSqlConnection?.()) as
        | ReturnType<typeof import("postgres")>
        | undefined;
      if (rawConnection) {
        // Test SQL query
        await rawConnection`SELECT 1 as test`;
        log.cli("✅ Database connection successful");
      }
    } else {
      log.cli("✅ Non-SQL backend initialized successfully");
    }

    // Additional checks for PostgreSQL
    if (provider.getCapabilities().sql) {
      try {
        // Check schema is up to date (no pending migrations)
        const { getConfiguration } = await import("../configuration/index");
        const config = getConfiguration();
        const effectiveInner = getEffectivePersistenceConfig(config);
        const backend = effectiveInner.backend;

        if (backend === "postgres") {
          const connectionString = effectiveInner.connectionString;

          if (connectionString) {
            const status = await getPostgresMigrationsStatus(connectionString);
            if (status.pendingCount === 0) {
              log.cli(`✅ Schema up to date (${status.appliedCount} migrations applied)`);
            } else {
              log.cli(`⚠️  Schema outdated: ${status.pendingCount} pending migrations`);
              log.cli(`   Run: minsky persistence migrate --execute`);
            }
          }
        }

        // Test vector storage if supported
        if (provider.getCapabilities().vectorStorage) {
          try {
            const vectorStorage = await provider.getVectorStorageForDomain?.("tasks", 1536); // OpenAI embedding dimension
            if (vectorStorage) {
              // Try a simple vector operation with a dummy vector (all zeros)
              const dummyVector = new Array(1536).fill(0);
              const _testResults = await vectorStorage.search(dummyVector, {
                limit: 1,
              });
              log.cli("✅ Vector storage accessible and functional");
            }
          } catch (error) {
            // Vector storage issues are warnings, not critical failures
            log.cli(`⚠️ Vector storage test failed: ${getErrorMessage(error)}`);
            suggestions.push(
              "Vector storage may need initialization - " +
                "this is optional for basic functionality"
            );
          }
        }

        // Schema-drift audit (mt#1641): compare declared models vs the actual DB, plus a
        // ledger duplicate-row check. Read-only. The migration ledger records migrations
        // by hash with NO post-apply schema verification, so a manual DROP COLUMN
        // (mt#2229) or a never-executed CREATE (mt#1641's 0020 phantom) leaves the ledger
        // "clean" while the schema diverges. v1 covers the embeddings tables (the incident
        // surface); generalizing to all declared tables is a follow-up (see mt#1641).
        try {
          // Feature-detect `.unsafe` rather than assume it: a provider may expose only the
          // postgres.js template-tag interface. If `.unsafe` is absent, skip the audit
          // gracefully instead of throwing.
          const rawConnRaw = await provider.getRawSqlConnection?.();
          const rawConn =
            rawConnRaw && typeof (rawConnRaw as { unsafe?: unknown }).unsafe === "function"
              ? (rawConnRaw as import("./schema-drift-detector").UnsafeSql)
              : undefined;
          if (rawConn) {
            const { getDeclaredTables, auditPostgresSchemaDrift } = await import(
              "./schema-drift-detector"
            );
            const { tasksEmbeddingsTable } = await import("../storage/schemas/task-embeddings");
            const { rulesEmbeddingsTable } = await import("../storage/schemas/rule-embeddings");
            const { toolEmbeddingsTable } = await import("../storage/schemas/tool-embeddings");
            const { knowledgeEmbeddingsTable } = await import(
              "../storage/schemas/knowledge-embeddings"
            );
            const { memoriesEmbeddingsTable } = await import(
              "../storage/schemas/memory-embeddings"
            );
            const { principalCorpusEmbeddingsTable } = await import(
              "../storage/schemas/principal-corpus-embeddings"
            );
            const declared = getDeclaredTables([
              tasksEmbeddingsTable,
              rulesEmbeddingsTable,
              toolEmbeddingsTable,
              knowledgeEmbeddingsTable,
              memoriesEmbeddingsTable,
              principalCorpusEmbeddingsTable,
            ]);
            const audit = await auditPostgresSchemaDrift(rawConn, declared);
            if (audit.clean) {
              log.cli(
                "✅ Schema-drift audit clean (declared embeddings tables match the DB; ledger has no duplicate rows)"
              );
            } else {
              // Surface drift as warnings/suggestions, NOT as `issues`: the audit is
              // best-effort and must not flip the overall persistence check to
              // success=false (e.g. on pre-existing prod drift). The log lines below make
              // findings visible regardless of the --report flag; reconciliation is a
              // separate, deliberate action.
              log.cli(`⚠️  Schema-drift audit found ${audit.issues.length} finding(s) (warnings):`);
              audit.issues.forEach((finding) => log.cli(`   - ${finding}`));
              suggestions.push(...audit.issues, ...audit.suggestions);
            }
          }
        } catch (error) {
          // Best-effort: surface as a suggestion, never a hard failure of the whole check.
          suggestions.push(`Schema-drift audit could not run: ${getErrorMessage(error)}`);
        }
      } catch (error) {
        issues.push(`Database functionality error: ${getErrorMessage(error)}`);
        suggestions.push("Check database schema and permissions");
      }
    }

    return {
      success: issues.length === 0,
      details: issues.length === 0 ? "All checks passed" : "Some checks failed",
      issues: issues.length > 0 ? issues : undefined,
      suggestions: suggestions.length > 0 ? suggestions : undefined,
    };
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
