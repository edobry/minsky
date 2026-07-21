#!/usr/bin/env bun
/**
 * One-time backfill: assign a numeric `mem#N` short id (mt#2966, ADR-029) to
 * every existing memory row created before the `short_id` column shipped.
 *
 * The schema migration (0066) is additive-nullable — it does NOT backfill.
 * `MemoryService.create()`/`supersede()` mint `mem#N` only for NEW rows going
 * forward (mt#2966). This script is the separate, explicitly-run operational
 * step that assigns short ids to pre-existing rows, per
 * `operational-safety-dry-run-first.mdc`'s "bulk shared-state mutation
 * requires a task wrapper + dry-run" discipline.
 *
 * Assignment order: every memory WITHOUT a short_id, sorted by `createdAt`
 * ascending (oldest first), numbered sequentially starting after the
 * highest already-assigned `mem#N` (so ids minted by `create()` between
 * migration-deploy and this script's run are never collided with or
 * reissued). Uses the shared `nextShortId` foundation util (mt#2963) — no
 * reimplemented minting logic.
 *
 * Idempotent: rows that already carry a short_id are skipped on replan, and
 * the per-row UPDATE additionally guards `WHERE short_id IS NULL` so a
 * concurrent create() racing this script can never be clobbered.
 *
 * Usage:
 *   bun scripts/backfill-memory-short-ids.ts              # dry-run (default)
 *   bun scripts/backfill-memory-short-ids.ts --execute     # apply
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
 * @see mt#2966 — this script's originating task
 * @see mt#2963 — short-id.ts (nextShortId), short-id-column.ts (schema pattern)
 * @see packages/domain/src/storage/migrations/pg/0066_careless_karma.sql — the additive column+index migration
 */

import "reflect-metadata";
import { and, eq, isNull } from "drizzle-orm";

import { nextShortId } from "@minsky/domain/utils/short-id";
import { memoriesTable } from "@minsky/domain/storage/schemas/memory-embeddings";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

// ---------------------------------------------------------------------------
// Pure planning logic — unit-testable without a DB (memories-short-id-backfill
// portion of the mt#2966 test suite).
// ---------------------------------------------------------------------------

/** Minimal shape this script needs from a memory row to plan assignments. */
export interface BackfillCandidateRow {
  id: string;
  shortId: string | null;
  createdAt: string | Date;
}

/** One planned `id -> mem#N` assignment. */
export interface PlannedAssignment {
  id: string;
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
 * Plan `mem#N` assignments for every row lacking a short_id, oldest-first by
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
  // create() (e.g. a new memory created after migration-deploy but before
  // this script ran). Grows as each assignment is planned so ids stay
  // monotonic and unique WITHIN the batch too.
  let liveIds: string[] = withShortId
    .map((r) => r.shortId)
    .filter((s): s is string => typeof s === "string");

  const assignments: PlannedAssignment[] = [];
  for (const row of sorted) {
    const next = nextShortId("mem", liveIds, []);
    assignments.push({ id: row.id, shortId: next });
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

  // Duck-typed guard (mirrors scripts/backfill-ask-short-ids.ts's PR #2110 R1
  // fix), not `instanceof PersistenceProvider`: an `instanceof` check against
  // a class pulled in via a dynamic `import()` can false-negative when the
  // resolved object was constructed from a DIFFERENT instance of the same
  // module (dual-package hazard) — the check then silently rejects a
  // perfectly valid provider. Check for the actual capability/method this
  // script needs instead, matching the established pattern used across the
  // cockpit DB-access sites (e.g. src/cockpit/db-providers.ts,
  // src/cockpit/widgets/attention.ts, scripts/smoke-transcript-watcher.ts).
  const hasSqlCapability =
    !!persistence && !!(persistence as { capabilities?: { sql?: boolean } }).capabilities?.sql;
  const hasGetDatabaseConnection =
    !!persistence &&
    typeof (persistence as { getDatabaseConnection?: unknown }).getDatabaseConnection ===
      "function";
  if (!hasSqlCapability || !hasGetDatabaseConnection) {
    throw new Error("Backfill requires a SQL-capable persistence provider (Postgres).");
  }

  const connection = await (
    persistence as { getDatabaseConnection: () => Promise<PostgresJsDatabase | null> }
  ).getDatabaseConnection();
  if (!connection) {
    throw new Error("Backfill requires an initialized Postgres database connection.");
  }
  return connection;
}

async function fetchAllMemoryRows(db: PostgresJsDatabase): Promise<BackfillCandidateRow[]> {
  const rows = await db
    .select({
      id: memoriesTable.id,
      shortId: memoriesTable.shortId,
      createdAt: memoriesTable.createdAt,
    })
    .from(memoriesTable);
  return rows as BackfillCandidateRow[];
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const execute = argv.includes("--execute");

  const db = await bootstrapDb();
  const rows = await fetchAllMemoryRows(db);
  const plan = planBackfillAssignments(rows);

  console.log(`backfill-memory-short-ids ${execute ? "(EXECUTE)" : "(dry-run)"}`);
  console.log(`  total memories:           ${plan.total}`);
  console.log(`  already assigned:        ${plan.alreadyAssigned}`);
  console.log(`  planned assignments:     ${plan.assignments.length}`);
  const preview = plan.assignments.slice(0, 20);
  for (const a of preview) {
    console.log(`      ${a.shortId}  <-  ${a.id}`);
  }
  if (plan.assignments.length > preview.length) {
    console.log(`      ... and ${plan.assignments.length - preview.length} more`);
  }

  let assigned = 0;
  let skippedRace = 0;
  const errors: Array<{ id: string; message: string }> = [];

  if (execute) {
    for (const a of plan.assignments) {
      try {
        const updated = await db
          .update(memoriesTable)
          .set({ shortId: a.shortId })
          .where(and(eq(memoriesTable.id, a.id), isNull(memoriesTable.shortId)))
          .returning({ id: memoriesTable.id });
        if (updated.length > 0) {
          assigned += 1;
        } else {
          // Row already had a short_id by the time we got here (a
          // concurrent create() or a re-run mid-flight) — idempotent skip.
          skippedRace += 1;
        }
      } catch (err) {
        errors.push({ id: a.id, message: err instanceof Error ? err.message : String(err) });
      }
    }
    console.log(
      `  assigned=${assigned} skippedRace=${skippedRace} errors=${errors.length} of ${plan.assignments.length}`
    );
    for (const e of errors.slice(0, 10)) console.log(`    error ${e.id}: ${e.message}`);

    // Verification (per mt#2966 acceptance: "count matches"): recount rows
    // still missing a short_id after the run.
    const postRows = await fetchAllMemoryRows(db);
    const stillMissing = postRows.filter((r) => !r.shortId).length;
    console.log(`  post-run: ${postRows.length - stillMissing}/${postRows.length} have a short_id`);
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

  process.exit(errors.length > 0 ? 1 : 0);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(
      `backfill-memory-short-ids failed: ${err instanceof Error ? err.message : String(err)}`
    );
    process.exit(1);
  });
}
