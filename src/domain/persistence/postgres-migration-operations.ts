/**
 * Postgres Migration Operations
 *
 * PostgreSQL-specific schema migration logic.
 * Extracted from migration-operations.ts to keep file sizes manageable.
 */

import { log } from "../../utils/logger";

/** Shape of a single journal entry from _journal.json */
export interface JournalEntry {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
}

/** Shape of the full _journal.json file */
export interface Journal {
  version: string;
  dialect: string;
  entries: JournalEntry[];
}

/**
 * Validate that journal entry timestamps are monotonically increasing.
 * Drizzle-orm uses these as created_at in __drizzle_migrations and processes
 * migrations by timestamp order. Out-of-order timestamps cause silent skips.
 */
export function validateJournalTimestamps(journal: Journal): void {
  for (let i = 1; i < journal.entries.length; i++) {
    const prev = journal.entries[i - 1]!;
    const curr = journal.entries[i]!;
    if (curr.when <= prev.when) {
      throw new Error(
        `Migration journal timestamps out of order: ` +
          `${prev.tag} (idx=${prev.idx}, when=${prev.when}) >= ` +
          `${curr.tag} (idx=${curr.idx}, when=${curr.when}). ` +
          `Fix the 'when' values in _journal.json to be monotonically increasing.`
      );
    }
  }
}

/**
 * Assert that the DB migration count matches the journal entry count.
 * A mismatch means drizzle silently skipped one or more migrations.
 */
export function assertMigrationCountMatch(dbCount: number, journalCount: number): void {
  if (dbCount !== journalCount) {
    const skipped = journalCount - dbCount;
    throw new Error(
      `Migration count mismatch: DB has ${dbCount} applied migrations but journal has ${journalCount} entries. ` +
        `${skipped} migration(s) may have been silently skipped by drizzle's high-water-mark behavior. ` +
        `Check that _journal.json timestamps are monotonically increasing.`
    );
  }
}

/** Typed result shape for dry-run migration plan */
export interface PostgresMigrationPlan {
  success: boolean;
  backend: string;
  dryRun: boolean;
  connection: string;
  migrationsFolder: string;
  status: {
    schema: string;
    metaTable: string;
  };
  plan: {
    files: string[];
    fileCount: number;
    appliedCount: number;
    pendingCount: number;
    latestHash?: string;
    latestAt?: string;
  };
  printed?: boolean;
  nothingToDo?: boolean;
}

/** Typed result shape for executed migration */
export interface PostgresMigrationResult {
  success: boolean;
  applied: boolean;
  backend: string;
  migrationsFolder: string;
  printed?: boolean;
}

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
  const { readdirSync, readFileSync } = await import("fs");
  const { join } = await import("path");

  // Validate journal timestamps before doing anything else
  const journalRaw = readFileSync(join(migrationsFolder, "meta", "_journal.json"), {
    encoding: "utf8",
  }) as string;
  const journal: Journal = JSON.parse(journalRaw);
  validateJournalTimestamps(journal);

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
 * Run PostgreSQL schema migrations (dry-run or execute)
 */
export async function runPostgresSchemaMigrations(
  connectionString: string,
  options: { dryRun: boolean }
): Promise<PostgresMigrationPlan | PostgresMigrationResult> {
  const { dryRun } = options;
  const backend = "postgres";

  if (dryRun) {
    // Build preview plan
    const { basename: _basename } = await import("path");
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

    const _summary =
      `Schema migration (dry run) for postgres\nDatabase: ${maskedConn}\n` +
      `Migrations: ${migrationsFolder}\nPlan: ${fileNames.length} file(s), ` +
      `${status.appliedCount} applied, ` +
      `${Math.max(fileNames.length - status.appliedCount, 0)} pending`;

    const plan: PostgresMigrationPlan = {
      success: true,
      backend,
      dryRun: true,
      connection: maskedConn,
      migrationsFolder,
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
    };

    {
      plan.printed = true;
    }

    {
      const pendingCount = Math.max(fileNames.length - status.appliedCount, 0);

      // Mark plan metadata
      plan.nothingToDo = pendingCount === 0;

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

    return plan;
  }

  // Execute mode
  const { drizzle } = await import("drizzle-orm/postgres-js");
  const { migrate } = await import("drizzle-orm/postgres-js/migrator");
  const postgres = (await import("postgres")).default;
  const { readdirSync, readFileSync } = await import("fs");
  const { basename, join } = await import("path");

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

    // Read and validate journal timestamps before executing
    const journalRawExec = readFileSync(join(migrationsFolder, "meta", "_journal.json"), {
      encoding: "utf8",
    }) as string;
    const journal: Journal = JSON.parse(journalRawExec);
    validateJournalTimestamps(journal);

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
        const cnt = await sql<{ count: string }[]>`
          SELECT COUNT(*)::text as count FROM "drizzle"."__drizzle_migrations";
        `;
        appliedCount = parseInt(cnt?.[0]?.count || "0", 10);
        const rows = await sql<{ hash: string | null; created_at: string | null }[]>`
          SELECT hash, created_at::text
          FROM "drizzle"."__drizzle_migrations"
          ORDER BY created_at DESC LIMIT 1;
        `;
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
      const pendingEntries = journal.entries.slice(appliedCount);
      if (pendingEntries.length > 0) {
        log.cli("Running migrations (in order):");
        pendingEntries.forEach((e, i) => log.cli(`  ${i + 1}. ${e.tag}.sql`));
        log.cli("");
      }
    }
    await migrate(db, { migrationsFolder });
    {
      const ms = Date.now() - start;
      // Post-flight: verify that DB count matches journal entries (catches silent skips)
      const cnt2 = await sql<{ count: string }[]>`
        SELECT COUNT(*)::text as count FROM "drizzle"."__drizzle_migrations";
      `;
      const applied2 = parseInt(cnt2?.[0]?.count || "0", 10);
      assertMigrationCountMatch(applied2, journal.entries.length);
      log.cli(`Applied ${Math.max(applied2 - appliedCount, 0)} migration(s) in ${ms}ms`);
    }
  } finally {
    await sql.end();
  }

  const appliedPg: PostgresMigrationResult = {
    success: true,
    applied: true,
    backend,
    migrationsFolder: "./src/domain/storage/migrations/pg",
  };
  {
    appliedPg.printed = true;
  }
  return appliedPg;
}

/**
 * Run Postgres schema migrations for an explicit connection string
 * (used during data migrations to prep target DB)
 */
export async function runPostgresSchemaMigrationsForBackend(
  connectionString: string
): Promise<void> {
  const { drizzle } = await import("drizzle-orm/postgres-js");
  const { migrate } = await import("drizzle-orm/postgres-js/migrator");
  const postgres = (await import("postgres")).default;
  const sql = postgres(connectionString, {
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
}
