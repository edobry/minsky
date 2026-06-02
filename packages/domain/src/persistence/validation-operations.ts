/**
 * Validation Operations
 *
 * Domain logic for persistence backend validation.
 * Extracted from adapters/shared/commands/persistence.ts to maintain
 * clean architecture boundaries.
 */

import { existsSync } from "fs";
import { getErrorMessage } from "../errors/index";
import { log } from "@minsky/shared/logger";
import { getDefaultSqliteDbPath } from "@minsky/shared/paths";
import { getEffectivePersistenceConfig } from "../configuration/persistence-config";
import type { PersistenceProvider } from "./types";
import { getPostgresMigrationsStatus } from "./migration-operations";

/**
 * Validate SQLite backend
 */
export async function validateSqliteBackend(filePath: string | undefined): Promise<{
  success: boolean;
  details: string;
  issues?: string[];
  suggestions?: string[];
}> {
  const issues: string[] = [];
  const suggestions: string[] = [];

  try {
    // Import configuration to get proper paths
    const { getConfiguration } = await import("../configuration/index");
    const config = getConfiguration();

    // Determine SQLite file path
    let dbPath: string;
    if (filePath) {
      dbPath = filePath;
      log.cli(`Using specified file: ${dbPath}`);
    } else {
      // Use configured path or default
      const effectiveConfig = getEffectivePersistenceConfig(config);
      dbPath = effectiveConfig.dbPath ?? getDefaultSqliteDbPath();
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
    const { DatabaseIntegrityChecker } = await import("../storage/database-integrity-checker");

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
        } else {
          // For SQLite, we could add similar migration checking in the future
          log.cli("✅ Schema status: SQLite (migration checking not implemented)");
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
              log.cli(`⚠️  Schema-drift audit found ${audit.issues.length} issue(s)`);
              issues.push(...audit.issues);
              suggestions.push(...audit.suggestions);
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
