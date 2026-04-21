/**
 * Migration Operations
 *
 * Domain logic for persistence schema migrations.
 * Extracted from adapters/shared/commands/persistence.ts to maintain
 * clean architecture boundaries.
 *
 * Backend-specific logic lives in:
 *   - sqlite-migration-operations.ts
 *   - postgres-migration-operations.ts
 */

import { getErrorMessage } from "../../errors/index";
import { log } from "../../utils/logger";
import { getDefaultSqliteDbPath } from "../../utils/paths";
import { getEffectivePersistenceConfig } from "../configuration/persistence-config";
import {
  runSqliteSchemaMigrations,
  runSqliteSchemaMigrationsForBackend,
  type SqliteMigrationPlan,
  type SqliteMigrationResult,
} from "./sqlite-migration-operations";
import {
  runPostgresSchemaMigrations,
  runPostgresSchemaMigrationsForBackend,
  type PostgresMigrationPlan,
  type PostgresMigrationResult,
} from "./postgres-migration-operations";

// Re-export so callers that import from this module keep working
export { getPostgresMigrationsStatus } from "./postgres-migration-operations";

/**
 * Check if migrations need to be generated and auto-generate them
 */
export async function checkAndGenerateMigrations(): Promise<{
  nothingToDo?: boolean;
}> {
  try {
    const { spawn } = await import("child_process");
    const { loadConfiguration } = await import("../configuration/loader.js");

    log.cli("🔍 Checking migration status...");

    // Load Minsky configuration and prepare environment variables for drizzle-kit
    let configuredEnv: NodeJS.ProcessEnv = {};
    try {
      const configResult = await loadConfiguration();
      const config = configResult.config;

      // Prepare database configuration for drizzle-kit
      const effectiveConfig = getEffectivePersistenceConfig(config);
      const dbConfig = {
        postgres: {
          connectionString: effectiveConfig.connectionString ?? null,
        },
        sqlite: {
          path: effectiveConfig.dbPath ?? null,
        },
        backend: effectiveConfig.backend,
      };

      // Set environment variable that drizzle config will read
      configuredEnv = {
        ...process.env,
        MINSKY_DB_CONFIG: JSON.stringify(dbConfig),
      };

      log.cli(`📋 Loaded database config for backend: ${dbConfig.backend}`);
    } catch (error) {
      log.warn(
        `Failed to load Minsky configuration, using environment variables as fallback: ${error instanceof Error ? error.message : String(error)}`
      );
      configuredEnv = { ...process.env };
    }

    // Use drizzle-kit check to detect if migrations are up to date
    const checkProcess = spawn(
      "bunx",
      ["drizzle-kit", "check", "--config", "./drizzle.pg.config.ts"],
      {
        stdio: ["inherit", "pipe", "pipe"],
        cwd: process.cwd(),
        env: configuredEnv,
      }
    );

    let _checkStderr = "";
    checkProcess.stderr?.on("data", (data) => {
      _checkStderr += data.toString();
    });

    const checkExitCode = await new Promise<number>((resolve) => {
      checkProcess.on("close", resolve);
    });

    // If check fails (non-zero exit), it means migrations are out of sync
    if (checkExitCode !== 0) {
      log.cli("🔄 Schema changes detected, generating fresh migrations...");

      // Generate new migrations
      const generateProcess = spawn(
        "bunx",
        ["drizzle-kit", "generate", "--config", "./drizzle.pg.config.ts"],
        {
          stdio: ["inherit", "pipe", "pipe"],
          cwd: process.cwd(),
          env: configuredEnv,
        }
      );

      let generateStderr = "";
      generateProcess.stderr?.on("data", (data) => {
        generateStderr += data.toString();
      });

      const generateExitCode = await new Promise<number>((resolve) => {
        generateProcess.on("close", resolve);
      });

      if (generateExitCode === 0) {
        log.cli("✅ Generated fresh migrations successfully");
      } else {
        throw new Error(`Migration generation failed:\n${generateStderr}`);
      }
    } else {
      log.cli("✅ Migrations are up to date");
      return { nothingToDo: true };
    }
    log.cli(""); // Add spacing after migration check
    return {};
  } catch (error) {
    log.error(
      "Failed to check/generate migrations:",
      error instanceof Error ? error : { error: String(error) }
    );
    throw new Error(`Migration check/generation failed: ${getErrorMessage(error)}`);
  }
}

/**
 * Run schema migrations for the configured backend (dispatcher)
 */
export async function runSchemaMigrationsForConfiguredBackend(
  options: { dryRun?: boolean } = {}
): Promise<
  SqliteMigrationPlan | SqliteMigrationResult | PostgresMigrationPlan | PostgresMigrationResult
> {
  const { dryRun = false } = options;
  const { getConfiguration } = await import("../configuration/index");
  const config = getConfiguration();
  const { backend, dbPath, connectionString } = getEffectivePersistenceConfig(config);

  if (backend === "sqlite") {
    const resolvedDbPath = dbPath ?? getDefaultSqliteDbPath();
    return runSqliteSchemaMigrations(resolvedDbPath, { dryRun });
  }

  if (backend === "postgres") {
    if (!connectionString) {
      throw new Error(
        "PostgreSQL connection string not found. Configure " +
          "persistence.postgres.connectionString, " +
          "sessiondb.postgres.connectionString, or set MINSKY_POSTGRES_URL."
      );
    }

    return runPostgresSchemaMigrations(connectionString, { dryRun });
  }

  throw new Error(`Unsupported backend: ${backend}`);
}

/**
 * Run schema migrations for an explicit backend
 * (used during data migrations to prep target DB)
 */
export async function runSchemaMigrationsForBackend(
  backend: "sqlite" | "postgres",
  options: { sqlitePath?: string; connectionString?: string } = {}
): Promise<void> {
  const { sqlitePath, connectionString } = options;
  if (backend === "sqlite") {
    return runSqliteSchemaMigrationsForBackend(sqlitePath);
  }
  if (backend === "postgres") {
    const conn = connectionString;
    if (!conn) return; // rely on storage.initialize() fallback
    return runPostgresSchemaMigrationsForBackend(conn);
  }
}
