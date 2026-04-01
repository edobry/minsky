/**
 * SQLite Migration Operations
 *
 * SQLite-specific schema migration logic.
 * Extracted from migration-operations.ts to keep file sizes manageable.
 */

import { log } from "../../utils/logger";
import { getDefaultSqliteDbPath } from "../../utils/paths";

/**
 * Run SQLite schema migrations (dry-run or execute)
 */
export async function runSqliteSchemaMigrations(
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
    const db = drizzle(sqlite, { logger: false });
    await migrate(db as any, {
      migrationsFolder: "./src/domain/storage/migrations",
    });
  } finally {
    sqlite.close();
  }
}
