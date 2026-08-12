import { pgTable, text, uuid, timestamp, boolean, index } from "drizzle-orm/pg-core";

/**
 * Guard canary runs table — persists per-guard canary outcomes so "broken
 * since" is derivable (mt#4007).
 *
 * `scripts/run-guard-canaries.ts` runs every declared guard canary (synthetic
 * input through the guard's REAL `run()` export) and previously reported
 * pass/fail to stdout only — no history was kept, so a broken guard and a
 * guard that had simply never been canary-tested were indistinguishable, and
 * there was no way to answer "since when has this guard been broken?" (the
 * mt#2057 / mt#2835 incidents this closes: both dead guards went undetected
 * for 7-9 days before an operator noticed by hand).
 *
 * Design decisions (mt#4007 spec SC4 — the storage choice is NOT a free
 * preference; it is decided against ADR-027 and the thin-hooks RFC):
 *
 * - **Postgres, not a flat file.** ADR-027 ratifies Postgres as the sole
 *   persistence backend (a second backend/engine is not just undocumented,
 *   it is not expressible in `PersistenceConfig["backend"]`'s type). The
 *   Accepted thin-hooks RFC (mem#960, 2026-08-11) frames the DB as the
 *   eventual system of record for guard evidence, with JSONL-spool-then-
 *   daemon-ingest reserved specifically for PER-INVOCATION dispatcher guards
 *   that are "DB-blind as physics" (a live Postgres connect measures
 *   3.3-5.5s against their sub-second hook budget). `scripts/run-guard-
 *   canaries.ts` is not that: it is a standalone, on-demand CLI script (run
 *   by a human/agent, or subprocess-spawned by `scripts/rationalization-
 *   review.ts`), and its sibling script already bootstraps the full CLI
 *   container for a DB-adjacent lookup (`resolveFamilyRecurrences`). The
 *   hook-latency argument for JSONL-spooling therefore does not apply here,
 *   and nothing in either record blocks a direct Postgres write from this
 *   process. This is, as of 2026-08-12, the FIRST Postgres-backed table in
 *   the evaluation-loop family — the existing fire-log and calibration logs
 *   are still JSONL-only (DB ingestion for THAT family is a separate,
 *   already-tracked, unshipped task, mt#3334) — so this table is justified on
 *   its own terms (a durable, indexed, queryable history is what "broken
 *   since" needs; a growing JSONL file would require a full linear scan per
 *   query) rather than by pointing at an existing DB precedent in this
 *   family.
 *
 * - **History, not last-write-wins.** Append-only: every canary pass writes a
 *   fresh row per evaluated guard, sharing one `run_id`. No upsert / unique
 *   constraint on `guard_name` — two consecutive passing runs must leave two
 *   timestamped records (AT3), not one row whose timestamp got bumped.
 *
 * - **Never-verified is absence, not a stored state.** A guard with no
 *   declared canary (`CanaryResult.passed === undefined`) never gets a row
 *   here at all — "zero history rows for this guard" IS the never-verified
 *   state (AT2), read naturally by the same query that finds no pass/fail
 *   history. This also covers a brand-new registry entry that hasn't been
 *   through a canary pass yet: identical signal, same correct answer.
 *   Whether a guard CURRENTLY declares a canary is a live, static registry
 *   fact a reader checks separately (mt#3754's catalog, out of scope here) —
 *   this table only ever records EVALUATED outcomes.
 *
 * @see mt#4007 — this table
 * @see packages/domain/src/observability/guard-canary-history.ts — write/read repository
 * @see scripts/run-guard-canaries.ts — the writer (best-effort, fail-open)
 * @see .minsky/hooks/canary-runner.ts — the pure evaluation logic this table persists
 * @see docs/architecture/adr-027-postgres-only-persistence-confirmed.md
 */
export const guardCanaryRunsTable = pgTable(
  "guard_canary_runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    /**
     * Groups every row written by ONE invocation of the canary suite. The
     * "corpus baseline" SC1 asks for (which guards were checked in a given
     * pass) is exactly the set of `guard_name` values sharing a `run_id`.
     */
    runId: uuid("run_id").notNull(),

    /** Guard identity, mirroring `CanaryResult.guardName`. */
    guardName: text("guard_name").notNull(),

    /** "registry" (GUARD_REGISTRY entry) or "standalone" — mirrors `CanaryResult.source`. */
    source: text("source").notNull(),

    /** The declared `CanaryExpectation` ("deny" | "warn" | "calibration" | "sessionTitle" | "updatedInput"). */
    expects: text("expects").notNull(),

    /** true = canary passed, false = canary failed. Never null — see the doc comment above. */
    passed: boolean("passed").notNull(),

    /**
     * Failure detail (SC1's "failure detail"): the guard module's thrown
     * error message when it threw, or a synthesized mismatch summary when
     * the canary ran to completion but its outcome didn't match `expects`.
     * Null on a pass.
     */
    failureDetail: text("failure_detail"),

    /**
     * Shared wall-clock moment for every row written by the same run —
     * an explicit value passed by the writer (not `defaultNow()`), so every
     * row in one canary pass carries the identical timestamp regardless of
     * per-row insert ordering.
     */
    ranAt: timestamp("ran_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    // The "broken since" read query: most-recent-first history for one guard.
    index("idx_guard_canary_runs_guard_name_ran_at").on(table.guardName, table.ranAt),
    // The corpus-baseline read query: every guard checked in one run.
    index("idx_guard_canary_runs_run_id").on(table.runId),
  ]
);

// ---------------------------------------------------------------------------
// Type helpers
// ---------------------------------------------------------------------------

export type GuardCanaryRunRecord = typeof guardCanaryRunsTable.$inferSelect;
export type GuardCanaryRunInsert = typeof guardCanaryRunsTable.$inferInsert;
