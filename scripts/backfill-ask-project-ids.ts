#!/usr/bin/env bun
/**
 * One-time backfill (mt#4839): stamp `project_id` on the open Asks that carry NULL and whose
 * parent task carries a project.
 *
 * mt#4772 made `asks.create` resolve a new Ask's project from its parent task, and mt#4848 moved
 * that resolution down to `DrizzleAskRepository.create` so every writer gets it. Both are
 * write-path fixes — neither touches the rows already written. This is the backward half.
 *
 * A NULL-project Ask is counted by the unscoped All-projects total and by neither project's
 * filter, so it produces a visible arithmetic gap on the cross-project surfaces mt#4794/mt#4795
 * shipped. Only OPEN asks are in scope: nothing renders the terminal ones, so re-stamping them
 * is churn against the largest population in the table for no observable gain.
 *
 * Usage:
 *   bun scripts/backfill-ask-project-ids.ts                       # dry-run (default)
 *   bun scripts/backfill-ask-project-ids.ts --limit 1 --execute   # bounded apply
 *   bun scripts/backfill-ask-project-ids.ts --execute             # full apply
 *   bun scripts/backfill-ask-project-ids.ts --baseline 7 --execute  # re-run, re-stated scope
 *
 * Safety (CLAUDE.md §Operational Safety: Dry-Run First) — mirrors the mt#3894 sibling
 * `backfill-subagent-invocation-no-workspace.ts`:
 *   - Dry-run by default; `--execute` required to mutate.
 *   - Scope-match check against a recorded baseline; a divergence aborts rather than proceeds.
 *   - `--limit N` bounds an `--execute` run so the mutating branch is exercisable pre-merge
 *     without the full blast radius (mt#2776).
 *   - The eligibility predicate is re-asserted on the UPDATE's own WHERE, not trusted from the
 *     SELECT's id list — an ask closing, or a peer stamping it, in between must not be clobbered.
 *   - The value written comes from the JOINED task row inside the same statement, never from a
 *     project id the SELECT read earlier: a reparent between the two would otherwise stamp the
 *     old project.
 *   - Idempotent: a re-run matches 0 rows, because stamped rows no longer satisfy `IS NULL`.
 *   - Single-writer via a TRANSACTION-scoped advisory lock — see `withBackfillLock` below.
 *
 * @see mt#4839 — this task
 * @see mt#4772 / mt#4848 — the write-path fixes this completes
 * @see mt#3009 — the sibling ask backfill whose missing lock prompted this one's
 * @see mem#655 — why the lock here is xact-scoped, not session-scoped
 */

// tsyringe (used by createCliContainer's DI container below) requires this polyfill — without it
// the documented `bun scripts/...` invocation throws "tsyringe requires a reflect polyfill"
// (mt#2768).
import "reflect-metadata";
import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { SqlCapablePersistenceProvider } from "@minsky/domain/persistence/types";
import { ASK_STATE_VALUES } from "@minsky/domain/storage/schemas/ask-schema";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * States that put an Ask beyond any rendered surface. `packages/domain/src/ask/types.ts` names
 * exactly these three as terminal ("Terminal states: closed, cancelled, expired").
 *
 * **This is a deliberate divergence from mt#4839's `## Acceptance Tests`,** whose queries say
 * `state not in ('closed','cancelled')` and so treat `expired` as open. The domain type is the
 * authority on its own lifecycle, and an expired Ask — a deadline passed with no response — is
 * as unrendered as a closed one, which is the whole basis for excluding terminal rows.
 *
 * The divergence started out vacuous and stopped being so during the session that wrote this,
 * which is the argument for it. At 17:56Z both predicates selected the same 10 rows — every open
 * NULL-project Ask was `suspended` or `responded`. At 18:10:40Z **ask#10468 expired**, and the
 * 18:16Z dry-run returned 9. Under the spec's predicate that row is still a target and would be
 * stamped; under this one it correctly drops out. A terminal row gaining a project stamp is
 * exactly the churn `## Scope` puts OUT of scope, so the spec's own reasoning argues against the
 * spec's own query. Recorded on the spec.
 */
export const TERMINAL_ASK_STATES = ["closed", "cancelled", "expired"] as const;

