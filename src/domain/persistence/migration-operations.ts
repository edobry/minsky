/**
 * Migration Operations
 *
 * Domain logic for persistence schema migrations.
 * Extracted from adapters/shared/commands/persistence.ts to maintain
 * clean architecture boundaries.
 */

import { getErrorMessage } from "../../errors/index";
import { log } from "../../utils/logger";
import { getDefaultSqliteDbPath } from "../../utils/paths";

/**
 * Compute Postgres migration status (reused by dry-run and execute paths)
 */
export async function getPostgresMigrationsStatus(connectionString: string): Promise<{
  schemaExists: boolean;
  metaExists: boolean;
  appliedCount: number;
  latestHash?: string;
  latestAt?: string;
  fileCount: number;
  pendingCount: number;
  migrationsFolder: string;
  maskedConn: string;
}> {
  const migrationsFolder = "./src/domain/storage/migrations/pg";
  const { readdirSync } = await import("fs");

  const maskedConn = connectionString.replace(/:\/\/[^:]+:[^@]+@/, "://***:***@");

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
  } finally {
    await sql.end();
  }

  let fileCount = 0;
  try {
    fileCount = readdirSync(migrationsFolder)
      .filter((n) => n.endsWith(".sql"))
      .sort((a, b) => a.localeCompare(b)).length;
  } catch {
    fileCount = 0;
  }

  const pendingCount = Math.max(fileCount - appliedCount, 0);

  return {
    schemaExists,
    metaExists,
    appliedCount,
    latestHash,
    latestAt,
    fileCount,
    pendingCount,
    migrationsFolder,
    maskedConn,
  };
}

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
    let configuredEnv: Record<string, string> = {};
    try {
      const configResult = await loadConfiguration();
      const config = configResult.config;

      // Prepare database configuration for drizzle-kit
      const dbConfig = {
        postgres: {
          connectionString:
            config.persistence?.postgres?.connectionString ||
            (config as any).sessiondb?.postgres?.connectionString ||
            null,
        },
        sqlite: {
          path:
            config.persistence?.sqlite?.dbPath || (config as any).sessiondb?.sqlite?.path || null,
        },
        backend: config.persistence?.backend || (config as any).sessiondb?.backend || "sqlite",
      };

      // Set environment variable that drizzle config will read
      configuredEnv = {
        ...(process.env as Record<string, string>),
        MINSKY_DB_CONFIG: JSON.stringify(dbConfig),
      };

      log.cli(`📋 Loaded database config for backend: ${dbConfig.backend}`);
    } catch (error) {
      log.warn(
        "Failed to load Minsky configuration, using environment variables as fallback:",
        error
      );
      configuredEnv = { ...process.env } as Record<string, string>;
    }

    const args = ["drizzle-kit", "migrate", "--config", "./drizzle.pg.config.ts"];
    if (options.dryRun) {
      // For dry run, we'll use our existing preview logic since drizzle-kit
      // doesn't have a dry-run mode for migrate
      return runSchemaMigrationsForConfiguredBackend({ dryRun: true });
    }

    // Early exit for Postgres when there is nothing to apply (reused status helper)
    try {
      const rawConfig = await loadConfiguration();
      const conf = rawConfig.config;
      const connectionString =
        conf.persistence?.postgres?.connectionString ||
        (conf as any).sessiondb?.postgres?.connectionString ||
        (conf as any).sessiondb?.connectionString ||
        (process.env as any).MINSKY_POSTGRES_URL;

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
    log.error("Failed to execute migrations:", error);
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
    let configuredEnv: Record<string, string> = {};
    try {
      const configResult = await loadConfiguration();
      const config = configResult.config;

      // Prepare database configuration for drizzle-kit
      const dbConfig = {
        postgres: {
          connectionString:
            config.persistence?.postgres?.connectionString ||
            (config as any).sessiondb?.postgres?.connectionString ||
            null,
        },
        sqlite: {
          path:
            config.persistence?.sqlite?.dbPath || (config as any).sessiondb?.sqlite?.path || null,
        },
        backend: config.persistence?.backend || (config as any).sessiondb?.backend || "sqlite",
      };

      // Set environment variable that drizzle config will read
      configuredEnv = {
        ...(process.env as Record<string, string>),
        MINSKY_DB_CONFIG: JSON.stringify(dbConfig),
      };

      log.cli(`📋 Loaded database config for backend: ${dbConfig.backend}`);
    } catch (error) {
      log.warn(
        "Failed to load Minsky configuration, using environment variables as fallback:",
        error
      );
      configuredEnv = { ...process.env } as Record<string, string>;
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
    log.error("Failed to check/generate migrations:", error);
    throw new Error(`Migration check/generation failed: ${getErrorMessage(error)}`);
  }
}

/**
 * Run SQLite schema migrations (dry-run or execute)
 */
