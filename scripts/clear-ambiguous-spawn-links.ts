#!/usr/bin/env bun
/**
 * One-time corrective sweep (mt#3702, corrected by mt#3976): clear
 * `agent_spawns.child_agent_session_id` on rows whose link was never valid.
 *
 * ## Which rows are wrong, and why the predicate is what it is
 *
 * The cwd-time-window heuristic takes the parent session, the parent cwd, and
 * the TURN's `endedAt`. None of those vary per Agent call, so on a turn that
 * dispatched N agents it runs N identical lookups and hands every call the same
 * answer. Each lookup is individually "unambiguous" — exactly one candidate in
 * the ±30s window — while the true mapping is N-to-1.
 *
 * mt#3702 shipped the pipeline rule that follows from this: a multi-spawn turn
 * is refused resolution outright. So EVERY resolved row on a multi-spawn turn is
 * a stale artifact of a heuristic the pipeline no longer trusts — which is the
 * predicate below (`count(*) > 1 AND count(child) > 0`).
 *
 * The original sweep used a narrower predicate, `count(child) > 1 AND
 * count(DISTINCT child) = 1` — "two or more calls resolved to the SAME child."
 * That form has a defect this file exists to fix: clearing one row of a two-row
 * turn drops the turn out of it, so a partial run makes its own remainder
 * invisible. It is not merely narrow, it is blind in the direction of the bug
 * (mem#704: a probe that returns the same result whether or not the system is
 * broken is not verification). Widening it fixes selection and verification at
 * once.
 *
 * The narrow predicate's real content is preserved as an ABORT, not dropped: a
 * turn resolving its siblings to DISTINCT children is what CORRECT per-call
 * resolution looks like, and clearing those would be a regression. None exist
 * today; mt#3962 is what would create them. If one appears, this sweep's premise
 * is void and it refuses to run.
 *
 * ## Why `ctid`, and why one statement
 *
 * `agent_spawns` has no primary key — deliberately: migration 0089 (mt#3708)
 * dropped `(parent_agent_session_id, parent_turn_index)` because it admitted
 * only one row per turn and blocked mt#3692's per-call rows. The intended
 * replacement identity is the unique index on `(parent_agent_session_id,
 * parent_tool_use_id)`, and it is not TOTAL: `parent_tool_use_id` is nullable
 * (290 of 2,862 prod rows on 2026-08-11), and a unique index treats every NULL
 * as distinct.
 *
 * That leaves no column key that names every row, which is what defeated the
 * original sweep: `WHERE parent_tool_use_id = NULL` is never true, so 25 of its
 * 26 remaining targets matched nothing while the loop counted each attempt as a
 * success. The two repairs that suggest themselves are both wrong here —
 * restoring the dropped key re-breaks multi-spawn turns, and `IS NOT DISTINCT
 * FROM` over-matches 4.2x (the 25 NULL-key targets sit in 10 parent sessions
 * holding 109 NULL-key rows between them, all of which it would clear).
 *
 * So the sweep keys on `ctid`, which Postgres documents as the row version's
 * physical location and explicitly warns is not a row identifier — "a row's
 * `ctid` will change if it is updated or moved by `VACUUM FULL`". That warning
 * is about carrying a ctid ACROSS statements. This sweep never does: the
 * selection and the UPDATE are ONE statement under one snapshot, so no
 * intervening write can move a row between reading its ctid and writing it. The
 * durable fix — a row identity that is total — is mt#3992.
 *
 * ## Why a direct UPDATE rather than a re-run of the pipeline
 *
 * mt#3692 (PR #2634 R1) deliberately made resolution MONOTONIC — the upsert sets
 * `child_agent_session_id = COALESCE(EXCLUDED.child_agent_session_id, <stored>)`
 * so a link, once found, survives. That guard is correct for the case it was
 * written for: the heuristic is corpus-dependent, and a genuine link can come
 * back ambiguous on a later sweep once another transcript lands in its window.
 * It is wrong for a link that was NEVER valid, so re-running the pipeline cannot
 * clear these — COALESCE keeps the stored wrong value.
 *
 * Usage:
 *   bun scripts/clear-ambiguous-spawn-links.ts                    # dry-run (default)
 *   bun scripts/clear-ambiguous-spawn-links.ts --limit 1 --execute # bounded apply
 *   bun scripts/clear-ambiguous-spawn-links.ts --execute           # full apply
 *   bun scripts/clear-ambiguous-spawn-links.ts --baseline 26 --execute  # re-run, count re-stated
 *
 * Safety (CLAUDE.md §Operational Safety: Dry-Run First):
 *   - Dry-run by default; `--execute` required to mutate.
 *   - Scope-match check against the count measured when this was written; a
 *     divergence beyond `SCOPE_DIVERGENCE_FACTOR` aborts rather than proceeding.
 *   - `--limit N` bounds an `--execute` run, so the mutating branch can be
 *     exercised on one row before the full population (mt#2776).
 *   - Every cleared row is printed with the child id it held, so the population
 *     the run touched is readable afterwards rather than reconstructed.
 *
 * @see mt#3702 — the refusal rule that stops these being created
 * @see mt#3976 — this file's corrections
 * @see mt#3962 — the per-call child id that would resolve them properly
 * @see mt#3992 — a row identity that is total over the table
 */
