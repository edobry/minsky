#!/usr/bin/env bun
/**
 * One-time backfill: assign a numeric `ws#N` short id (mt#2967, ADR-029) to
 * every existing session row created before the `short_id` column shipped.
 *
 * The schema migration (0067) is additive-nullable — it does NOT backfill.
 * `DrizzleSessionRepository.addSession()` mints `ws#N` only for NEW rows
 * going forward (mt#2967). This script is the separate, explicitly-run
 * operational step that assigns short ids to pre-existing rows, per
 * `operational-safety-dry-run-first.mdc`'s "bulk shared-state mutation
 * requires a task wrapper + dry-run" discipline.
 *
 * Assignment order: every session WITHOUT a short_id, sorted by `createdAt`
 * ascending (oldest first), numbered sequentially starting after the
 * highest already-assigned `ws#N` (so ids minted by `addSession()` between
 * migration-deploy and this script's run are never collided with or
 * reissued). Uses the shared `nextShortId` foundation util (mt#2963) — no
 * reimplemented minting logic.
 *
 * Idempotent: rows that already carry a short_id are skipped on replan, and
 * the per-row UPDATE additionally guards `WHERE short_id IS NULL` so a
 * concurrent addSession() racing this script can never be clobbered.
 *
 * Concurrency (mirrors scripts/backfill-memory-short-ids.ts, PR #2134 R1):
 * an `--execute` run acquires a fixed-key Postgres SESSION advisory lock
 * (`pg_try_advisory_lock`) before touching any row, and releases it
 * (`pg_advisory_unlock`) when done — success or failure. This prevents two
 * concurrent `--execute` invocations from racing each other's plans (both
 * computing "the next N ids are free" from the same stale snapshot and then
 * double-assigning). A run that finds the lock already held fails FAST with
 * a clear message rather than proceeding — it does NOT block waiting for the
 * lock, since a human operator re-running this script wants to know
 * immediately that another run is in flight, not queue behind it silently.
 * Dry-run needs no lock (read-only, no mutation to race).
 *
 * Usage:
 *   bun scripts/backfill-session-short-ids.ts              # dry-run (default)
 *   bun scripts/backfill-session-short-ids.ts --execute     # apply
 *
 * Safety (CLAUDE.md §Operational Safety: Dry-Run First):
 *   - Dry-run by default; `--execute` required to mutate.
 *   - Operates across ALL project scopes (short ids are a GLOBAL sequence
 *     per mt#2963's short-id.ts scoping doc — mirrors the global `mt#N`
 *     task counter) — there is no `--all-projects` gate to bypass; this
 *     backfill is inherently cross-project.
 *   - Every row gets AT MOST one short_id assignment per run; a second run
 *     over the same data is a no-op (all rows already assigned).
 *
 * Output: human-readable summary + a JSON result block on stdout.
 *
 * @see mt#2967 — this script's originating task
 * @see mt#2963 — short-id.ts (nextShortId), short-id-column.ts (schema pattern)
 * @see scripts/backfill-memory-short-ids.ts — the sibling this script mirrors
 * @see packages/domain/src/storage/migrations/pg/0067_careful_saracen.sql — the additive column+index migration
 */

import "reflect-metadata";
import { and, eq, isNull, sql } from "drizzle-orm";

import { nextShortId } from "@minsky/domain/utils/short-id";
import { postgresSessions } from "@minsky/domain/storage/schemas/session-schema";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { WorkspaceId } from "@minsky/domain/ids";

// ---------------------------------------------------------------------------
// Advisory lock — serializes concurrent `--execute` runs (mirrors the
// memory backfill's PR #2134 R1 fix)
// ---------------------------------------------------------------------------

/**
 * Fixed advisory-lock key for this backfill. Arbitrary but stable — derived
 * from the originating task number (mt#2967) with a distinguishing suffix so
 * it doesn't collide with any OTHER script that might key an advisory lock
 * off the same task number. Session-scoped (not xact-scoped): held for the
 * lifetime of this process, released explicitly in a `finally` block.
 */
export const BACKFILL_ADVISORY_LOCK_KEY = 2_967_100n;

/**
 * Attempt to acquire the backfill's session advisory lock without blocking.
 * Returns `true` if acquired, `false` if another session already holds it.
 */
export async function tryAcquireBackfillLock(db: PostgresJsDatabase): Promise<boolean> {
  const result = await db.execute(sql`SELECT pg_try_advisory_lock(${BACKFILL_ADVISORY_LOCK_KEY})`);
  const row = Array.from(result as Iterable<Record<string, unknown>>)[0];
  return row?.["pg_try_advisory_lock"] === true;
}