async function runSqliteSchemaMigrations(
  dbPath: string,
  options: { dryRun: boolean }
): Promise<any> {
  const { dryRun } = options;
  const backend = "sqlite";

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

    const summary =
      `Schema migration (dry run) for sqlite\nDatabase: ${dbPath}\n` +
      `Migrations: ${migrationsFolder}\nPlan: ${fileNames.length} file(s), ` +
      `${appliedCount} applied, ${Math.max(fileNames.length - appliedCount, 0)} pending`;

    const plan: any = {
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

    {
      (plan as any).printed = true;
      delete (plan as any).message;
    }

    {
      log.cli("=== Persistence Schema Migration (sqlite) — DRY RUN ===");
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

  // Execute mode
  const { Database } = await import("bun:sqlite");
  const { drizzle } = await import("drizzle-orm/bun-sqlite");
  const { migrate } = await import("drizzle-orm/bun-sqlite/migrator");

  const sqlite = new Database(dbPath);
  try {
    const migrationsFolder = "./src/domain/storage/migrations";
    let fileNames: string[] = [];
    let metaExists = false;
    let appliedCount = 0;
    let latestHash: string | undefined;
    let latestAt: string | undefined;

    {
      try {
        const { readdirSync } = await import("fs");
        const { basename } = await import("path");
        fileNames = readdirSync(migrationsFolder)
          .filter((n) => n.endsWith(".sql"))
          .sort((a, b) => a.localeCompare(b));

        const tables = sqlite
          .query(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='__drizzle_migrations'"
          )
          .all();
        metaExists = Array.isArray(tables) && tables.length > 0;
        if (metaExists) {
          const cnt = sqlite
            .query("SELECT COUNT(*) as count FROM __drizzle_migrations")
            .get() as any;
          appliedCount = parseInt(String(cnt?.count || 0), 10);
          const last = sqlite
            .query(
              "SELECT hash, created_at FROM __drizzle_migrations ORDER BY created_at DESC LIMIT 1"
            )
            .get() as any;
          latestHash = last?.hash || undefined;
          latestAt = last?.created_at ? String(last.created_at) : undefined;
        }

        log.cli("=== Persistence Schema Migration (sqlite) ===");
        log.cli("");
        log.cli(`Database: ${dbPath}`);
        log.cli(`Migrations: ${migrationsFolder}`);
        log.cli("");
        log.cli(`Status: metaTable=${metaExists ? "present" : "missing"}`);
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
          const pending = fileNames.slice(appliedCount);
          if (pending.length > 0) {
            log.cli("");
            log.cli("Pending:");
            pending.forEach((f, i) => log.cli(`  ${i + 1}. ${basename(f)}`));
          }
        }
        log.cli("");
        log.cli("Executing...");
        log.cli("");
      } catch {
        // ignore preview issues
      }
    }

    const db = drizzle(sqlite, { logger: true });
    const start = Date.now();
    await migrate(db as any, { migrationsFolder });
    {
      const ms = Date.now() - start;
      log.cli(`Applied migrations in ${ms}ms`);
    }
  } finally {
    sqlite.close();
  }

  const appliedRes: any = {
    success: true,
    applied: true,
    backend,
    migrationsFolder: "./src/domain/storage/migrations",
    message: `Schema migration applied for sqlite (migrations: ./src/domain/storage/migrations)`,
  };
  {
    appliedRes.printed = true;
    delete appliedRes.message;
  }
  return appliedRes;
}

/**
 * Run PostgreSQL schema migrations (dry-run or execute)
 */
async function runPostgresSchemaMigrations(
  connectionString: string,
  options: { dryRun: boolean }
): Promise<any> {
  const { dryRun } = options;
  const backend = "postgres";

  if (dryRun) {
    // Build preview plan
    const { basename } = await import("path");
    const status = await getPostgresMigrationsStatus(connectionString);
    const maskedConn = status.maskedConn;
    const migrationsFolder = status.migrationsFolder;
    let fileNames: string[] = [];
    try {
      const { readdirSync } = await import("fs");
      fileNames = readdirSync(migrationsFolder)
        .filter((n) => n.endsWith(".sql"))
        .sort((a, b) => a.localeCompare(b));
    } catch {
      // ignore
    }

    const summary =
      `Schema migration (dry run) for postgres\nDatabase: ${maskedConn}\n` +
      `Migrations: ${migrationsFolder}\nPlan: ${fileNames.length} file(s), ` +
      `${status.appliedCount} applied, ` +
      `${Math.max(fileNames.length - status.appliedCount, 0)} pending`;

    const plan: any = {
      success: true,
      backend,
      dryRun: true,
      connection: maskedConn,
      migrationsFolder,
      message: `${summary}\n\n(use --execute to apply)`,
      status: {
        schema: status.schemaExists ? "present" : "missing",
        metaTable: status.metaExists ? "present" : "missing",
      },
      plan: {
        files: fileNames,
        fileCount: fileNames.length,
        appliedCount: status.appliedCount,
        pendingCount: Math.max(fileNames.length - status.appliedCount, 0),
        latestHash: status.latestHash,
        latestAt: status.latestAt,
      },
    } as const;

    {
      (plan as any).printed = true;
      delete (plan as any).message;
    }

    {
      const pendingCount = Math.max(fileNames.length - status.appliedCount, 0);

      // Mark plan metadata
      (plan as any).nothingToDo = pendingCount === 0;

      log.cli("=== Persistence Schema Migration (postgres) — DRY RUN ===");
      log.cli("");
      log.cli(`Database: ${maskedConn}`);
      log.cli(`Migrations: ${migrationsFolder}`);
      log.cli("");
      log.cli(
        `Status: schema=${status.schemaExists ? "present" : "missing"}, metaTable=${
          status.metaExists ? "present" : "missing"
        }`
      );
      if (status.metaExists) {
        log.cli(
          `Meta: applied=${status.appliedCount}${
            status.latestHash ? `, latest=${status.latestHash}` : ""
          }${status.latestAt ? `, last_at=${status.latestAt}` : ""}`
        );
      }
      log.cli(
        `Plan: ${fileNames.length} file(s), ${status.appliedCount} applied, ` +
          `${pendingCount} pending`
      );
      log.cli("");
      if (pendingCount > 0) {
        log.cli("(use --execute to apply)");
      } else {
        log.cli("✅ No pending migrations.");
      }
      log.cli("");
    }

    return plan as any;
  }

  // Execute mode
  const { drizzle } = await import("drizzle-orm/postgres-js");
  const { migrate } = await import("drizzle-orm/postgres-js/migrator");
  const postgres = (await import("postgres")).default;
  const { readdirSync } = await import("fs");
  const { basename } = await import("path");

  const sql = postgres(connectionString, {
    prepare: false,
    onnotice: () => {},
    max: 10,
  });
  try {
    const db = drizzle(sql, { logger: true });

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
        const rows = await sql<{ count: string; hash: string | null; created_at: string | null }[]>`
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

    {
      log.cli("=== Persistence Schema Migration (postgres) ===");
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
          `Meta: applied=${appliedCount}${
            latestHash ? `, latest=${latestHash}` : ""
          }${latestAt ? `, last_at=${latestAt}` : ""}`
        );
      }
      log.cli(
        `Plan: ${files.length} file(s), ${appliedCount} applied, ${Math.max(
          files.length - appliedCount,
          0
        )} pending`
      );
      // Show file list once below right before execution
      log.cli("");
      log.cli(`Executing...`);
      log.cli("");
    }

    const start = Date.now();
    if (files.length > 0) {
      const pending = Math.max(files.length - appliedCount, 0);
      if (pending > 0) {
        log.cli("Running migrations (in order):");
        files.slice(appliedCount).forEach((f, i) => log.cli(`  ${i + 1}. ${basename(f)}`));
        log.cli("");
      }
    }
    await migrate(db, { migrationsFolder });
    {
      const ms = Date.now() - start;
      // Re-check applied count
      try {
        const cnt2 = await sql<{ count: string; last: string | null }[]>`
          SELECT COUNT(*)::text as count, MAX(hash) as last
          FROM "drizzle"."__drizzle_migrations";
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

  const appliedPg: any = {
    success: true,
    applied: true,
    backend,
    migrationsFolder: "./src/domain/storage/migrations/pg",
    message:
      `Schema migration applied for postgres ` + `(migrations: ./src/domain/storage/migrations/pg)`,
  };
  {
    appliedPg.printed = true;
    delete appliedPg.message;
  }
  return appliedPg;
}

/**
 * Run schema migrations for the configured backend (dispatcher)
 */
export async function runSchemaMigrationsForConfiguredBackend(
  options: { dryRun?: boolean } = {}
): Promise<any> {
  const { dryRun = false } = options;
  const { getConfiguration } = await import("../configuration/index");
  const config = getConfiguration();
  const backend = (config.persistence?.backend ||
    (config as any).sessiondb?.backend ||
    "sqlite") as "sqlite" | "postgres";

  if (backend === "sqlite") {
    const dbPath =
      config.persistence?.sqlite?.dbPath ||
      (config as any).sessiondb?.sqlite?.path ||
      (config as any).sessiondb?.dbPath ||
      getDefaultSqliteDbPath();
    return runSqliteSchemaMigrations(dbPath, { dryRun });
  }

  if (backend === "postgres") {
    const connectionString =
      config.persistence?.postgres?.connectionString ||
      (config as any).sessiondb?.postgres?.connectionString ||
      (config as any).sessiondb?.connectionString ||
      (process.env as any).MINSKY_POSTGRES_URL;

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
    const dbPath = sqlitePath || getDefaultSqliteDbPath();
    const { Database } = await import("bun:sqlite");
    const { drizzle } = await import("drizzle-orm/bun-sqlite");
    const { migrate } = await import("drizzle-orm/bun-sqlite/migrator");
    const sqlite = new Database(dbPath);
    try {
      const db = drizzle(sqlite, { logger: false });
      await migrate(db as any, {
        migrationsFolder: "./src/domain/storage/migrations",
      });
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
    const sql = postgres(conn, {
      prepare: false,
      onnotice: () => {},
      max: 10,
    });
    try {
      const db = drizzle(sql, { logger: false });
      await migrate(db, {
        migrationsFolder: "./src/domain/storage/migrations/pg",
      });
    } finally {
      await sql.end();
    }
    return;
  }
}