import "reflect-metadata";
import { sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { SqlCapablePersistenceProvider } from "@minsky/domain/persistence/types";
import { getLoggableErrorSummary } from "@minsky/domain/errors/index";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Turns measured on prod 2026-08-11T22:25Z carrying a resolved row on a
 * multi-spawn turn — the population this sweep is authorized to clear, and the
 * remainder of the 54 rows / 27 turns ask#7827 approved.
 *
 * Fixed rather than re-derived: a guard that re-measures its own expectation
 * from the query it is guarding cannot detect that the population changed. It
 * goes stale the moment the sweep runs, which is what `--baseline` is for — it
 * makes the operator STATE the re-measured count rather than skip the check.
 */
export const MEASURED_BASELINE_TURNS = 26;

/** Matched-turn divergence from the baseline that aborts instead of proceeding. */
export const SCOPE_DIVERGENCE_FACTOR = 2;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A row the sweep is authorized to clear, as reported by the dry-run. */
export interface SweepTargetRow {
  parent_agent_session_id: string;
  parent_turn_index: number;
  parent_tool_use_id: string | null;
  child_agent_session_id: string;
}

/** A row the sweep actually cleared, carrying the child id it held. */
export interface ClearedRow {
  parent_agent_session_id: string;
  parent_turn_index: number;
  parent_tool_use_id: string | null;
  cleared_child_agent_session_id: string;
}

/** Rows and turns still carrying a resolved link on a multi-spawn turn. */
export interface OutstandingCount {
  rows: number;
  turns: number;
}

export interface SweepOptions {
  execute: boolean;
  limit: number | null;
  baseline: number;
}

export interface SweepOutcome {
  /** Set when the sweep refused to act; every other field is then indicative only. */
  abort: string | null;
  targets: SweepTargetRow[];
  matchedTurns: number;
  /** Null on a dry-run — nothing was attempted, which is not the same as nothing cleared. */
  cleared: ClearedRow[] | null;
  /** Null on a dry-run. */
  outstanding: OutstandingCount | null;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/**
 * Turns whose siblings resolved to DIFFERENT children — correct per-call
 * resolution, which this sweep must never clear. Its presence means the premise
 * has changed under the script (mt#3962), not that there is more work to do.
 */
export async function countDistinctChildTurns(db: PostgresJsDatabase): Promise<number> {
  const rows = await db.execute(sql`
    SELECT count(*)::int AS turns
    FROM (
      SELECT parent_agent_session_id, parent_turn_index
      FROM agent_spawns
      GROUP BY parent_agent_session_id, parent_turn_index
      HAVING count(DISTINCT child_agent_session_id) > 1
    ) q
  `);
  return Array.from(rows as Iterable<{ turns: number }>)[0]?.turns ?? 0;
}

/**
 * The `LIMIT` clause, or nothing at all when the run is unbounded.
 *
 * PR #2878 R1: an earlier shape passed the limit as a bound parameter and relied
 * on `LIMIT NULL` meaning "no limit". That is documented SQL behavior, but it
 * makes the unbounded case — the one that mutates the whole population — depend
 * on a driver faithfully sending an untyped NULL into a clause whose semantics
 * flip on it. Omitting the clause needs no such guarantee from anyone.
 */
function limitClause(limit: number | null) {
  return limit === null ? sql`` : sql`LIMIT ${limit}::bigint`;
}

/** The rows an `--execute` run would clear, in the order it would clear them. */
export async function selectSweepTargets(
  db: PostgresJsDatabase,
  limit: number | null
): Promise<SweepTargetRow[]> {
  const rows = await db.execute(sql`
    WITH multi_spawn_turns AS (
      SELECT parent_agent_session_id, parent_turn_index
      FROM agent_spawns
      GROUP BY parent_agent_session_id, parent_turn_index
      HAVING count(*) > 1
         AND count(child_agent_session_id) > 0
    )
    SELECT s.parent_agent_session_id, s.parent_turn_index,
           s.parent_tool_use_id, s.child_agent_session_id
    FROM agent_spawns s
    JOIN multi_spawn_turns t
      ON t.parent_agent_session_id = s.parent_agent_session_id
     AND t.parent_turn_index = s.parent_turn_index
    WHERE s.child_agent_session_id IS NOT NULL
    ORDER BY s.parent_agent_session_id, s.parent_turn_index,
             s.parent_tool_use_id NULLS LAST
    ${limitClause(limit)}
  `);
  return Array.from(rows as Iterable<SweepTargetRow>);
}

/**
 * Clear the targets and return exactly what was cleared.
 *
 * One statement: the CTE that picks the rows and the UPDATE that writes them run
 * under a single snapshot, so a `ctid` cannot move between being read and being
 * written. `RETURNING` reads from the CTE rather than the updated row, so the
 * child id each row HELD survives into the report — the updated row's own column
 * is NULL by then.
 */
export async function clearSweepTargets(
  db: PostgresJsDatabase,
  limit: number | null
): Promise<ClearedRow[]> {
  const rows = await db.execute(sql`
    WITH multi_spawn_turns AS (
      SELECT parent_agent_session_id, parent_turn_index
      FROM agent_spawns
      GROUP BY parent_agent_session_id, parent_turn_index
      HAVING count(*) > 1
         AND count(child_agent_session_id) > 0
    ),
    targets AS MATERIALIZED (
      SELECT s.ctid AS target_ctid,
             s.parent_agent_session_id, s.parent_turn_index,
             s.parent_tool_use_id, s.child_agent_session_id
      FROM agent_spawns s
      JOIN multi_spawn_turns t
        ON t.parent_agent_session_id = s.parent_agent_session_id
       AND t.parent_turn_index = s.parent_turn_index
      WHERE s.child_agent_session_id IS NOT NULL
      ORDER BY s.parent_agent_session_id, s.parent_turn_index,
               s.parent_tool_use_id NULLS LAST
      ${limitClause(limit)}
    )
    UPDATE agent_spawns s
       SET child_agent_session_id = NULL
      FROM targets t
     WHERE s.ctid = t.target_ctid
    RETURNING t.parent_agent_session_id, t.parent_turn_index, t.parent_tool_use_id,
              t.child_agent_session_id AS cleared_child_agent_session_id
  `);
  return Array.from(rows as Iterable<ClearedRow>);
}

/**
 * What is still outstanding, counted on the SAME predicate the sweep selects on.
 *
 * This is the check the original could not perform: its re-read required two
 * resolved rows per turn, so clearing one of a pair hid the other. Counting rows
 * (not qualifying turns) keeps a stranded sibling visible.
 */
export async function countOutstanding(db: PostgresJsDatabase): Promise<OutstandingCount> {
  const rows = await db.execute(sql`
    WITH multi_spawn_turns AS (
      SELECT parent_agent_session_id, parent_turn_index
      FROM agent_spawns
      GROUP BY parent_agent_session_id, parent_turn_index
      HAVING count(*) > 1
    )
    SELECT count(*)::int AS rows,
           count(DISTINCT (s.parent_agent_session_id, s.parent_turn_index))::int AS turns
    FROM agent_spawns s
    JOIN multi_spawn_turns t
      ON t.parent_agent_session_id = s.parent_agent_session_id
     AND t.parent_turn_index = s.parent_turn_index
    WHERE s.child_agent_session_id IS NOT NULL
  `);
  const row = Array.from(rows as Iterable<OutstandingCount>)[0];
  return { rows: row?.rows ?? 0, turns: row?.turns ?? 0 };
}

// ---------------------------------------------------------------------------
// Sweep (no printing, no exiting — see `main` for the shell)
// ---------------------------------------------------------------------------

export async function runSweep(
  db: PostgresJsDatabase,
  options: SweepOptions
): Promise<SweepOutcome> {
  const distinctChildTurns = await countDistinctChildTurns(db);
  if (distinctChildTurns > 0) {
    return {
      abort:
        `${distinctChildTurns} turn(s) resolve siblings to DISTINCT children. That is what correct ` +
        `per-call resolution looks like (mt#3962), so this sweep's premise no longer holds and it ` +
        `must not clear anything. Re-derive the population before running again.`,
      targets: [],
      matchedTurns: 0,
      cleared: null,
      outstanding: null,
    };
  }

  const targets = await selectSweepTargets(db, options.execute ? options.limit : null);
  const matchedTurns = groupByTurn(targets).size;

  // Scope-match check (CLAUDE.md §Dry-run scope-match check). Approval of an
  // operation at one magnitude is not approval at 9x. Counted against the
  // UNBOUNDED population, so a `--limit` run cannot slip past a divergence by
  // matching only the first N rows of a population that grew tenfold.
  const bounded = options.execute && options.limit !== null;
  const population = bounded ? groupByTurn(await selectSweepTargets(db, null)).size : matchedTurns;
  if (population > options.baseline * SCOPE_DIVERGENCE_FACTOR) {
    return {
      abort:
        `matched ${population} turns against a baseline of ${options.baseline} — a divergence ` +
        `beyond ${SCOPE_DIVERGENCE_FACTOR}x. Re-measure and pass --baseline N to confirm.`,
      targets,
      matchedTurns,
      cleared: null,
      outstanding: null,
    };
  }

  if (!options.execute) {
    return { abort: null, targets, matchedTurns, cleared: null, outstanding: null };
  }

  const cleared = await clearSweepTargets(db, options.limit);
  const outstanding = await countOutstanding(db);
  return { abort: null, targets, matchedTurns, cleared, outstanding };
}

/**
 * The exit code the outcome implies.
 *
 * Zero rows cleared against a non-empty target set is the failure the original
 * could not report: it means the UPDATE matched nothing, which is exactly what
 * a NULL-keyed predicate did silently.
 */
export function exitCodeFor(outcome: SweepOutcome, options: SweepOptions): number {
  if (outcome.abort) return 1;
  if (!options.execute) return 0;
  const cleared = outcome.cleared ?? [];
  if (outcome.targets.length > 0 && cleared.length === 0) return 1;
  if (cleared.length < outcome.targets.length) return 1;
  if (options.limit === null && (outcome.outstanding?.rows ?? 0) > 0) return 1;
  return 0;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse an integer-valued flag. Throws rather than silently ignoring a malformed
 * value: a typo'd `--limit` that quietly became "no limit" would turn a run
 * intended to be bounded into a full-population mutation.
 */
export function parseIntFlag(argv: string[], flag: string, minimum: number): number | null {
  const index = argv.indexOf(flag);
  if (index === -1) return null;
  const raw = argv[index + 1];
  const parsed = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(parsed) || parsed < minimum) {
    throw new Error(`${flag} expects an integer >= ${minimum}, got: ${raw ?? "(missing)"}`);
  }
  return parsed;
}

/** Group rows by their turn, for reporting in the unit the measurement used. */
export function groupByTurn<
  T extends { parent_agent_session_id: string; parent_turn_index: number },
>(rows: T[]): Map<string, T[]> {
  const byTurn = new Map<string, T[]>();
  for (const row of rows) {
    const key = `${row.parent_agent_session_id}:${row.parent_turn_index}`;
    const existing = byTurn.get(key);
    if (existing) existing.push(row);
    else byTurn.set(key, [row]);
  }
  return byTurn;
}

// ---------------------------------------------------------------------------
// DB
// ---------------------------------------------------------------------------

async function getDb(): Promise<PostgresJsDatabase> {
  const { initializeConfiguration, CustomConfigFactory } = await import(
    "@minsky/domain/configuration"
  );
  const { createCliContainer } = await import("../src/composition/cli");
  const { PersistenceProvider } = await import("@minsky/domain/persistence/types");

  await initializeConfiguration(new CustomConfigFactory(), {
    workingDirectory: process.cwd(),
  });

  const container = await createCliContainer();
  await container.initialize();

  const persistence = container.has("persistence") ? container.get("persistence") : undefined;
  if (!persistence || !(persistence instanceof PersistenceProvider)) {
    throw new Error("This sweep requires a SQL-capable persistence provider (Postgres).");
  }
  if (!persistence.capabilities.sql || typeof persistence.getDatabaseConnection !== "function") {
    throw new Error("This sweep requires a SQL-capable persistence provider (Postgres).");
  }
  const sqlProvider = persistence as SqlCapablePersistenceProvider;
  const connection = await sqlProvider.getDatabaseConnection();
  if (!connection) {
    throw new Error("This sweep requires an initialized Postgres database connection.");
  }
  return connection as PostgresJsDatabase;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function describeRow(row: SweepTargetRow | ClearedRow): string {
  const child =
    "child_agent_session_id" in row
      ? row.child_agent_session_id
      : row.cleared_child_agent_session_id;
  return (
    `  ${row.parent_agent_session_id}:${row.parent_turn_index} ` +
    `tool_use_id=${row.parent_tool_use_id ?? "(null)"} -> ${child}`
  );
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const options: SweepOptions = {
    execute: argv.includes("--execute"),
    limit: parseIntFlag(argv, "--limit", 1),
    baseline: parseIntFlag(argv, "--baseline", 0) ?? MEASURED_BASELINE_TURNS,
  };

  let db: PostgresJsDatabase;
  try {
    db = await getDb();
  } catch (err) {
    // Exits NON-ZERO (PR #2878 R1). The previous shape exited 0 with a "SKIP"
    // notice, which is this file's own defect one layer up: a run that never
    // reached the database reported success, indistinguishable from a run that
    // reached it and found nothing to do. Nothing in CI or package.json invokes
    // this script — verified — so there is no suite depending on the soft exit,
    // and an operator running a corrective sweep needs a connection failure to
    // be loud.
    console.error(
      "FAILED: could not initialize the DB connection — no rows were examined or changed."
    );
    console.error(getLoggableErrorSummary(err));
    process.exit(1);
  }

  const outcome = await runSweep(db, options);

  if (outcome.abort) {
    console.error(`ABORT: ${outcome.abort}`);
    process.exit(exitCodeFor(outcome, options));
  }

  console.log(
    `Never-valid spawn links: ${outcome.targets.length} rows across ${outcome.matchedTurns} turns.`
  );
  for (const row of outcome.targets.slice(0, 10)) console.log(describeRow(row));
  if (outcome.targets.length > 10) {
    console.log(`  … and ${outcome.targets.length - 10} more rows`);
  }

  if (!options.execute) {
    console.log("\nDry-run (default). Re-run with --execute to clear these links.");
    console.log("Each cleared row returns to NULL, which renders as an ordinary static badge.");
    process.exit(exitCodeFor(outcome, options));
  }

  const cleared = outcome.cleared ?? [];
  console.log(`\nCleared ${cleared.length} of ${outcome.targets.length} targeted row(s):`);
  for (const row of cleared) console.log(describeRow(row));

  if (cleared.length < outcome.targets.length) {
    console.error(
      `FAILED: ${outcome.targets.length - cleared.length} targeted row(s) were not cleared. ` +
        `The UPDATE matched fewer rows than were selected — investigate before re-running.`
    );
  }

  const outstanding = outcome.outstanding;
  console.log(
    `Resolved rows still on multi-spawn turns: ${outstanding?.rows ?? 0} ` +
      `across ${outstanding?.turns ?? 0} turns.`
  );
  if (options.limit === null && (outstanding?.rows ?? 0) > 0) {
    console.error("WARNING: rows remain after an unbounded run — investigate before re-running.");
  }

  process.exit(exitCodeFor(outcome, options));
}

if (import.meta.main) {
  void main();
}