/** Release the backfill's session advisory lock. Safe to call even if the lock was never held. */
export async function releaseBackfillLock(db: PostgresJsDatabase): Promise<void> {
  await db.execute(sql`SELECT pg_advisory_unlock(${BACKFILL_ADVISORY_LOCK_KEY})`);
}

// ---------------------------------------------------------------------------
// Pure planning logic — unit-testable without a DB
// ---------------------------------------------------------------------------

/** Minimal shape this script needs from a session row to plan assignments. */
export interface BackfillCandidateRow {
  sessionId: string;
  shortId: string | null;
  createdAt: string | Date;
}

/** One planned `sessionId -> ws#N` assignment. */
export interface PlannedAssignment {
  sessionId: string;
  shortId: string;
}

export interface BackfillPlan {
  /** Assignments to apply, in the order they should be written. */
  assignments: PlannedAssignment[];
  /** Rows that already had a short_id and are left untouched (idempotent skip). */
  alreadyAssigned: number;
  /** Total rows considered. */
  total: number;
}

function toTimeMs(value: string | Date): number {
  const t = value instanceof Date ? value.getTime() : new Date(value).getTime();
  // Malformed/unparseable timestamps sort last (Number.MAX_SAFE_INTEGER)
  // rather than crashing or silently sorting first — defensive against a
  // corrupt row without letting it jump the queue.
  return Number.isFinite(t) ? t : Number.MAX_SAFE_INTEGER;
}

/**
 * Plan `ws#N` assignments for every row lacking a short_id, oldest-first by
 * `createdAt`. Pure — no I/O, no randomness — so the same input always
 * produces the same plan, and the plan can be unit-tested directly.
 *
 * Idempotent by construction: rows that already carry a `shortId` are
 * excluded from `assignments` entirely (counted only in `alreadyAssigned`),
 * so re-planning over a partially-backfilled table only proposes the
 * remaining gaps.
 */
export function planBackfillAssignments(rows: BackfillCandidateRow[]): BackfillPlan {
  const total = rows.length;
  const withShortId = rows.filter((r) => !!r.shortId);
  const missing = rows.filter((r) => !r.shortId);

  const sorted = [...missing].sort((a, b) => toTimeMs(a.createdAt) - toTimeMs(b.createdAt));

  // Seed the live-id set with everything already assigned so the first
  // proposed id in this batch never collides with a short_id minted by
  // addSession() (e.g. a new session created after migration-deploy but
  // before this script ran). Grows as each assignment is planned so ids
  // stay monotonic and unique WITHIN the batch too.
  let liveIds: string[] = withShortId
    .map((r) => r.shortId)
    .filter((s): s is string => typeof s === "string");

  const assignments: PlannedAssignment[] = [];
  for (const row of sorted) {
    const next = nextShortId("ws", liveIds, []);
    assignments.push({ sessionId: row.sessionId, shortId: next });
    liveIds = [...liveIds, next];
  }

  return { assignments, alreadyAssigned: withShortId.length, total };
}

// ---------------------------------------------------------------------------
// DB bootstrap + execution
// ---------------------------------------------------------------------------

async function bootstrapDb(): Promise<PostgresJsDatabase> {
  const { initializeConfiguration, CustomConfigFactory } = await import(
    "@minsky/domain/configuration"
  );
  const { createCliContainer } = await import("../src/composition/cli");

  await initializeConfiguration(new CustomConfigFactory(), {
    workingDirectory: process.cwd(),
  });

  const container = await createCliContainer();
  await container.initialize();

  const persistence = container.has("persistence") ? container.get("persistence") : undefined;

  // Duck-typed guard (mirrors scripts/backfill-memory-short-ids.ts /
  // scripts/backfill-ask-short-ids.ts's PR #2110 R1 fix), not
  // `instanceof PersistenceProvider`: an `instanceof` check against a class
  // pulled in via a dynamic `import()` can false-negative when the resolved
  // object was constructed from a DIFFERENT instance of the same module
  // (dual-package hazard) — the check then silently rejects a perfectly
  // valid provider. Check for the actual capability/method this script
  // needs instead.
  interface SqlCapablePersistence {
    getDatabaseConnection: () => Promise<PostgresJsDatabase | null>;
  }
  const isSqlCapablePersistence = (p: unknown): p is SqlCapablePersistence =>
    !!p &&
    !!(p as { capabilities?: { sql?: boolean } }).capabilities?.sql &&
    typeof (p as { getDatabaseConnection?: unknown }).getDatabaseConnection === "function";

  if (!isSqlCapablePersistence(persistence)) {
    throw new Error("Backfill requires a SQL-capable persistence provider (Postgres).");
  }

  const connection = await persistence.getDatabaseConnection();
  if (!connection) {
    throw new Error("Backfill requires an initialized Postgres database connection.");
  }
  return connection;
}

