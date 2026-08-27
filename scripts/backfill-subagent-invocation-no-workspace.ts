#!/usr/bin/env bun
/**
 * One-time backfill (mt#3894): correct the raw-`Agent`-path `subagent_invocations` rows that
 * were classified from the PARENT repo's working tree.
 *
 * A raw harness `Agent` dispatch has no Minsky workspace — `prompt-generation.ts` forbids `cd`,
 * so its cwd is the MAIN repo. Between mt#2292 (which made these rows recordable) and mt#3894
 * (which stops classifying them), the SubagentStop hook ran the workspace classifier against
 * that cwd, so the outcome describes the OPERATOR's checkout: a dirty tree plus a root
 * `handoff.md` yielded `partial-committed-handoff-written`, and `last_commit_hash` was stamped
 * with main's HEAD, for subagents that committed nothing.
 *
 * This sweep sets those rows to `no-workspace` and clears the three parent-derived columns.
 * The forward fix is in `.minsky/hooks/record-subagent-invocation.ts`; this is the backward one.
 *
 * Usage:
 *   bun scripts/backfill-subagent-invocation-no-workspace.ts                     # dry-run (default)
 *   bun scripts/backfill-subagent-invocation-no-workspace.ts --limit 1 --execute # bounded apply
 *   bun scripts/backfill-subagent-invocation-no-workspace.ts --execute           # full apply
 *   bun scripts/backfill-subagent-invocation-no-workspace.ts --baseline 1 --execute  # re-run
 *
 * Safety (CLAUDE.md §Operational Safety: Dry-Run First) — same disciplines as the mt#3173
 * sibling `backfill-subagent-invocation-false-crashes.ts`, which this mirrors:
 *   - Dry-run by default; `--execute` required to mutate.
 *   - Scope-match check against a recorded baseline; a divergence aborts rather than proceeds.
 *   - `--limit N` bounds an `--execute` run so the mutating branch is exercisable pre-merge
 *     without the full blast radius (mt#2776).
 *   - The eligibility predicate is re-asserted on the UPDATE's own WHERE, not trusted from the
 *     SELECT's id list — a SubagentStop landing in between must not have a real outcome clobbered.
 *   - Idempotent: a re-run matches 0 rows, because corrected rows carry `no-workspace`.
 *
 * Ordering: this sweep writes the `no-workspace` enum value, so it can only run AFTER migration
 * 0092 has been applied — i.e. post-deploy. mt#3912 owns that run and records its output.
 *
 * @see mt#3894 — this task (the forward fix + this script)
 * @see mt#3912 — the post-deploy run of this script, and the live-row verification
 * @see mt#2292 — made the raw spawn path recordable (where these rows came from)
 * @see mt#3173 / ask#6801 — the sibling sweep this mirrors
 */

