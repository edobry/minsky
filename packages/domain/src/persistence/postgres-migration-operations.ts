/**
 * Postgres Migration Operations
 *
 * PostgreSQL-specific schema migration logic.
 * Extracted from migration-operations.ts to keep file sizes manageable.
 */

import { join, dirname } from "path";
import { existsSync } from "fs";
import { log } from "@minsky/shared/logger";
import { logPostgresNotice } from "./postgres-notice-handler";

/**
 * Resolve the absolute path of the Postgres migrations folder.
 *
 * Three cases tried in order; returns the first one whose `meta/_journal.json` exists:
 *
 * (a) **Dev/source** — `import.meta.dir` is
 *     `packages/domain/src/persistence/` inside the Minsky checkout, so
 *     `../storage/migrations/pg` resolves to the correct source-tree path
 *     regardless of the current working directory.
 *
 * (b) **Bundled dist** — `bun run build` copies migrations to
 *     `dist/storage/migrations/pg` (relative to repo root). When the binary
 *     is installed or run from an arbitrary directory, `import.meta.dir` is
 *     the directory containing `dist/minsky.js`, so
 *     `./storage/migrations/pg` resolves correctly.
 *     Also tries `<dirname(process.argv[1])>/storage/migrations/pg` as a
 *     secondary probe for environments where `import.meta.dir` differs from
 *     the binary location (`process.argv[1]` is the invoked script path —
 *     i.e. `dist/minsky.js` — which is co-located with the migrations;
 *     `process.execPath` is the bun/node runtime binary and is NOT the right
 *     anchor for asset resolution).
 *
 * (c) **Legacy fallback** — preserves the original cwd-relative path so
 *     `minsky persistence migrate` continues to work when invoked from the
 *     Minsky repo root (e.g. `bun run src/cli.ts`).
 *
 * If none of the candidates contains `meta/_journal.json`, throws with the
 * full list of tried paths so the operator can diagnose the issue.
 *
 * @see mt#2369 — originating task (Phase 0 portability floor)
 */
export function resolvePgMigrationsFolder(): string {
  const candidates: string[] = [
    // (a) Dev / source-tree path: this file lives at
    //     packages/domain/src/persistence/postgres-migration-operations.ts
    //     so the migrations folder is one directory-level up + storage/migrations/pg.
    join(import.meta.dir, "../storage/migrations/pg"),

    // (b-1) Bundled binary: migrations are copied next to minsky.js as
    //       dist/storage/migrations/pg. `import.meta.dir` is the directory
    //       containing the compiled JS file, so ./storage/migrations/pg is correct.
    join(import.meta.dir, "storage/migrations/pg"),

    // (b-2) Secondary bundled path: resolves from the invoked script path.
    // process.argv[1] is the path to the invoked script (dist/minsky.js),
    // which is co-located with the migrations at dist/storage/migrations/pg.
    // NOTE: process.argv[0] and process.execPath are the bun/node runtime binary
    // — NOT co-located with the bundle assets — so they are the WRONG anchor here.
    join(dirname(process.argv[1] ?? ""), "storage/migrations/pg"),

    // (c) Legacy cwd-relative fallback: preserves the behaviour that existed
    //     before mt#2369 when run from the Minsky repo root.
    join(process.cwd(), "packages/domain/src/storage/migrations/pg"),
  ];

  for (const candidate of candidates) {
    if (existsSync(join(candidate, "meta", "_journal.json"))) {
      return candidate;
    }
  }

  throw new Error(
    `Cannot find Postgres migrations folder. Tried:\n${candidates
      .map((c) => `  - ${c}`)
      .join("\n")}\n\nEnsure the migrations folder exists at one of the above paths. ` +
      `If running the bundled dist/minsky.js, verify that 'bun run build' ` +
      `completed successfully (it copies migrations to dist/storage/migrations/pg).`
  );
}

/**
 * Override env-var name for the unmerged-migration guard.
 * Exported so the guard, tests, and documentation cannot drift.
 * Registered in HOOK_ONLY_ENV_VARS (packages/domain/src/configuration/sources/environment.ts).
 */
export const UNMERGED_MIGRATION_CHECK_OVERRIDE_ENV = "MINSKY_SKIP_UNMERGED_MIGRATION_CHECK";

