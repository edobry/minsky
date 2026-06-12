/**
 * Fresh-database bootstrap for the Postgres migration tree (mt#2439).
 *
 * The migration tree was squashed with `0000_charming_smasher.sql` as a
 * literal `-- empty baseline`, so the pre-baseline schema (e.g.
 * `task_embeddings`, `sessions`) is not created by any migration file —
 * `0001` immediately ALTERs tables that a fresh database does not have.
 * Replaying the tree from empty therefore cannot work.
 *
 * Instead, on a TRULY EMPTY database the runner applies a committed
 * full-current-schema snapshot (generated from the drizzle schema definitions
 * by `scripts/generate-bootstrap-snapshot.ts`) and stamps the drizzle ledger
 * with one row per journal entry the snapshot covers — each row carrying the
 * same sha256-of-file-content hash and `created_at = entry.when` that
 * drizzle's own migrator would have recorded. The database afterwards looks
 * exactly as if the tree had been replayed, so every existing assertion
 * (`assertMigrationCountMatch`, status displays, drift detection) works
 * unchanged, and drizzle's timestamp high-water-mark apply (memory
 * `0c2427e5`) runs any migration NEWER than the snapshot normally.
 *
 * A STALE snapshot is therefore still correct: it bootstraps through its own
 * `throughTag` and the incremental tail applies on top. Regenerating the
 * snapshot is an optimization, not a correctness requirement.
 *
 * Existing (non-empty) databases NEVER take this path — the caller gates on
 * "no drizzle ledger", and this module additionally fail-closes when the
 * public schema already contains tables (ledger-lost mid-state, which must be
 * diagnosed by an operator, not auto-bootstrapped).
 *
 * @see mt#2439 — originating task (plan decision: Option A)
 * @see mt#2369 — cold-start-migrate CI gate (the acceptance gate for this path)
 */

import { join } from "path";
import { existsSync, readFileSync } from "fs";
import { createHash } from "crypto";
import { log } from "@minsky/shared/logger";
import type { Journal, JournalEntry } from "./postgres-migration-operations";

/**
 * Filesystem seam, injectable for tests (no-real-fs-in-tests convention).
 * Production callers use the module-level default.
 */
export interface BootstrapFsDeps {
  existsSync: (path: string) => boolean;
  readFileSync: (path: string) => string;
}

const defaultFsDeps: BootstrapFsDeps = {
  existsSync,
  readFileSync: (path: string) => readFileSync(path, { encoding: "utf8" }) as string,
};

/** Parsed bootstrap snapshot artifact (full-schema.sql + meta.json). */
export interface BootstrapSnapshot {
  /** Full-current-schema DDL, drizzle `--> statement-breakpoint` separated. */
  sql: string;
  /** Journal high-water-mark the snapshot corresponds to. */
  meta: BootstrapMeta;
}

export interface BootstrapMeta {
  /** Tag of the last journal entry the snapshot's schema includes. */
  throughTag: string;
  /** `when` (folderMillis) of that entry — the ledger stamp timestamp. */
  when: number;
}

/**
 * Load the bootstrap snapshot from `<migrationsFolder>/bootstrap/`.
 * Returns null when the artifact is absent (e.g. an older bundle) — the
 * caller then falls back to the plain migrate path. Throws on a malformed
 * meta.json: a present-but-broken artifact is a packaging bug, not a
 * fall-back case.
 */
export function loadBootstrapSnapshot(
  migrationsFolder: string,
  fsDeps: BootstrapFsDeps = defaultFsDeps
): BootstrapSnapshot | null {
  const sqlPath = join(migrationsFolder, "bootstrap", "full-schema.sql");
  const metaPath = join(migrationsFolder, "bootstrap", "meta.json");
  if (!fsDeps.existsSync(sqlPath) || !fsDeps.existsSync(metaPath)) {
    return null;
  }
  const meta = JSON.parse(fsDeps.readFileSync(metaPath)) as BootstrapMeta;
  if (typeof meta?.throughTag !== "string" || typeof meta?.when !== "number") {
    throw new Error(
      `Malformed bootstrap snapshot meta at ${metaPath}: expected { throughTag: string, when: number }. ` +
        `Regenerate with: bun scripts/generate-bootstrap-snapshot.ts`
    );
  }
  return { sql: fsDeps.readFileSync(sqlPath), meta };
}

