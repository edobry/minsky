#!/usr/bin/env bun
/**
 * One-time corrective sweep (mt#3702): clear `agent_spawns.child_agent_session_id`
 * on rows whose link was never valid — two or more Agent calls in ONE turn all
 * pointing at the SAME child.
 *
 * ## Why these links are wrong, not merely uncertain
 *
 * The cwd-time-window heuristic takes the parent session, the parent cwd, and the
 * TURN's `endedAt`. None of those vary per Agent call, so on a turn that
 * dispatched N agents it runs N identical lookups and hands every call the same
 * answer. Each lookup is individually "unambiguous" — exactly one candidate in
 * the ±30s window — while the true mapping is N-to-1. A turn cannot have
 * dispatched two agents into one child conversation, so at least one of those
 * links is false, and the cockpit renders it exactly like a true one.
 *
 * Measured on prod 2026-08-11: 159 multi-spawn turns, of which 27 resolve 2+
 * siblings to one child and **0 have ever resolved to distinct children.**
 *
 * The pipeline change in the same task stops CREATING these. This script is the
 * backward sweep over rows already written.
 *
 * ## Why a direct UPDATE rather than a re-run of the pipeline
 *
 * mt#3692 (PR #2634 R1) deliberately made resolution MONOTONIC — the upsert sets
 * `child_agent_session_id = COALESCE(EXCLUDED.child_agent_session_id, <stored>)`
 * so a link, once found, survives. That guard is correct for the case it was
 * written for: the heuristic is corpus-dependent, and a genuine link can come
 * back ambiguous on a later sweep once another transcript lands in its window.
 * Erasing a good link there would be a real regression.
 *
 * It is wrong for a link that was NEVER valid, and its own comment records the
 * assumption this task falsifies ("mt#3702 only ever adds to it"). So re-running
 * the pipeline cannot clear these — COALESCE keeps the stored wrong value — and
 * the correction is a deliberate, bounded UPDATE over exactly the rows the
 * never-valid predicate identifies. The upsert's monotonicity is left intact.
 *
 * Usage:
 *   bun scripts/clear-ambiguous-spawn-links.ts                    # dry-run (default)
 *   bun scripts/clear-ambiguous-spawn-links.ts --limit 1 --execute # bounded apply
 *   bun scripts/clear-ambiguous-spawn-links.ts --execute           # full apply
 *   bun scripts/clear-ambiguous-spawn-links.ts --baseline 27 --execute  # re-run, count re-stated
 *
 * Safety (CLAUDE.md §Operational Safety: Dry-Run First):
 *   - Dry-run by default; `--execute` required to mutate.
 *   - Scope-match check against the count measured when this was written; a
 *     divergence beyond `SCOPE_DIVERGENCE_FACTOR` aborts rather than proceeding.
 *   - `--limit N` bounds an `--execute` run, so the mutating branch can be
 *     exercised on one row before the full population (mt#2776: running only the
 *     dry-run never executes the `--execute` branch's code at all).
 *
 * @see mt#3702 — the refusal rule that stops these being created
 * @see mt#3962 — the per-call child id that would resolve them properly
 */
