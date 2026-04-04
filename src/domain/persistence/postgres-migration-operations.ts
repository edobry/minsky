/**
 * Postgres Migration Operations
 *
 * PostgreSQL-specific schema migration logic.
 * Extracted from migration-operations.ts to keep file sizes manageable.
 */

import { log } from "../../utils/logger";

/** Typed result shape for dry-run migration plan */
interface PostgresMigrationPlan {
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
interface PostgresMigrationResult {
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
 * Run PostgreSQL schema migrations (dry-run or execute)
 */
export async function runPostgresSchemaMigrations(
  connectionString: string,
  options: { dryRun: boolean }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- return type varies by dry-run mode
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