async function fetchAllSessionRows(db: PostgresJsDatabase): Promise<BackfillCandidateRow[]> {
  const rows = await db
    .select({
      sessionId: postgresSessions.sessionId,
      shortId: postgresSessions.shortId,
      createdAt: postgresSessions.createdAt,
    })
    .from(postgresSessions);
  return rows as BackfillCandidateRow[];
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const execute = argv.includes("--execute");

  const db = await bootstrapDb();

  // Advisory lock: --execute only (dry-run is read-only, nothing to race).
  // Fails FAST (does not block/wait) so a human operator sees immediately
  // that another backfill run is in flight, rather than silently queuing.
  let lockHeld = false;
  if (execute) {
    lockHeld = await tryAcquireBackfillLock(db);
    if (!lockHeld) {
      console.error(
        "backfill-session-short-ids: another backfill run already holds the advisory lock " +
          `(key=${BACKFILL_ADVISORY_LOCK_KEY}). Refusing to proceed — wait for it to finish, ` +
          "or investigate if it's stuck, then retry."
      );
      process.exit(1);
    }
  }

  try {
    const rows = await fetchAllSessionRows(db);
    const plan = planBackfillAssignments(rows);

    console.log(`backfill-session-short-ids ${execute ? "(EXECUTE)" : "(dry-run)"}`);
    console.log(`  total sessions:            ${plan.total}`);
    console.log(`  already assigned:        ${plan.alreadyAssigned}`);
    console.log(`  planned assignments:     ${plan.assignments.length}`);
    const preview = plan.assignments.slice(0, 20);
    for (const a of preview) {
      console.log(`      ${a.shortId}  <-  ${a.sessionId}`);
    }
    if (plan.assignments.length > preview.length) {
      console.log(`      ... and ${plan.assignments.length - preview.length} more`);
    }

    let assigned = 0;
    let skippedRace = 0;
    const errors: Array<{ sessionId: string; message: string }> = [];

    if (execute) {
      for (const a of plan.assignments) {
        try {
          const updated = await db
            .update(postgresSessions)
            .set({ shortId: a.shortId })
            .where(
              and(
                eq(postgresSessions.sessionId, a.sessionId as WorkspaceId),
                isNull(postgresSessions.shortId)
              )
            )
            .returning({ sessionId: postgresSessions.sessionId });
          if (updated.length > 0) {
            assigned += 1;
          } else {
            // Row already had a short_id by the time we got here (a
            // concurrent addSession() or a re-run mid-flight) — idempotent skip.
            skippedRace += 1;
          }
        } catch (err) {
          errors.push({
            sessionId: a.sessionId,
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }
      console.log(
        `  assigned=${assigned} skippedRace=${skippedRace} errors=${errors.length} of ${plan.assignments.length}`
      );
      for (const e of errors.slice(0, 10)) console.log(`    error ${e.sessionId}: ${e.message}`);

      // Verification (per mt#2967 acceptance: "count matches"): recount rows
      // still missing a short_id after the run.
      const postRows = await fetchAllSessionRows(db);
      const stillMissing = postRows.filter((r) => !r.shortId).length;
      console.log(
        `  post-run: ${postRows.length - stillMissing}/${postRows.length} have a short_id`
      );
    } else {
      console.log(
        `  (dry-run — re-run with --execute to assign ${plan.assignments.length} short ids)`
      );
    }

    const result = {
      mode: execute ? "execute" : "dry-run",
      total: plan.total,
      alreadyAssigned: plan.alreadyAssigned,
      plannedAssignments: plan.assignments.length,
      assigned,
      skippedRace,
      errorCount: errors.length,
    };
    console.log(JSON.stringify(result));

    // Release the advisory lock BEFORE exiting — process.exit() terminates
    // synchronously and does not reliably run pending `finally` blocks, so
    // the release must happen on every path through this try block rather
    // than relying on unwind-on-exit. (A session advisory lock is also
    // auto-released by Postgres when the connection closes, but explicit
    // release here means a long-lived connection pool doesn't carry a
    // stale hold forward.)
    if (lockHeld) await releaseBackfillLock(db);
    process.exit(errors.length > 0 ? 1 : 0);
  } catch (err) {
    if (lockHeld) await releaseBackfillLock(db);
    throw err;
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(
      `backfill-session-short-ids failed: ${err instanceof Error ? err.message : String(err)}`
    );
    process.exit(1);
  });
}