/** The states this sweep is willing to touch: every non-terminal one. */
export const TARGET_ASK_STATES = ASK_STATE_VALUES.filter(
  (state) => !(TERMINAL_ASK_STATES as readonly string[]).includes(state)
);

/**
 * Backfillable rows counted against prod on 2026-09-02T17:56Z, recorded in mt#4839's spec.
 *
 * Fixed rather than re-derived: a guard that re-measures its own expectation from the query it
 * is guarding cannot detect that the population changed. `--baseline N` is the path for a
 * deliberate re-run — it makes the operator STATE the re-measured count.
 *
 * The count has drifted DOWNWARD twice already (14 at filing → 13 at plan time → 10 here) as
 * open asks reach a terminal state, which is why the scope check below is two-sided.
 */
export const MEASURED_BASELINE = 10;

/** Matched-count divergence from the baseline that aborts instead of proceeding. */
export const SCOPE_DIVERGENCE_FACTOR = 2;

/**
 * Advisory-lock namespace for this sweep, paired with `hashtext(<lock name>)` via the two-key
 * `pg_try_advisory_xact_lock(int, int)` overload — the convention
 * `DRIVEN_SESSION_RESUME_LOCK_NAMESPACE` and `SUPERVISION_TICK_LOCK_NAMESPACE` already follow.
 */
export const BACKFILL_ASK_PROJECT_LOCK_NAMESPACE = 4_839_001;

/** Stable second lock key; hashed in SQL so no JS-side string hashing is needed. */
export const BACKFILL_ASK_PROJECT_LOCK_NAME = "backfill-ask-project-ids";

// ---------------------------------------------------------------------------
// Guards (pure — unit-tested)
// ---------------------------------------------------------------------------

export interface ScopeMatchVerdict {
  ok: boolean;
  message: string;
}

/**
 * Compare the matched row count against the recorded baseline. Approval of an operation at one
 * magnitude is not approval at N times that magnitude, so a run finding far more (or far fewer)
 * rows than the spec recorded stops for re-confirmation. A count of 0 is the idempotent re-run
 * case, not a divergence.
 */
export function checkScopeMatch(
  matched: number,
  baseline: number = MEASURED_BASELINE,
  factor: number = SCOPE_DIVERGENCE_FACTOR
): ScopeMatchVerdict {
  if (matched === 0) {
    return { ok: true, message: "0 rows matched — already applied, or nothing to do." };
  }
  const upper = baseline * factor;
  const lower = baseline / factor;
  if (matched > upper || matched < lower) {
    return {
      ok: false,
      message:
        `STOP: matched ${matched} rows, but the recorded baseline is ${baseline} ` +
        `(allowed ${Math.ceil(lower)}..${Math.floor(upper)} at ${factor}x). ` +
        `Re-measure and re-confirm the scope before running --execute.`,
    };
  }
  return {
    ok: true,
    message: `matched ${matched} rows, within ${factor}x of baseline ${baseline}.`,
  };
}

/**
 * Parse an integer-valued flag. Throws rather than silently ignoring a malformed value: a typo'd
 * `--limit` that quietly became "no limit" would turn a bounded run into a full-population one.
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

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------

/**
 * The only capability this script's SQL functions need from a connection: run a statement.
 *
 * Narrowing to this rather than taking `PostgresJsDatabase` is what lets `withBackfillLock` hand
 * its callback the drizzle TRANSACTION object directly — a transaction is not a
 * `PostgresJsDatabase`, and casting one to the other would have been a lie that also defeats the
 * whole point of the lock (the mutation must run on the locked transaction, not the pool).
 */
export interface SqlExecutor {
  execute(query: SQL): unknown;
}

export interface BackfillCandidateRow {
  id: string;
  shortId: string | null;
  state: string;
  parentTaskId: string;
  parentProjectId: string;
}

/**
 * The eligibility predicate, as a SQL fragment shared by the SELECT and the UPDATE so the two
 * cannot drift apart. Aliases are fixed as `a` (asks) and `t` (tasks).
 *
 * Four clauses, each load-bearing:
 *   a.project_id IS NULL       -- only rows that were never stamped; also what makes this
 *                                 idempotent, and what guarantees SC3 (no already-stamped row,
 *                                 including the 2 known mismatched ones, is touched)
 *   t.project_id IS NOT NULL   -- the parent must have an answer to inherit (SC2)
 *   t.id = a.parent_task_id    -- an inner join: an ask with no parent, or with a dangling
 *                                 parent_task_id, matches nothing (SC2)
 *   a.state NOT IN (terminal)  -- open asks only; see TERMINAL_ASK_STATES
 */