/**
 * Select the journal entries the snapshot covers — the prefix of the journal
 * up to and including `meta.throughTag`. These are the entries stamped into
 * the ledger as already-applied.
 *
 * Validates that the snapshot and journal agree: `throughTag` must exist in
 * the journal with exactly `meta.when`, and every covered entry's `when` must
 * be <= `meta.when` (monotonic journals guarantee this; a violation means the
 * journal was rewritten after the snapshot was generated).
 */
export function selectStampEntries(journal: Journal, meta: BootstrapMeta): JournalEntry[] {
  const idx = journal.entries.findIndex((e) => e.tag === meta.throughTag);
  if (idx === -1) {
    throw new Error(
      `Bootstrap snapshot meta references journal tag "${meta.throughTag}" which is not in ` +
        `meta/_journal.json. The snapshot and journal have diverged — regenerate with: ` +
        `bun scripts/generate-bootstrap-snapshot.ts`
    );
  }
  const through = journal.entries[idx];
  if (!through) {
    throw new Error(`Journal entry at index ${idx} is unexpectedly absent.`);
  }
  if (through.when !== meta.when) {
    throw new Error(
      `Bootstrap snapshot meta 'when' (${meta.when}) does not match journal entry ` +
        `"${meta.throughTag}" (when=${through.when}). The snapshot and journal have diverged — ` +
        `regenerate with: bun scripts/generate-bootstrap-snapshot.ts`
    );
  }
  const covered = journal.entries.slice(0, idx + 1);
  for (const entry of covered) {
    if (entry.when > meta.when) {
      throw new Error(
        `Journal entry "${entry.tag}" (when=${entry.when}) precedes "${meta.throughTag}" in the ` +
          `journal but has a NEWER timestamp than the snapshot (${meta.when}). Journal timestamps ` +
          `must be monotonic; fix meta/_journal.json.`
      );
    }
  }
  return covered;
}

/**
 * Split a drizzle-generated SQL file into executable statements on the
 * `--> statement-breakpoint` separator (same convention drizzle's own
 * migrator uses). Empty fragments are dropped.
 */
export function splitSqlStatements(sqlText: string): string[] {
  return sqlText
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Minimal postgres.js-shaped client surfaces the bootstrap needs.
 * `PromiseLike` (not `Promise`) because postgres.js queries are thenable
 * `PendingQuery` objects; the transaction surface excludes `begin` because
 * postgres.js's `TransactionSql` omits it (no nested begin).
 */
interface PostgresTx {
  unsafe(query: string): PromiseLike<unknown>;
}

interface PostgresClient extends PostgresTx {
  begin(fn: (tx: PostgresTx) => Promise<unknown>): PromiseLike<unknown>;
}

/**
 * True when the drizzle migration ledger is absent OR has zero rows — the
 * fresh-database signal that gates the bootstrap path. The zero-rows case
 * matters because drizzle's migrator creates the ledger table OUTSIDE its
 * apply transaction: a previously FAILED replay attempt (the exact mt#2439
 * failure mode) leaves an empty ledger behind, and the retry must still be
 * recognized as fresh.
 */
export async function isMigrationLedgerEmpty(sql: {
  unsafe(query: string): PromiseLike<unknown>;
}): Promise<boolean> {
  const existsRows = (await sql.unsafe(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'drizzle' AND table_name = '__drizzle_migrations'
     ) as exists`
  )) as Array<{ exists: boolean }>;
  if (!existsRows?.[0]?.exists) {
    return true;
  }
  const countRows = (await sql.unsafe(
    `SELECT COUNT(*)::text as count FROM "drizzle"."__drizzle_migrations"`
  )) as Array<{ count: string }>;
  return parseInt(countRows?.[0]?.count || "0", 10) === 0;
}

/**
 * Throw unless the database is TRULY empty (no base tables in the public
 * schema). Called only when the drizzle ledger is absent; a database with
 * tables but no ledger is a ledger-lost mid-state that an operator must
 * diagnose — auto-bootstrapping would fail on the first duplicate CREATE
 * anyway, with a far more confusing error.
 */
export async function assertDatabaseTrulyEmpty(sql: {
  unsafe(query: string): PromiseLike<unknown>;
}): Promise<void> {
  const rows = (await sql.unsafe(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_type = 'BASE TABLE' LIMIT 5`
  )) as Array<{ table_name: string }>;
  if (rows.length > 0) {
    throw new Error(
      `Database has no drizzle migration ledger but the public schema already contains ` +
        `tables (${rows.map((r) => r.table_name).join(", ")}${rows.length === 5 ? ", …" : ""}). ` +
        `This is a ledger-lost state that cannot be auto-bootstrapped — diagnose how the ` +
        `ledger was lost before migrating (see mt#2439 / mt#2250 for the reconciliation pattern).`
    );
  }
}

