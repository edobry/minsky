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
  getPostgresMigrationsStatus,
  runPostgresSchemaMigrations,
  runPostgresSchemaMigrationsForBackend,
  type PostgresMigrationPlan,
  type PostgresMigrationResult,
} from "./postgres-migration-operations";

// Re-export so callers that import from this module keep working
export { getPostgresMigrationsStatus } from "./postgres-migration-operations";

/**
 * Run migrations using drizzle-kit migrate command
 */
export async function runMigrationsWithDrizzleKit(options: {
  dryRun: boolean;
}): Promise<{ message: string; printed: boolean }> {
  try {
    const { spawn } = await import("child_process");
    const { loadConfiguration } = await import("../configuration/loader.js");

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

    const args = ["drizzle-kit", "migrate", "--config", "./drizzle.pg.config.ts"];
    if (options.dryRun) {
      // For dry run, we'll use our existing preview logic since drizzle-kit
      // doesn't have a dry-run mode for migrate
      // eslint-disable-next-line custom/no-excessive-as-unknown -- migration result types lack the 'message' field expected by this function's return type; structural mismatch from original any-typed API
      return runSchemaMigrationsForConfiguredBackend({ dryRun: true }) as unknown as Promise<{
        message: string;
        printed: boolean;
      }>;
    }

    // Early exit for Postgres when there is nothing to apply (reused status helper)
    try {
      const rawConfig = await loadConfiguration();
      const conf = rawConfig.config;
      const connectionString = getEffectivePersistenceConfig(conf).connectionString;

      if (connectionString) {
        const status = await getPostgresMigrationsStatus(connectionString);
        if (status.pendingCount === 0) {
          log.cli("✅ No pending migrations.");
          return { message: "No pending migrations", printed: true };
        }
      }
    } catch {
      // If any issue occurs during pre-check, proceed with normal migrate
    }

    log.cli("🚀 Executing migrations with drizzle-kit...");

    const migrateProcess = spawn("bunx", args, {
      stdio: ["inherit", "pipe", "pipe"],
      cwd: process.cwd(),
      env: configuredEnv,
    });

    let stderr = "";
    let stdout = "";

    migrateProcess.stdout?.on("data", (data) => {
      stdout += data.toString();
    });

    migrateProcess.stderr?.on("data", (data) => {
      stderr += data.toString();
    });

    const exitCode = await new Promise<number>((resolve) => {
      migrateProcess.on("close", resolve);
    });

    if (exitCode === 0) {
      // Check if there was any useful output from drizzle-kit
      const cleanStdout = stdout.trim();
      if (cleanStdout && !cleanStdout.includes("Reading config file")) {
        log.cli(cleanStdout);
      }

      return {
        message: "✅ Migrations executed successfully",
        printed: true,
      };
    } else {
      // Extract the actual database error from drizzle's verbose output
      let cleanError = stderr;

      // Look for the database error cause
      const causeMatch = stderr.match(/cause:\s*error:\s*(.+?)(?:\n|$)/);
      if (causeMatch) {
        const dbError = causeMatch[1] || "";

        // Look for the failing SQL
        const sqlMatch = stderr.match(/Failed query:\s*(.*?)(?:\n\nparams:|$)/s);
        const sql = sqlMatch ? (sqlMatch[1] || "").trim() : "";

        if (sql) {
          // Try to extract just the first line of SQL for brevity
          const sqlFirstLine = (sql.split("\n")[0] ?? "").trim();
          cleanError =
            `Database error: ${dbError}\n\nFailed SQL: ${sqlFirstLine}` +
            `${sql.includes("\n") ? "..." : ""}`;
        } else {
          cleanError = `Database error: ${dbError}`;
        }
      } else {
        // Fallback: clean up the original error
        cleanError = stderr
          .replace(/^\s*at\s+.*$/gm, "") // Remove stack trace lines
          .replace(/\n{2,}/g, "\n") // Remove multiple newlines
          .replace(/DrizzleQueryError:\s*/, "") // Remove Drizzle prefix
          .replace(/Failed query:\s*/, "Failed SQL:\n") // Better label
          .replace(/params:\s*$/m, "") // Remove empty params line
          .replace(/^\s*\.\.\.\s*\d+\s*lines\s*matching.*$/gm, "") // Remove stack trace indicators
          .trim();
      }

      throw new Error(`❌ ${cleanError}`);
    }
  } catch (error) {
    log.error(
      "Failed to execute migrations:",
      error instanceof Error ? error : { error: String(error) }
    );
    throw new Error(`Migration execution failed: ${getErrorMessage(error)}`);
  }
}

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

    let checkStderr = "";
    checkProcess.stderr?.on("data", (data) => {
      checkStderr += data.toString();
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