/**
 * Classify whether a Postgres connection string targets a shared production
 * database. The classifier is intentionally conservative: any connection whose
 * host is NOT a known local/test pattern is treated as a shared remote DB.
 *
 * **Assumption (documented per spec):**  the only "local" Postgres hosts are
 * `localhost`, `127.0.0.1`, and Docker/testcontainer aliases
 * (`host.docker.internal`, `postgres`, `db`). Everything else — Supabase
 * pooler hosts (*.pooler.supabase.com), direct Supabase hosts (*.supabase.co),
 * Neon hosts (*.neon.tech), AWS RDS hosts (*.amazonaws.com), and any other
 * remote hostname — is classified as prod.
 *
 * The conservative choice (remote ⇒ prod) is intentional: applying an
 * unmerged migration to ANY remote Postgres is dangerous because you can't
 * easily undo it if the migration is later abandoned.
 */
export function isProdPostgresConnection(connectionString: string): boolean {
  let host: string;
  try {
    const url = new URL(connectionString);
    host = url.hostname.toLowerCase();
  } catch {
    // Unparseable connection string — treat as prod (fail-closed)
    return true;
  }

  // Known local/test hostnames — NOT prod.
  // IPv6 loopback is matched in BOTH bracketed and unbracketed forms: Bun's
  // `URL.hostname` keeps the brackets (`[::1]`) while Node's WHATWG URL strips
  // them (`::1`). Matching both makes the classifier runtime-agnostic.
  const localPatterns: Array<string | RegExp> = [
    "localhost",
    "127.0.0.1",
    "[::1]", // IPv6 loopback (Bun's URL.hostname form)
    "::1", // IPv6 loopback (Node's URL.hostname form)
    "host.docker.internal",
    // Common Docker service aliases used in docker-compose and testcontainers
    "postgres",
    "db",
    "database",
  ];

  for (const pattern of localPatterns) {
    if (typeof pattern === "string" ? host === pattern : pattern.test(host)) {
      return false;
    }
  }

  return true;
}

/**
 * Result of the unmerged-migration check.
 */
export interface UnmergedMigrationCheckResult {
  /** Whether any pending migration is absent from origin/main */
  blocked: boolean;
  /** Tags of migrations that are pending but NOT on origin/main */
  unmergedTags: string[];
  /**
   * Set when the check could NOT be performed (e.g. `origin/main` does not
   * resolve locally — no remote, different remote name, or not fetched). When
   * present, the guard FAILS OPEN: it does not block, but the operator is warned
   * so an infra/setup issue is never silently conflated with a true unmerged
   * migration. Distinguishing this from per-file absence is the mt#2277 review fix.
   */
  skippedReason?: string;
}

/**
 * For each pending migration file (journal entries beyond `appliedCount`),
 * verify that the file is present on `origin/main` via
 * `git cat-file -e origin/main:<path>`. Returns `blocked: true` if any
 * pending migration is absent from origin/main.
 *
 * @param migrationsFolder  Absolute or CWD-relative path to the migrations folder
 * @param journalEntries    All journal entries (in order)
 * @param appliedCount      Number already applied in the DB (may be 0 on fresh DB)
 * @param cwd               Working directory for git commands (default: process.cwd())
 */