import "reflect-metadata";
import { sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { SqlCapablePersistenceProvider } from "@minsky/domain/persistence/types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Turns measured on prod 2026-08-11 with 2+ Agent calls resolving to ONE child.
 *
 * Fixed rather than re-derived: a guard that re-measures its own expectation
 * from the query it is guarding cannot detect that the population changed. It
 * goes stale the moment the sweep runs, which is what `--baseline` is for — it
 * makes the operator STATE the re-measured count rather than skip the check.
 */
export const MEASURED_BASELINE_TURNS = 27;

/** Matched-turn divergence from the baseline that aborts instead of proceeding. */
export const SCOPE_DIVERGENCE_FACTOR = 2;

// ---------------------------------------------------------------------------
// Predicate
// ---------------------------------------------------------------------------

/**
 * A row this sweep is authorized to clear.
 *
 * The predicate is deliberately narrow: the turn must have MORE THAN ONE resolved
 * row AND all of them must share ONE child. A turn resolving siblings to distinct
 * children is exactly what correct resolution looks like and must never match —
 * there are none today, but the predicate has to stay right after mt#3962 lands.
 */
export interface AmbiguousSpawnRow {
  parent_agent_session_id: string;
  parent_turn_index: number;
  parent_tool_use_id: string;
  child_agent_session_id: string;
}

/**
 * Select the never-valid rows.
 *
 * `count(DISTINCT child) = 1 AND count(child) > 1` is the whole test: several
 * calls in one turn, all resolved, all to the same conversation.
 */
async function selectAmbiguousRows(db: PostgresJsDatabase): Promise<AmbiguousSpawnRow[]> {
  const rows = await db.execute(sql`
    WITH ambiguous_turns AS (
      SELECT parent_agent_session_id, parent_turn_index
      FROM agent_spawns
      GROUP BY parent_agent_session_id, parent_turn_index
      HAVING count(child_agent_session_id) > 1
         AND count(DISTINCT child_agent_session_id) = 1
    )
    SELECT s.parent_agent_session_id, s.parent_turn_index,
           s.parent_tool_use_id, s.child_agent_session_id
    FROM agent_spawns s
    JOIN ambiguous_turns t
      ON t.parent_agent_session_id = s.parent_agent_session_id
     AND t.parent_turn_index = s.parent_turn_index
    WHERE s.child_agent_session_id IS NOT NULL
    ORDER BY s.parent_agent_session_id, s.parent_turn_index, s.parent_tool_use_id
  `);
  // The driver returns untyped row records; the SELECT list above IS the shape
  // contract, so one narrowing here beats threading `Record<string, unknown>`
  // through every consumer.
  return Array.from(rows as Iterable<AmbiguousSpawnRow>);
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
export function groupByTurn(rows: AmbiguousSpawnRow[]): Map<string, AmbiguousSpawnRow[]> {
  const byTurn = new Map<string, AmbiguousSpawnRow[]>();
  for (const row of rows) {
    const key = `${row.parent_agent_session_id}:${row.parent_turn_index}`;
    const existing = byTurn.get(key);
    if (existing) existing.push(row);
    else byTurn.set(key, [row]);
  }
  return byTurn;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const execute = argv.includes("--execute");
  const limit = parseIntFlag(argv, "--limit", 1);
  const baseline = parseIntFlag(argv, "--baseline", 0) ?? MEASURED_BASELINE_TURNS;

  let db: PostgresJsDatabase;
  try {
    db = await getDb();
  } catch (err) {
    console.error(
      "SKIP: failed to initialize DB connection — Postgres not available in this environment."
    );
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(0);
  }

  const rows = await selectAmbiguousRows(db);
  const byTurn = groupByTurn(rows);

  console.log(`Never-valid spawn links: ${rows.length} rows across ${byTurn.size} turns.`);
  for (const [turnKey, turnRows] of [...byTurn].slice(0, 10)) {
    const child = turnRows[0]?.child_agent_session_id ?? "(none)";
    console.log(`  ${turnKey}: ${turnRows.length} calls -> ${child}`);
  }
  if (byTurn.size > 10) console.log(`  … and ${byTurn.size - 10} more turns`);

  // Scope-match check (CLAUDE.md §Dry-run scope-match check). Approval of an
  // operation at one magnitude is not approval at 9x.
  if (byTurn.size > baseline * SCOPE_DIVERGENCE_FACTOR) {
    console.error(
      `ABORT: matched ${byTurn.size} turns against a baseline of ${baseline} — ` +
        `a divergence beyond ${SCOPE_DIVERGENCE_FACTOR}x. Re-measure and pass --baseline N to confirm.`
    );
    process.exit(1);
  }

  if (!execute) {
    console.log("\nDry-run (default). Re-run with --execute to clear these links.");
    console.log("Each cleared row returns to NULL, which renders as an ordinary static badge.");
    process.exit(0);
  }

  const targets = limit === null ? rows : rows.slice(0, limit);
  console.log(`\nClearing ${targets.length} row(s)…`);

  let cleared = 0;
  for (const row of targets) {
    // The predicate is EXACTLY the table's unique key — the upsert's conflict
    // target is `[parentAgentSessionId, parentToolUseId]`
    // (agent-spawns-pipeline.ts), so these two columns identify one row and
    // cannot over-match.
    //
    // `parent_turn_index` is deliberately NOT in the predicate (PR #2842 R1
    // suggested adding it). It is not part of the key, and the same upsert
    // REFRESHES it — "re-extraction can move a spawn to a different index, and
    // the row should follow it". So a concurrent re-extraction between the
    // SELECT above and this UPDATE would move the index and the extra clause
    // would match zero rows, silently clearing nothing. Narrowing on a mutable
    // non-key column would make this less safe, not more.
    const result = await db.execute(sql`
      UPDATE agent_spawns
      SET child_agent_session_id = NULL
      WHERE parent_agent_session_id = ${row.parent_agent_session_id}
        AND parent_tool_use_id = ${row.parent_tool_use_id}
    `);
    // Row count is driver-shaped; treat a completed statement as one cleared row
    // and re-read below rather than trusting this number.
    void result;
    cleared += 1;
  }

  // Verify the OUTCOME, not the action (CLAUDE.md §Error Investigation): re-run
  // the same predicate and report what is actually left.
  const remaining = groupByTurn(await selectAmbiguousRows(db));
  console.log(`Cleared ${cleared} row(s). Turns still matching the predicate: ${remaining.size}.`);
  if (limit === null && remaining.size > 0) {
    console.error("WARNING: rows remain after an unbounded run — investigate before re-running.");
    process.exit(1);
  }
  process.exit(0);
}

if (import.meta.main) {
  void main();
}
