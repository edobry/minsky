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
 *
 * Safety (CLAUDE.md §Operational Safety: Dry-Run First):
 *   - Dry-run by default; `--execute` required to mutate.
 *   - Scope-match check: the matched count is compared against the baseline
 *     measured when this script was written. A divergence beyond
 *     `SCOPE_DIVERGENCE_FACTOR` aborts rather than proceeding, per the
 *     dry-run scope-match rule (a 9x divergence once shipped 136 unintended
 *     writes — mem#622).
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
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { subagentInvocationsTable } from "@minsky/domain/storage/schemas/subagent-invocations-schema";

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

/** Target rows counted against prod on 2026-08-09, recorded in mt#3173's spec. */
export const MEASURED_BASELINE = 145;

/** Matched-count divergence from the baseline that aborts instead of proceeding. */
export const SCOPE_DIVERGENCE_FACTOR = 2;

/** The false verdict this backfill retires. */
export const FALSE_CRASH_OUTCOME = "crashed-no-output";

/** The value it is replaced with (already an enum member as of mt#1770). */
export const REPLACEMENT_OUTCOME = "pending";

// ---------------------------------------------------------------------------
// Pure planning logic (unit-tested directly — no DB, no I/O)
// ---------------------------------------------------------------------------

/**
 * A candidate row as fetched by the query: an OPEN row (`ended_at IS NULL`)
 * carrying the false-crash outcome. `startedAt` decides which side of the
 * cutover it falls on.
 */
export interface FalseCrashCandidateRow {
  id: string;
  startedAt: Date;
}

export interface FalseCrashBackfillPlan {
  /** Rows to flip to `pending` — pre-cutover, so provably seeded, not classified. */
  target: FalseCrashCandidateRow[];
  /**
   * Rows at or after the cutover. A live dispatch-recover classification may
   * legitimately look like this, so they are reported and never mutated.
   */
  manualTriage: FalseCrashCandidateRow[];
}

/**
 * Partition the candidate rows around the cutover. Pure: the caller supplies
 * the rows and the cutover, so the decision is observable without a DB.
 */
export function planFalseCrashBackfill(
  rows: FalseCrashCandidateRow[],
  cutoverIso: string = MT1770_CUTOVER_ISO
): FalseCrashBackfillPlan {
  const cutoverMs = new Date(cutoverIso).getTime();
  const target: FalseCrashCandidateRow[] = [];
  const manualTriage: FalseCrashCandidateRow[] = [];

  for (const row of rows) {
    if (row.startedAt.getTime() < cutoverMs) target.push(row);
    else manualTriage.push(row);
  }

  return { target, manualTriage };
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

  const connection = await persistence.getDatabaseConnection();
  if (!connection) {
    throw new Error("Backfill requires an initialized Postgres database connection.");
  }

  return connection as PostgresJsDatabase;
}

function parseLimit(argv: string[]): number | null {
  const index = argv.indexOf("--limit");
  if (index === -1) return null;
  const raw = argv[index + 1];
  const parsed = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`--limit expects a positive integer, got: ${raw ?? "(missing)"}`);
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const execute = argv.includes("--execute");
  const limit = parseLimit(argv);

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

  // Candidates: OPEN rows carrying the false-crash verdict, both sides of the
  // cutover. The cutover partition happens in the pure planner below so the
  // decision is unit-testable.
  const candidates = (await db
    .select({
      id: subagentInvocationsTable.id,
      startedAt: subagentInvocationsTable.startedAt,
    })
    .from(subagentInvocationsTable)
    .where(
      and(
        eq(subagentInvocationsTable.outcome, FALSE_CRASH_OUTCOME),
        isNull(subagentInvocationsTable.endedAt)
      )
    )) as FalseCrashCandidateRow[];

  const { target, manualTriage } = planFalseCrashBackfill(candidates);

  console.log(
    `backfill-subagent-invocation-false-crashes ${execute ? "(EXECUTE)" : "(dry-run)"}` +
      `${limit === null ? "" : ` --limit ${limit}`}`
  );
  console.log(`  open '${FALSE_CRASH_OUTCOME}' rows:            ${candidates.length}`);
  console.log(`  → flip to '${REPLACEMENT_OUTCOME}' (pre-cutover):  ${target.length}`);
  console.log(`  → manual triage (at/after cutover):  ${manualTriage.length}`);
  for (const row of manualTriage) {
    console.log(`      ${row.id} started ${row.startedAt.toISOString()} — LEFT UNTOUCHED`);
  }

  const scope = checkScopeMatch(target.length);
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
    const updatedRows = await db
      .update(subagentInvocationsTable)
      .set({ outcome: REPLACEMENT_OUTCOME })
      .where(
        inArray(
          subagentInvocationsTable.id,
          selected.map((row) => row.id)
        )
      )
      .returning({ id: subagentInvocationsTable.id });
    updated = updatedRows.length;
    console.log(`  updated=${updated} of ${selected.length} selected`);
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
    openFalseCrashRows: candidates.length,
    target: target.length,
    manualTriage: manualTriage.length,
    manualTriageIds: manualTriage.map((row) => row.id),
    selected: selected.length,
    updated,
    baseline: MEASURED_BASELINE,
  };
  console.log(JSON.stringify(result));

  process.exit(0);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(
      `backfill-subagent-invocation-false-crashes failed: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    process.exit(1);
  });
}
