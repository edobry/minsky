#!/usr/bin/env bun
/**
 * One-time backfill (mt#3173): retire the false `crashed-no-output` verdict on
 * historical `subagent_invocations` rows by setting them to `pending`.
 *
 * Before mt#1770, `tasks.dispatch` seeded every new invocation row with
 * `outcome = 'crashed-no-output'` at DISPATCH time — a pessimistic default. Any
 * dispatch whose SubagentStop never landed kept that value forever, so the row
 * asserts a crash nobody observed. mt#1770 fixed this forward (new rows seed
 * `pending`); this script is the backward sweep over the rows created before it.
 *
 * Governing decision: ask#6801 (closed 2026-08-03) — "Set them to pending, leave
 * ended_at NULL. Removes the false verdict, invents no timestamp, no migration
 * needed." Only `outcome` is written; `ended_at` stays NULL, and every other
 * column is untouched.
 *
 * ## Why the predicate carries a cutover bound
 *
 * `tasks.dispatch-recover` deliberately writes a real, live-probed
 * `crashed-no-output` classification onto a STILL-OPEN row at its 2-attempt-bound
 * escalation path, omitting `endedAt` on purpose so the eventual SubagentStop can
 * still close it (`src/adapters/shared/commands/tasks/dispatch-recover-command.ts`,
 * the mt#3149 block — "row left open (not ended) pending the eventual
 * SubagentStop"). Such a row matches `outcome='crashed-no-output' AND ended_at IS
 * NULL` and must NOT be flipped: doing so would erase a genuine classification.
 *
 * The mt#1770 cutover separates the two populations. Rows matching the first two
 * clauses but started ON OR AFTER the cutover are REPORTED for manual triage and
 * never mutated.
 *
 * Usage:
 *   bun scripts/backfill-subagent-invocation-false-crashes.ts              # dry-run (default)
 *   bun scripts/backfill-subagent-invocation-false-crashes.ts --limit 1 --execute   # bounded apply
 *   bun scripts/backfill-subagent-invocation-false-crashes.ts --execute    # full apply
 *   bun scripts/backfill-subagent-invocation-false-crashes.ts --baseline 3 --execute  # re-run, count re-stated
 *
 * Safety (CLAUDE.md §Operational Safety: Dry-Run First):
 *   - Dry-run by default; `--execute` required to mutate.
 *   - Scope-match check: the matched count is compared against the baseline
 *     measured when this script was written. A divergence beyond
 *     `SCOPE_DIVERGENCE_FACTOR` aborts rather than proceeding, per the
 *     dry-run scope-match rule (a 9x divergence once shipped 136 unintended
 *     writes — mem#622). `--baseline N` re-confirms the check against a
 *     re-measured count instead of skipping it; there is no way to disable it.
 *   - `--limit N` bounds an `--execute` run to the first N target rows, so the
 *     mutating branch can be exercised pre-merge without the full blast radius
 *     (mt#2776 — the sibling `backfill-close-stale-asks.ts` shipped a broken
 *     `--execute` branch precisely because only the dry-run was ever run).
 *   - Idempotent: a re-run matches 0 rows, because the flipped rows no longer
 *     carry `crashed-no-output`.
 *
 * Output: human-readable summary + a JSON result block on stdout.
 *
 * @see mt#3173 — this task
 * @see ask#6801 — the governing decision
 * @see mt#1770 — the forward fix (`pending` seeded at dispatch)
 * @see mt#3062 — the watchdog age-bound that removed this backlog's flag risk
 */

// tsyringe (used by createCliContainer's DI container below) requires this
// polyfill — without it the documented `bun scripts/...` invocation throws
// "tsyringe requires a reflect polyfill" (mt#2768).
import "reflect-metadata";
import { and, eq, gte, inArray, isNull, lt } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { SqlCapablePersistenceProvider } from "@minsky/domain/persistence/types";
import { subagentInvocationsTable } from "@minsky/domain/storage/schemas/subagent-invocations-schema";
import { getLoggableErrorSummary } from "@minsky/domain/errors/index";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * The mt#1770 cutover. Every row seeded with the old pessimistic
 * `crashed-no-output` default started strictly before this instant (measured
 * 2026-08-09: the newest such row started 2026-07-31T21:09:40Z). A
 * `crashed-no-output` open row at or after it is a LIVE dispatch-recover
 * classification, not a false verdict — see the module header.
 */
export const MT1770_CUTOVER_ISO = "2026-08-01T00:00:00.000Z";