function eligibilityPredicate() {
  const terminal = sql.join(
    TERMINAL_ASK_STATES.map((state) => sql`${state}`),
    sql`, `
  );
  return sql`t.id = a.parent_task_id
      AND a.project_id IS NULL
      AND t.project_id IS NOT NULL
      AND a.state NOT IN (${terminal})`;
}

/** Enumerate the rows this sweep would touch, newest-last for a stable, readable dry-run. */
export async function selectCandidates(db: SqlExecutor): Promise<BackfillCandidateRow[]> {
  const rows = await db.execute(sql`
    SELECT a.id            AS id,
           a.short_id      AS short_id,
           a.state         AS state,
           a.parent_task_id AS parent_task_id,
           t.project_id    AS parent_project_id
    FROM asks a
    JOIN tasks t ON ${eligibilityPredicate()}
    ORDER BY a.created_at ASC
  `);
  return Array.from(rows as Iterable<Record<string, unknown>>).map((row) => ({
    id: String(row["id"]),
    shortId: row["short_id"] === null ? null : String(row["short_id"]),
    state: String(row["state"]),
    parentTaskId: String(row["parent_task_id"]),
    parentProjectId: String(row["parent_project_id"]),
  }));
}

export interface AppliedRow {
  id: string;
  shortId: string | null;
  projectId: string;
}

/**
 * Run `fn` while holding a TRANSACTION-SCOPED advisory lock.
 *
 * Transaction-scoped, NOT session-scoped, and this is the one place this script departs from the
 * precedent mt#4839's spec names. That spec points at `scripts/backfill-memory-short-ids.ts`,
 * which guards with `pg_try_advisory_lock` / `pg_advisory_unlock` — a SESSION-level pair. mem#655
 * measured, live against this deployment during mt#1418, that session-level advisory locks LEAK
 * through Minsky's Supavisor TRANSACTION pooler: the pooler swaps the real backend per statement
 * (`pg_backend_pid()` returned different pids on consecutive statements of one reserved
 * connection), so the unlock runs on a different backend, returns false, and the key stays held
 * until that backend is recycled. A guard that can silently wedge every future run is worse than
 * none.
 *
 * `pg_try_advisory_xact_lock` is released by the transaction ending, regardless of which backend
 * served which statement, so it is correct through the pooler. The in-repo precedent is
 * `withDrivenSessionResumeLock` (`packages/domain/src/transcripts/driven-session-registry-store.ts`)
 * and `supervision-store.ts`, both of which already made this exact choice for this exact reason.
 *
 * The whole mutation is one statement, so a transaction-scoped lock covers all of it — the
 * "unsuitable for a minutes-long sweep" caveat in mem#655 does not bite here.
 */
export async function withBackfillLock<T>(
  db: PostgresJsDatabase,
  fn: (tx: SqlExecutor) => Promise<T>
): Promise<{ acquired: true; result: T } | { acquired: false }> {
  return db.transaction(async (tx) => {
    const lockRows = await tx.execute(
      sql`SELECT pg_try_advisory_xact_lock(${BACKFILL_ASK_PROJECT_LOCK_NAMESPACE}, hashtext(${BACKFILL_ASK_PROJECT_LOCK_NAME})) AS acquired`
    );
    const row = Array.from(lockRows as Iterable<Record<string, unknown>>)[0];
    if (row?.["acquired"] !== true) {
      return { acquired: false };
    }
    return { acquired: true, result: await fn(tx) };
  });
}

/**
 * One bulk UPDATE, not a per-row loop (mem#758 / `efficient-database-queries`).
 *
 * The WHERE re-asserts the full eligibility predicate alongside the id list rather than trusting
 * the SELECT: between the two, an ask can close, or a peer writer can stamp it, and an id-only
 * UPDATE would clobber that. `SET project_id = t.project_id` reads the value from the joined row
 * *in this statement*, so a task reparented in the same window stamps the new project or, if the
 * new parent has none, drops out of the predicate entirely.
 */