// tsyringe (used by createCliContainer's DI container below) requires this polyfill — without it
// the documented `bun scripts/...` invocation throws "tsyringe requires a reflect polyfill"
// (mt#2768).
import "reflect-metadata";
import { and, inArray, isNotNull, isNull } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { SqlCapablePersistenceProvider } from "@minsky/domain/persistence/types";
import { subagentInvocationsTable } from "@minsky/domain/storage/schemas/subagent-invocations-schema";
import { getLoggableErrorSummary } from "@minsky/domain/errors/index";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * The five classes `classifyWorkspaceOutcome` can actually PRODUCE. A raw-path row carrying any
 * of them was classified from a workspace that was not the subagent's, so all five are eligible —
 * not just the `partial-committed-handoff-written` the observed rows happen to carry. The label
 * varies with the operator's tree (committing the untracked files would have produced
 * `committed-no-pr` instead), so pinning the sweep to the one observed value would leave the
 * others behind.
 *
 * **`rate-limited` is deliberately NOT here** (PR #2759 R2). It is the one enum member that is
 * not workspace-derived: it records an API-level rejection, an observation about the dispatch
 * itself that holds regardless of any workspace. Nothing writes it to this table today — the
 * classifier's own header defers that detection to mt#1739, and a grep finds no writer — but
 * this sweep must be correct by construction rather than by that accident: the moment mt#1739
 * ships, a raw-path row could legitimately carry `rate-limited`, and rewriting it to
 * `no-workspace` would destroy a true observation to fix a false one.
 */
export const WORKSPACE_DERIVED_OUTCOMES = [
  "completed-with-pr",
  "committed-no-pr",
  "partial-committed-handoff-written",
  "partial-uncommitted-no-handoff",
  "crashed-no-output",
] as const;

/**
 * Enum values this sweep must never claim, each for its own reason: `pending` is still-open (the
 * dispatcher's placeholder), `no-workspace` is what the sweep writes (excluding it is what makes
 * a re-run idempotent), and `rate-limited` is a real non-workspace observation — see above.
 */
export const NON_WORKSPACE_DERIVED_OUTCOMES = ["pending", "no-workspace", "rate-limited"] as const;

/** The value these rows are corrected to (added by migration 0092). */
export const REPLACEMENT_OUTCOME = "no-workspace";

/**
 * Target rows counted against prod on 2026-08-10, recorded in mt#3894's spec.
 *
 * Fixed rather than re-derived: a guard that re-measures its own expectation from the query it
 * is guarding cannot detect that the population changed. `--baseline N` is the path for a
 * deliberate re-run — it makes the operator STATE the re-measured count.
 */
export const MEASURED_BASELINE = 3;

/** Matched-count divergence from the baseline that aborts instead of proceeding. */
export const SCOPE_DIVERGENCE_FACTOR = 2;

// ---------------------------------------------------------------------------
// Row selection (SQL — the DB, not application code, decides)
// ---------------------------------------------------------------------------

export interface NoWorkspaceCandidateRow {
  id: string;
  outcome: string | null;
  startedAt: Date;
}

/**
 * The three-clause predicate this backfill is authorized to mutate:
 *
 *   parent_tool_use_id IS NOT NULL  -- a raw `Agent` dispatch (mt#2292 stamped it)
 *   AND subagent_session_id IS NULL -- and it had no Minsky workspace of its own
 *   AND outcome IN (<workspace-derived>)  -- so any such outcome came from the PARENT's tree
 *
 * The first two clauses are the same discriminator the forward fix uses at the call site; the
 * third excludes rows that are still `pending` (open, never closed) and rows already corrected.
 */
export function targetRowsWhere() {
  return and(
    isNotNull(subagentInvocationsTable.parentToolUseId),
    isNull(subagentInvocationsTable.subagentSessionId),
    inArray(subagentInvocationsTable.outcome, [...WORKSPACE_DERIVED_OUTCOMES])
  );
}

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
    console.error(getLoggableErrorSummary(err));
    process.exit(0);
  }

  const target = (await db
    .select({
      id: subagentInvocationsTable.id,
      outcome: subagentInvocationsTable.outcome,
      startedAt: subagentInvocationsTable.startedAt,
    })
    .from(subagentInvocationsTable)
    .where(targetRowsWhere())) as NoWorkspaceCandidateRow[];

  console.log(
    `backfill-subagent-invocation-no-workspace ${execute ? "(EXECUTE)" : "(dry-run)"}` +
      `${limit === null ? "" : ` --limit ${limit}`}`
  );
  console.log(`  raw-path rows with a workspace-derived outcome: ${target.length}`);
  for (const row of target) {
    console.log(`      ${row.id} outcome=${row.outcome} started ${row.startedAt.toISOString()}`);
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
    // One bulk UPDATE, not a per-row loop (mem#758). The WHERE re-asserts the eligibility
    // predicate alongside the id list: between the SELECT above and this statement a
    // SubagentStop could close one of those rows and write a real outcome, and an id-only
    // UPDATE would overwrite it.
    //
    // `last_commit_hash` / `pr_url` / `handoff_written` are cleared in the same statement.
    // They are exactly as parent-derived as the outcome was — `last_commit_hash` held main's
    // HEAD, which is worse than uninformative: it attributes a commit to a subagent that made
    // none.
    const updatedRows = await db
      .update(subagentInvocationsTable)
      .set({
        outcome: REPLACEMENT_OUTCOME,
        lastCommitHash: null,
        prUrl: null,
        handoffWritten: false,
      })
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

    if (updated < selected.length) {
      const skipped = selected.map((row) => row.id).filter((id) => !updatedIds.has(id));
      console.log(
        `  NOTE: ${selected.length - updated} row(s) were skipped by the UPDATE's eligibility ` +
          `predicate — they stopped matching between the SELECT and the UPDATE. NOT modified:`
      );
      for (const id of skipped) console.log(`      ${id}`);
    }
  } else if (execute) {
    console.log("  nothing to update.");
  } else {
    console.log(
      `  (dry-run — re-run with --execute to correct ${selected.length} row(s) to '${REPLACEMENT_OUTCOME}')`
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
      `backfill-subagent-invocation-no-workspace failed: ${getLoggableErrorSummary(err)}`
    );
    process.exit(1);
  });
}