export async function checkUnmergedMigrations(
  migrationsFolder: string,
  journalEntries: JournalEntry[],
  appliedCount: number,
  cwd: string = process.cwd()
): Promise<UnmergedMigrationCheckResult> {
  const { execFile } = await import("child_process");
  const { promisify } = await import("util");
  const execFileAsync = promisify(execFile);

  const pendingEntries = journalEntries.slice(appliedCount);
  if (pendingEntries.length === 0) {
    return { blocked: false, unmergedTags: [] };
  }

  // Verify origin/main resolves locally BEFORE interpreting per-file absence.
  // Without this, a missing/unfetched/differently-named remote makes every
  // `git cat-file` fail and falsely blocks (mt#2277 review). If the ref can't be
  // resolved, fail OPEN with a reason so the operator sees it's an infra issue,
  // not a real unmerged migration.
  try {
    await execFileAsync("git", ["rev-parse", "--verify", "--quiet", "origin/main"], { cwd });
  } catch {
    return {
      blocked: false,
      unmergedTags: [],
      skippedReason:
        "`origin/main` does not resolve locally (no remote, different remote/branch name, " +
        "or not fetched). Run `git fetch origin main` to enable the unmerged-migration guard.",
    };
  }

  // Resolve the repository root so migration paths are computed relative to it,
  // NOT to `cwd` (mt#2278). `git <tree>:<path>` interprets <path> relative to the
  // repo top-level; if the CLI is invoked from a subdirectory, a cwd-relative path
  // (with `../` segments) would not resolve and a merged migration would be
  // falsely reported absent → false block. Fail OPEN if the root can't be found.
  const { resolve, relative, sep } = await import("path");
  let repoRoot: string;
  try {
    // `promisify(execFile)` resolves to `{ stdout, stderr }` in normal runtime
    // (execFile carries the custom-promisify symbol); under a plain test mock it
    // resolves to the stdout string. Read robustly so both shapes work.
    const top = (await execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd })) as
      | string
      | { stdout: string };
    repoRoot = String(typeof top === "string" ? top : top.stdout).trim();
  } catch {
    return {
      blocked: false,
      unmergedTags: [],
      skippedReason:
        "could not determine the git repository root (`git rev-parse --show-toplevel` failed); " +
        "skipping the unmerged-migration guard.",
    };
  }

  const unmergedTags: string[] = [];

  for (const entry of pendingEntries) {
    const sqlFileName = `${entry.tag}.sql`;
    // Absolute path of the migration file. `resolve` honours an absolute
    // `migrationsFolder` and otherwise resolves a relative one against `cwd`.
    const absSqlPath = resolve(cwd, migrationsFolder, sqlFileName);
    // Path relative to the REPO ROOT — what `git <tree>:<path>` expects. This is
    // correct regardless of the directory the CLI was invoked from. Normalize to
    // POSIX separators: git tree-ish paths require forward slashes, but
    // `path.relative` yields backslashes on Windows (mt#2278 review). The path is
    // derived from a controlled migration filename under the repo root, so it has
    // no `..` segments, no leading `-`, and no `:` — safe to interpolate.
    const repoRelPath = relative(repoRoot, absSqlPath).split(sep).join("/");

    try {
      // `git cat-file -e origin/main:<path>` exits 0 if the object exists,
      // non-zero if it doesn't (file not on origin/main)
      await execFileAsync("git", ["cat-file", "-e", `origin/main:${repoRelPath}`], { cwd });
      // exit 0 → file is present on origin/main → not blocked
    } catch {
      // non-zero exit → file is NOT on origin/main
      unmergedTags.push(entry.tag);
    }
  }

  return {
    blocked: unmergedTags.length > 0,
    unmergedTags,
  };
}

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
  let prev: JournalEntry | undefined;
  for (const curr of journal.entries) {
    if (prev && curr.when <= prev.when) {
      throw new Error(
        `Migration journal timestamps out of order: ` +
          `${prev.tag} (idx=${prev.idx}, when=${prev.when}) >= ` +
          `${curr.tag} (idx=${curr.idx}, when=${curr.when}). ` +
          `Fix the 'when' values in _journal.json to be monotonically increasing.`
      );
    }
    prev = curr;
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
  const migrationsFolder = resolvePgMigrationsFolder();
  const { readdirSync, readFileSync } = await import("fs");

  // Validate journal timestamps before doing anything else
  const journalRaw = readFileSync(join(migrationsFolder, "meta", "_journal.json"), {
    encoding: "utf8",
  }) as string;
  const journal: Journal = JSON.parse(journalRaw);
  validateJournalTimestamps(journal);

  const maskedConn = connectionString.replace(/:\/\/[^:]+:[^@]+@/, "://***:***@");

  const postgres = (await import("postgres")).default;
  const sql = postgres(connectionString, { prepare: false, onnotice: logPostgresNotice, max: 5 });

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
      if (!status.metaExists || status.appliedCount === 0) {
        // Fresh-DB preview (mt#2439): the execute path bootstraps from the
        // snapshot instead of replaying the tree (empty 0000 baseline). The
        // gate mirrors the execute path exactly — absent meta table OR an
        // empty ledger (left behind by a prior failed replay) both bootstrap.
        const { loadBootstrapSnapshot } = await import("./postgres-bootstrap");
        const snapshot = loadBootstrapSnapshot(migrationsFolder);
        if (snapshot) {
          log.cli(
            `Fresh database: --execute will bootstrap from the full-schema snapshot ` +
              `(through ${snapshot.meta.throughTag}), then apply newer migrations incrementally.`
          );
        }
      }
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

  const sql = postgres(connectionString, {
    prepare: false,
    onnotice: logPostgresNotice,
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

    const migrationsFolder = resolvePgMigrationsFolder();

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

    // ── Fresh-DB bootstrap (mt#2439) ────────────────────────────────────────
    // The migration tree starts at an empty baseline (0000) that assumes the
    // pre-baseline schema already exists, so a truly empty database cannot be
    // bootstrapped by replaying the tree. When the drizzle ledger is absent OR
    // empty (drizzle creates the ledger table outside its apply transaction,
    // so a previously failed replay leaves an empty ledger), apply the
    // committed full-schema snapshot and stamp the covered journal entries as
    // applied; migrate() below then applies only entries NEWER than the
    // snapshot. Non-empty (already-migrated) databases never enter this branch.
    if (!metaExists || appliedCount === 0) {
      const { bootstrapFreshPostgres } = await import("./postgres-bootstrap");
      const bootstrap = await bootstrapFreshPostgres(sql, migrationsFolder, journal);
      if (bootstrap) {
        appliedCount = bootstrap.stampedCount;
        log.cli(
          `Bootstrapped fresh database through ${bootstrap.throughTag} ` +
            `(${bootstrap.statementCount} statement(s), ${bootstrap.stampedCount} journal ` +
            `entrie(s) stamped). ${Math.max(
              journal.entries.length - bootstrap.stampedCount,
              0
            )} newer migration(s) pending.`
        );
        log.cli("");
      }
      // bootstrap === null → no snapshot artifact (older bundle); fall through
      // to the plain migrate path, which preserves pre-mt#2439 behavior.
    }

    // ── Unmerged-migration guard (mt#2277) ─────────────────────────────────
    // When targeting a shared production database, refuse to apply any pending
    // migration whose .sql file is not committed AND present on origin/main.
    // This prevents the mt#2229 class: applying a feature-branch-only migration
    // to prod, then closing the branch without merging, leaving the DB and the
    // repo in a diverged state.
    if (isProdPostgresConnection(connectionString)) {
      const override = process.env[UNMERGED_MIGRATION_CHECK_OVERRIDE_ENV];
      const isOverrideActive = ["1", "true", "yes"].includes((override ?? "").toLowerCase());

      if (isOverrideActive) {
        log.cli(
          `[unmerged-migration-guard] override active (${UNMERGED_MIGRATION_CHECK_OVERRIDE_ENV}=${override}) — ` +
            `skipping origin/main presence check. Applied to: ${masked} at ${new Date().toISOString()}`
        );
      } else {
        const check = await checkUnmergedMigrations(
          migrationsFolder,
          journal.entries,
          appliedCount
        );
        if (check.skippedReason) {
          // Fail-open: the guard could not run (origin/main unresolvable). Warn
          // loudly so an infra issue is never silently treated as "all merged".
          log.cli(
            `[unmerged-migration-guard] could not verify against origin/main — ` +
              `${check.skippedReason} Proceeding WITHOUT the guard.`
          );
        }
        if (check.blocked) {
          const tagList = check.unmergedTags.map((t) => `  - ${t}.sql`).join("\n");
          throw new Error(
            `\n🚫 Unmerged-migration guard blocked apply to shared production DB (${masked})\n\n` +
              `The following pending migration(s) are NOT present on origin/main:\n` +
              `${tagList}\n\n` +
              `Merge the originating branch to main FIRST, then re-run:\n` +
              `  minsky persistence migrate --execute\n\n` +
              `Break-glass override (use only when the migration IS intentionally\n` +
              `applied ahead of merge — will be audit-logged):\n` +
              `  ${UNMERGED_MIGRATION_CHECK_OVERRIDE_ENV}=1 minsky persistence migrate --execute`
          );
        }
      }
    }
    // ── end unmerged-migration guard ────────────────────────────────────────

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
    migrationsFolder: resolvePgMigrationsFolder(),
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
  const { readFileSync } = await import("fs");
  const sql = postgres(connectionString, {
    prepare: false,
    onnotice: logPostgresNotice,
    max: 10,
  });
  try {
    const migrationsFolder = resolvePgMigrationsFolder();

    // Fresh-DB bootstrap (mt#2439) — same gate as runPostgresSchemaMigrations:
    // a database with an absent-or-empty drizzle ledger cannot replay the tree
    // (empty 0000 baseline); bootstrap from the snapshot first, then migrate()
    // applies only newer entries.
    const { bootstrapFreshPostgres, isMigrationLedgerEmpty } = await import("./postgres-bootstrap");
    if (await isMigrationLedgerEmpty(sql)) {
      const journalRaw = readFileSync(join(migrationsFolder, "meta", "_journal.json"), {
        encoding: "utf8",
      }) as string;
      await bootstrapFreshPostgres(sql, migrationsFolder, JSON.parse(journalRaw) as Journal);
    }

    const db = drizzle(sql, { logger: false });
    await migrate(db, { migrationsFolder });
  } finally {
    await sql.end();
  }
}