/**
 * Target rows counted against prod on 2026-08-09, recorded in mt#3173's spec.
 *
 * This is the expectation the scope-match guard checks against, NOT a limit. It
 * is deliberately a fixed number rather than a re-measurement: a guard that
 * re-derives its own expectation from the same query it is guarding cannot
 * detect that the population changed.
 *
 * Because it is fixed, it goes stale the moment the sweep runs — a later run
 * finds far fewer rows and correctly refuses. `--baseline N` is the path for a
 * deliberate re-run: it makes the operator STATE the re-measured count, so the
 * check is re-confirmed rather than skipped.
 */
export const MEASURED_BASELINE = 145;

/** Matched-count divergence from the baseline that aborts instead of proceeding. */
export const SCOPE_DIVERGENCE_FACTOR = 2;

/** The false verdict this backfill retires. */
export const FALSE_CRASH_OUTCOME = "crashed-no-output";

/** The value it is replaced with (already an enum member as of mt#1770). */
export const REPLACEMENT_OUTCOME = "pending";

// ---------------------------------------------------------------------------
// Row-selection predicates (SQL — the DB, not application code, decides)
// ---------------------------------------------------------------------------

/**
 * A row as fetched by the queries below: an OPEN row (`ended_at IS NULL`)
 * carrying the false-crash outcome, on one side of the cutover or the other.
 */
export interface FalseCrashCandidateRow {
  id: string;
  startedAt: Date;
}

const CUTOVER = new Date(MT1770_CUTOVER_ISO);

/**
 * The three-clause predicate this backfill is authorized to mutate:
 * `outcome = 'crashed-no-output' AND ended_at IS NULL AND started_at < cutover`.
 *
 * All three clauses live in SQL rather than being partly enforced in
 * application code, so the database — not the planner — decides what is
 * eligible. It is applied TWICE: once to select the candidates, and again on
 * the UPDATE's own WHERE clause. The second application is not redundant: it
 * closes the window between the SELECT and the UPDATE, in which a SubagentStop
 * could legitimately close one of the selected rows and write its real terminal
 * outcome. Keyed on `id` alone, the UPDATE would then overwrite that real
 * outcome with `pending`.
 */
export function targetRowsWhere() {
  return and(
    eq(subagentInvocationsTable.outcome, FALSE_CRASH_OUTCOME),
    isNull(subagentInvocationsTable.endedAt),
    lt(subagentInvocationsTable.startedAt, CUTOVER)
  );
}

/**
 * The complement on the cutover axis: open false-crash rows at or after the
 * cutover. These are REPORTED and never mutated — a live dispatch-recover
 * classification legitimately takes this shape (see the module header), so the
 * backfill must not touch them.
 */
export function manualTriageRowsWhere() {
  return and(
    eq(subagentInvocationsTable.outcome, FALSE_CRASH_OUTCOME),
    isNull(subagentInvocationsTable.endedAt),
    gte(subagentInvocationsTable.startedAt, CUTOVER)
  );
}

export interface ScopeMatchVerdict {
  ok: boolean;
  message: string;
}

/**
 * Compare the matched row count against the recorded baseline. Approval of an
 * operation at one magnitude is not approval at N times that magnitude, so a
 * run that finds far more (or far fewer) rows than the spec recorded stops for
 * re-confirmation instead of proceeding.
 *
 * A count of 0 is NOT a divergence — it is the idempotent re-run case.
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
  // Narrow via SqlCapablePersistenceProvider per the base class's own doc
  // comment ("callers that need typed connections should narrow via
  // SqlCapablePersistenceProvider") — the runtime checks above already proved
  // this shape. Matches the precedent in `backfill-close-stale-asks.ts`; the DI
  // container also registers an `UnconfiguredPersistenceProvider` placeholder,
  // which the checks above reject before this point.
  const sqlProvider = persistence as SqlCapablePersistenceProvider;
  const connection = await sqlProvider.getDatabaseConnection();
  if (!connection) {
    throw new Error("Backfill requires an initialized Postgres database connection.");
  }

  return connection as PostgresJsDatabase;
}

/**
 * Parse an integer-valued flag. Throws rather than silently ignoring a
 * malformed value: a typo'd `--limit` that quietly became "no limit" would turn
 * a run intended to be bounded into a full-population mutation.
 *
 * `--baseline` accepts 0 (the legitimate "I have re-measured and expect none"
 * case); `--limit 0` is meaningless, so the minimum is per-flag.
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

export function parseLimit(argv: string[]): number | null {
  return parseIntFlag(argv, "--limit", 1);
}

/**
 * The operator-stated re-measured target count, when re-running after the
 * original sweep has already moved the population away from `MEASURED_BASELINE`.
 */
