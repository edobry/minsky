/**
 * SQLite Migration Operations
 *
 * SQLite-specific schema migration logic.
 * Extracted from migration-operations.ts to keep file sizes manageable.
 */

import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { log } from "../../utils/logger";
import { getDefaultSqliteDbPath } from "../../utils/paths";

/** Shape of rows returned by COUNT query against __drizzle_migrations */
interface DrizzleMigrationCount {
  count: number | string;
}

/** Shape of rows returned by hash/created_at query against __drizzle_migrations */
interface DrizzleMigrationRow {
  hash: string | null;
  created_at: string | number | null;
}

/** Typed result shape for dry-run migration plan */
export interface SqliteMigrationPlan {
  success: boolean;
  backend: string;
  dryRun: boolean;
  sqlitePath: string;
  migrationsFolder: string;
  status: { metaTable: string };
  plan: {
    files: string[];
    fileCount: number;
    appliedCount: number;
    pendingCount: number;
    latestHash?: string;
    latestAt?: string;
  };
  printed?: boolean;
}

/** Typed result shape for executed migration */
export interface SqliteMigrationResult {
  success: boolean;
  applied: boolean;
  backend: string;
  migrationsFolder: string;
  printed?: boolean;
}

/**
 * Run SQLite schema migrations (dry-run or execute)
 */
export async function runSqliteSchemaMigrations(
  dbPath: string,
  options: { dryRun: boolean }
): Promise<SqliteMigrationPlan | SqliteMigrationResult> {
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
          const cnt = db
            .query("SELECT COUNT(*) as count FROM __drizzle_migrations")
            .get() as DrizzleMigrationCount | null;
          appliedCount = parseInt(String(cnt?.count || 0), 10);
          const last = db
            .query(
              "SELECT hash, created_at FROM __drizzle_migrations ORDER BY created_at DESC LIMIT 1"
            )
            .get() as DrizzleMigrationRow | null;
          latestHash = last?.hash || undefined;
          latestAt = last?.created_at ? String(last.created_at) : undefined;
        }
      } finally {
        db.close();
      }
    } catch {
      // Best effort
    }

    const plan: SqliteMigrationPlan = {
      success: true,
      backend,
      dryRun: true,
      sqlitePath: dbPath,
      migrationsFolder,
      status: { metaTable: metaExists ? "present" : "missing" },
      plan: {
        files: fileNames,
        fileCount: fileNames.length,
        appliedCount,
        pendingCount: Math.max(fileNames.length - appliedCount, 0),
        latestHash,
        latestAt,
      },
    };

    {
      plan.printed = true;
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

    return plan;
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
            .get() as DrizzleMigrationCount | null;
          appliedCount = parseInt(String(cnt?.count || 0), 10);
          const last = sqlite
            .query(
              "SELECT hash, created_at FROM __drizzle_migrations ORDER BY created_at DESC LIMIT 1"
            )
            .get() as DrizzleMigrationRow | null;
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

    const db = drizzle(sqlite, { logger: true }) as BunSQLiteDatabase;
    const start = Date.now();
    await migrate(db, { migrationsFolder });
    {
      const ms = Date.now() - start;
      log.cli(`Applied migrations in ${ms}ms`);
    }
  } finally {
    sqlite.close();
  }

  const appliedRes: SqliteMigrationResult = {
    success: true,
    applied: true,
    backend,
    migrationsFolder: "./src/domain/storage/migrations",
  };
  {
    appliedRes.printed = true;
  }
  return appliedRes;
}

/**
 * Run SQLite schema migrations for an explicit path
 * (used during data migrations to prep target DB)
 */
export async function runSqliteSchemaMigrationsForBackend(sqlitePath?: string): Promise<void> {
  const dbPath = sqlitePath || getDefaultSqliteDbPath();
  const { Database } = await import("bun:sqlite");
  const { drizzle } = await import("drizzle-orm/bun-sqlite");
  const { migrate } = await import("drizzle-orm/bun-sqlite/migrator");
  const sqlite = new Database(dbPath);
  try {
    const db = drizzle(sqlite, { logger: false }) as BunSQLiteDatabase;
    await migrate(db, {
      migrationsFolder: "./src/domain/storage/migrations",
    });
  } finally {
    sqlite.close();
  }
}
