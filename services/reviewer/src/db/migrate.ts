/**
 * Reviewer migration runner.
 *
 * Applies pending migrations from services/reviewer/migrations/pg/ at
 * startup using drizzle-orm/postgres-js/migrator. Called before the webhook
 * server starts listening.
 *
 * Sealed: no imports from src/.
 *
 * ## Why a dedicated migrationsTable (mt#1967)
 *
 * drizzle's postgres-js migrator uses a TIMESTAMP comparison to decide
 * whether a migration is pending:
 *
 *     if (!lastDbMigration || Number(lastDbMigration.created_at) < migration.folderMillis) { apply }
 *
 * When two services share the default `drizzle.__drizzle_migrations` table
 * AND the other service's most-recent migration is newer than ALL of this
 * service's journal-`when` values, this service's migrations are silently
 * skipped. No exception, no warning — `migrations_applied` logs as success.
 *
 * The reviewer service shares its Postgres database with main Minsky. Main
 * Minsky's most-recent journal `when` (2026-05-25 08:00:00 UTC) is newer
 * than all three reviewer journal values, so the silent-skip bug fired on
 * every reviewer-service boot until mt#1967 — the reviewer's webhook-event
 * and inflight-marker tables were never created in production.
 *
 * Fix: use a dedicated tracking table. Each service's migrator now operates
 * against its own (schema, table) pair and the timestamp comparison stays
 * local to that service.
 *
 * ## Self-check
 *
 * After migrate() returns, walk the reviewer's expected table set and
 * verify each exists. Fail-fast if any are missing — that signals either
 * a new instance of the silent-skip class on a freshly-introduced
 * cross-service collision, or a manual DROP TABLE that bypassed the
 * tracking table.
 */

import { join } from "node:path";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { sql } from "drizzle-orm";
import type { ReviewerDb } from "./client";

/** Dedicated migrations table for the reviewer service (mt#1967). */
export const REVIEWER_MIGRATIONS_TABLE = "__drizzle_migrations_reviewer";

/** Migrations schema (default; sharing the `drizzle` schema is fine — only the table is service-scoped). */
export const REVIEWER_MIGRATIONS_SCHEMA = "drizzle";

/**
 * Schema where reviewer-service application tables live. Hard-coded rather
 * than derived from `current_schema()` because the reviewer service's tables
 * are created in `public` (per the migration DDL) regardless of the runtime
 * search_path. Using `current_schema()` would produce false-negative self-
 * check failures if the search_path is set differently in some sessions
 * (PR #1197 R1 fix).
 */
export const REVIEWER_TABLES_SCHEMA = "public";

/**
 * Tables the reviewer service expects to exist after applyMigrations() succeeds.
 * Source of truth for the post-migration self-check.
 *
 * Order matches the migration sequence (0000 → convergence_metrics,
 * 0001 → webhook_events, 0002 → inflight_reviews). Update this list
 * whenever a new reviewer migration adds a table.
 */
export const REVIEWER_EXPECTED_TABLES = [
  "reviewer_convergence_metrics",
  "reviewer_webhook_events",
  "reviewer_inflight_reviews",
] as const;

/**
 * Apply all pending reviewer migrations and verify the resulting schema.
 *
 * Throws on any migration error — callers should catch, log, and exit
 * non-zero (fail-fast semantics).
 *
 * @param db - Drizzle DB instance to run migrations against
 */
export async function applyMigrations(db: ReviewerDb): Promise<void> {
  // Resolve migrations folder relative to this source file so the path is
  // correct regardless of the process working directory. From
  // services/reviewer/src/db/ (import.meta.dir), go up two levels to reach
  // services/reviewer/, then descend into migrations/pg/.
  await migrate(db, {
    migrationsFolder: join(import.meta.dir, "..", "..", "migrations", "pg"),
    migrationsTable: REVIEWER_MIGRATIONS_TABLE,
    migrationsSchema: REVIEWER_MIGRATIONS_SCHEMA,
  });

  // SC#4 — Post-migration self-check.
  // Walk REVIEWER_EXPECTED_TABLES and fail fast if any expected table is
  // missing. Catches the silent-skip class (when migrate() returns without
  // applying migrations) and the manual-DROP class.
  await verifyExpectedTables(db);
}

/**
 * Verify every table in REVIEWER_EXPECTED_TABLES exists in `pg_tables`.
 * Throws with a structured message listing the missing tables when any
 * are absent.
 *
 * @param db - Drizzle DB instance
 */
export async function verifyExpectedTables(db: ReviewerDb): Promise<void> {
  // Scope to REVIEWER_TABLES_SCHEMA explicitly rather than current_schema()
  // — the migration DDL targets `public` unconditionally; a search_path
  // override at the session level would cause current_schema() to return a
  // different schema and produce false-negative self-check failures
  // (PR #1197 R1 fix).
  const result = await db.execute<{ tablename: string }>(sql`
    SELECT tablename FROM pg_tables
    WHERE schemaname = ${REVIEWER_TABLES_SCHEMA}
      AND tablename = ANY(${[...REVIEWER_EXPECTED_TABLES] as string[]})
  `);
  const presentTables = new Set(result.map((row) => row.tablename));
  const missing = REVIEWER_EXPECTED_TABLES.filter((t) => !presentTables.has(t));
  if (missing.length > 0) {
    throw new Error(
      `Reviewer-service post-migration self-check FAILED: ${missing.length} expected ` +
        `table(s) missing after migrate() returned: ${missing.join(", ")}. ` +
        `This indicates either drizzle's silent-skip bug (the same class as mt#1967 — ` +
        `latest row in ${REVIEWER_MIGRATIONS_SCHEMA}.${REVIEWER_MIGRATIONS_TABLE} has a ` +
        `created_at greater than all expected migrations' folderMillis) or a manual ` +
        `DROP TABLE that bypassed the tracking table. See services/reviewer/DEPLOY.md.`
    );
  }
}