export function parseBaseline(argv: string[]): number | null {
  return parseIntFlag(argv, "--baseline", 0);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const execute = argv.includes("--execute");
  const limit = parseLimit(argv);
  const baseline = parseBaseline(argv) ?? MEASURED_BASELINE;

  let db: PostgresJsDatabase;
  try {
    db = await getDb();
  } catch (err) {
    console.error(
      "SKIP: failed to initialize DB connection — Postgres not available in this environment."
    );
    console.error(getLoggableErrorSummary(err));
    process.exit(0);
  }

  // Two queries, each carrying its full predicate in SQL. The target set is the
  // three-clause predicate the backfill is authorized to mutate; the triage set
  // is its complement on the cutover axis, fetched only to be REPORTED.
  const selectColumns = {
    id: subagentInvocationsTable.id,
    startedAt: subagentInvocationsTable.startedAt,
  };

  const target = (await db
    .select(selectColumns)
    .from(subagentInvocationsTable)
    .where(targetRowsWhere())) as FalseCrashCandidateRow[];

  const manualTriage = (await db
    .select(selectColumns)
    .from(subagentInvocationsTable)
    .where(manualTriageRowsWhere())) as FalseCrashCandidateRow[];

  console.log(
    `backfill-subagent-invocation-false-crashes ${execute ? "(EXECUTE)" : "(dry-run)"}` +
      `${limit === null ? "" : ` --limit ${limit}`}`
  );
  console.log(
    `  open '${FALSE_CRASH_OUTCOME}' rows:            ${target.length + manualTriage.length}`
  );
  console.log(`  → flip to '${REPLACEMENT_OUTCOME}' (pre-cutover):  ${target.length}`);
  console.log(`  → manual triage (at/after cutover):  ${manualTriage.length}`);
  for (const row of manualTriage) {
    console.log(`      ${row.id} started ${row.startedAt.toISOString()} — LEFT UNTOUCHED`);
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
    // One bulk UPDATE, not a per-row loop: sequential per-row awaits over a
    // laptop→Supabase round trip are the recurring killer on this class of
    // backfill (mem#758). Only `outcome` is set — `ended_at` stays NULL by
    // construction, per ask#6801.
    //
    // The WHERE re-asserts the full eligibility predicate alongside the id list
    // rather than trusting the ids alone. See `targetRowsWhere`: between this
    // statement and the SELECT that produced the ids, a SubagentStop can close
    // one of those rows and write its real terminal outcome, and an id-only
    // UPDATE would overwrite it with `pending`.
    const updatedRows = await db
      .update(subagentInvocationsTable)
      .set({ outcome: REPLACEMENT_OUTCOME })
      .where(
        and(
          inArray(
            subagentInvocationsTable.id,
            selected.map((row) => row.id)
          ),
          targetRowsWhere()
        )
      )
      .returning({ id: subagentInvocationsTable.id });
    const updatedIds = new Set(updatedRows.map((row) => row.id));
    updated = updatedRows.length;
    console.log(`  updated=${updated} of ${selected.length} selected`);

    // A shortfall is the guard above doing its job: a row selected moments ago
    // no longer satisfied the eligibility predicate at UPDATE time, so it was
    // skipped rather than clobbered. Say so — an unexplained gap between
    // `selected` and `updated` reads as data loss, and a silent one is the
    // failure class this repo treats as its most costly.
    if (updated < selected.length) {
      const skipped = selected.map((row) => row.id).filter((id) => !updatedIds.has(id));
      console.log(
        `  NOTE: ${selected.length - updated} row(s) were skipped by the UPDATE's eligibility ` +
          `predicate — they stopped matching between the SELECT and the UPDATE (most likely a ` +
          `SubagentStop closed them and wrote a real outcome). They were NOT modified:`
      );
      for (const id of skipped) console.log(`      ${id}`);
    }
  } else if (execute) {
    console.log("  nothing to update.");
  } else {
    console.log(
      `  (dry-run — re-run with --execute to flip ${selected.length} row(s) to '${REPLACEMENT_OUTCOME}')`
    );
  }

  const result = {
    mode: execute ? "execute" : "dry-run",
    limit,
    openFalseCrashRows: target.length + manualTriage.length,
    target: target.length,
    manualTriage: manualTriage.length,
    manualTriageIds: manualTriage.map((row) => row.id),
    selected: selected.length,
    updated,
    baseline,
  };
  console.log(JSON.stringify(result));

  process.exit(0);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(
      `backfill-subagent-invocation-false-crashes failed: ${getLoggableErrorSummary(err)}`
    );
    process.exit(1);
  });
}