export async function applyBackfill(tx: SqlExecutor, ids: string[]): Promise<AppliedRow[]> {
  if (ids.length === 0) return [];
  const idList = sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `
  );
  const rows = await tx.execute(sql`
    UPDATE asks a
    SET project_id = t.project_id
    FROM tasks t
    WHERE ${eligibilityPredicate()}
      AND a.id IN (${idList})
    RETURNING a.id AS id, a.short_id AS short_id, a.project_id AS project_id
  `);
  return Array.from(rows as Iterable<Record<string, unknown>>).map((row) => ({
    id: String(row["id"]),
    shortId: row["short_id"] === null ? null : String(row["short_id"]),
    projectId: String(row["project_id"]),
  }));
}

// ---------------------------------------------------------------------------
// DB access
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
    throw new Error("Backfill requires a SQL-capable persistence provider (Postgres).");
  }
  if (!persistence.capabilities.sql || typeof persistence.getDatabaseConnection !== "function") {
    throw new Error("Backfill requires a SQL-capable persistence provider (Postgres).");
  }
  const sqlProvider = persistence as SqlCapablePersistenceProvider;
  const connection = await sqlProvider.getDatabaseConnection();
  if (!connection) {
    throw new Error("Backfill requires an initialized Postgres database connection.");
  }

  return connection as PostgresJsDatabase;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const execute = argv.includes("--execute");
  const limit = parseIntFlag(argv, "--limit", 1);
  const baseline = parseIntFlag(argv, "--baseline", 0) ?? MEASURED_BASELINE;

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

  const target = await selectCandidates(db);

  console.log(
    `backfill-ask-project-ids ${execute ? "(EXECUTE)" : "(dry-run)"}` +
      `${limit === null ? "" : ` --limit ${limit}`}`
  );
  console.log(`  open NULL-project asks whose parent carries a project: ${target.length}`);
  for (const row of target) {
    console.log(
      `      ${row.shortId ?? row.id} state=${row.state} parent=${row.parentTaskId} ` +
        `-> project ${row.parentProjectId}`
    );
  }

  const scope = checkScopeMatch(target.length, baseline);
  console.log(`  scope-match: ${scope.message}`);
  if (!scope.ok) {
    console.log(JSON.stringify({ mode: execute ? "execute" : "dry-run", aborted: "scope-match" }));
    process.exit(1);
  }

  const selected = limit === null ? target : target.slice(0, limit);
  let updated = 0;

  if (execute && selected.length > 0) {
    const outcome = await withBackfillLock(db, (tx) =>
      applyBackfill(
        tx,
        selected.map((row) => row.id)
      )
    );

    if (!outcome.acquired) {
      console.error(
        "ABORT: another process holds the backfill lock — it is already running. Not proceeding."
      );
      console.log(
        JSON.stringify({ mode: "execute", aborted: "lock-not-acquired", target: target.length })
      );
      process.exit(1);
    }

    const appliedIds = new Set(outcome.result.map((row) => row.id));
    updated = outcome.result.length;
    console.log(`  updated=${updated} of ${selected.length} selected`);
    for (const row of outcome.result) {
      console.log(`      ${row.shortId ?? row.id} -> project ${row.projectId}`);
    }

    if (updated < selected.length) {
      const skipped = selected.filter((row) => !appliedIds.has(row.id));
      console.log(
        `  NOTE: ${selected.length - updated} row(s) were skipped by the UPDATE's eligibility ` +
          `predicate — they stopped matching between the SELECT and the UPDATE. NOT modified:`
      );
      for (const row of skipped) console.log(`      ${row.shortId ?? row.id}`);
    }
  } else if (execute) {
    console.log("  nothing to update.");
  } else {
    console.log(
      `  (dry-run — re-run with --execute to stamp ${selected.length} ask(s) from their parents)`
    );
  }

  console.log(
    JSON.stringify({
      mode: execute ? "execute" : "dry-run",
      limit,
      target: target.length,
      selected: selected.length,
      updated,
      baseline,
    })
  );

  process.exit(0);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(
      `backfill-ask-project-ids failed: ${err instanceof Error ? err.message : String(err)}`
    );
    process.exit(1);
  });
}