/** Result of a fresh-database bootstrap. */
export interface BootstrapResult {
  /** Number of journal entries stamped as applied (snapshot coverage). */
  stampedCount: number;
  /** Tag of the last stamped entry. */
  throughTag: string;
  /** Number of DDL statements executed from the snapshot. */
  statementCount: number;
}

/**
 * Bootstrap a truly-empty database: apply the full-schema snapshot, create
 * the drizzle ledger, and stamp every covered journal entry as applied.
 * Returns null when no snapshot artifact is available (caller falls back to
 * the plain migrate path). Runs in a single transaction.
 */
export async function bootstrapFreshPostgres(
  sql: PostgresClient,
  migrationsFolder: string,
  journal: Journal,
  fsDeps: BootstrapFsDeps = defaultFsDeps
): Promise<BootstrapResult | null> {
  const snapshot = loadBootstrapSnapshot(migrationsFolder, fsDeps);
  if (!snapshot) {
    return null;
  }

  await assertDatabaseTrulyEmpty(sql);

  const stampEntries = selectStampEntries(journal, snapshot.meta);
  const statements = splitSqlStatements(snapshot.sql);

  // Pre-compute the ledger rows OUTSIDE the transaction so a missing/unreadable
  // migration file aborts before any DDL runs. Hash derivation mirrors
  // drizzle's migrator exactly: sha256 hex of the full file content.
  const stampRows = stampEntries.map((entry) => {
    const content = fsDeps.readFileSync(join(migrationsFolder, `${entry.tag}.sql`));
    return {
      hash: createHash("sha256").update(content).digest("hex"),
      createdAt: entry.when,
    };
  });

  log.cli(
    `Fresh database detected — bootstrapping from snapshot through ${snapshot.meta.throughTag} ` +
      `(${statements.length} DDL statement(s), stamping ${stampRows.length} journal entrie(s))`
  );

  await sql.begin(async (tx) => {
    for (const statement of statements) {
      await tx.unsafe(statement);
    }
    // Same ledger DDL drizzle's pg dialect creates (pg-core/dialect.ts migrate()).
    await tx.unsafe(`CREATE SCHEMA IF NOT EXISTS "drizzle"`);
    await tx.unsafe(
      `CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations" (
        id SERIAL PRIMARY KEY,
        hash text NOT NULL,
        created_at bigint
      )`
    );
    for (const row of stampRows) {
      // Values are derived from controlled local artifacts (hex digest +
      // journal integer), not user input; inline interpolation is safe here
      // and keeps the client surface minimal.
      await tx.unsafe(
        `INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") ` +
          `VALUES ('${row.hash}', ${row.createdAt})`
      );
    }
  });

  return {
    stampedCount: stampRows.length,
    throughTag: snapshot.meta.throughTag,
    statementCount: statements.length,
  };
}
