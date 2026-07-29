/**
 * Drizzle schema for reviewer_findings table (mt#3295).
 *
 * Owned by the reviewer service. No imports from src/.
 *
 * Persists reviewer findings (BLOCKING / NON-BLOCKING / PRE-EXISTING) as
 * structured rows at post time, replacing the pre-mt#3295 state where finding
 * content existed only as markdown prose inside GitHub review bodies (mirrored,
 * unparsed, in `reviewer_webhook_events.body`). See mt#3295 spec's root cause
 * #2 ("Findings are never normalized into rows") for the motivating gap.
 *
 * One row per finding per review round. A finding raised in round 1 and
 * re-raised in round 2 produces TWO rows (one per round) — this is
 * intentional: the row records what was posted at that specific round, not
 * a deduplicated "current state" view. Cross-round identity (same finding,
 * carried forward vs. resolved) is a query-time concern, not a write-time one.
 */

import { pgTable, uuid, text, integer, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * Accepted `severity` values. The DB column is unconstrained `text` (mirrors
 * the `verdict` column convention in convergence-metrics-schema.ts —
 * mt#2287's rationale: a plain nullable/required text column is simpler than
 * a pg enum for additive-migration purposes); this set is the enforced
 * contract at the application layer.
 */
export type FindingSeverity = "BLOCKING" | "NON-BLOCKING" | "PRE-EXISTING";

export const VALID_FINDING_SEVERITIES: ReadonlySet<string> = new Set<FindingSeverity>([
  "BLOCKING",
  "NON-BLOCKING",
  "PRE-EXISTING",
]);

/**
 * Accepted `disposition` values (mt#3295 SC#2).
 *
 * Populated on the convergence path — NOT a full argued-out-of-BLOCKING
 * classifier (that's mt#3300's job; this task only wires the cheap signals
 * already computed by the existing recovery/convergence-detector passes):
 *
 *   - "bypassed"                     — a structural recovery pass (severity-
 *                                       monotonicity, composition-convergence,
 *                                       diff-scope-bounded, or refutation-aware
 *                                       re-assertion) downgraded this finding
 *                                       from BLOCKING to NON-BLOCKING within
 *                                       the SAME round it was raised. Set at
 *                                       insert time from the recovery pass's
 *                                       own downgrade-audit output.
 *   - "unknown"                      — the finding was open (BLOCKING) in a
 *                                       prior round and is no longer present
 *                                       once the PR reaches an APPROVE verdict,
 *                                       but the cheap population here cannot
 *                                       further classify HOW it was resolved
 *                                       (fixed by code, dismissed as a false
 *                                       positive, or resolved without a code
 *                                       change). Set at approval time as a
 *                                       safe, non-overclaiming default.
 *   - "fixed-by-code-change"         — reserved for the deeper classifier
 *                                       (mt#3300) that cross-checks the
 *                                       finding's file:line window against the
 *                                       diff since it was raised.
 *   - "dismissed-as-FP"              — reserved for mt#3300 (requires
 *                                       correlating reviewer/implementer
 *                                       argumentation, not just diff presence).
 *   - "resolved-without-code-change" — reserved for mt#3300 (the finding
 *                                       disappeared but its file was not
 *                                       touched — the "argued out of
 *                                       BLOCKING" case named in the mt#3295
 *                                       spec's Measured corpus results §2).
 *
 * NULL means "not yet evaluated" (the finding is still open in the current
 * round, or the PR has not yet converged).
 */
export type FindingDisposition =
  | "fixed-by-code-change"
  | "dismissed-as-FP"
  | "bypassed"
  | "resolved-without-code-change"
  | "unknown";

export const VALID_FINDING_DISPOSITIONS: ReadonlySet<string> = new Set<FindingDisposition>([
  "fixed-by-code-change",
  "dismissed-as-FP",
  "bypassed",
  "resolved-without-code-change",
  "unknown",
]);

/**
 * Stores one row per reviewer finding, posted at review-submission time.
 *
 * Rows are also produced by the one-shot backfill
 * (scripts/backfill-findings-from-webhook-events.ts) which mines historical
 * findings out of `reviewer_webhook_events.body` (`pull_request_review`
 * payloads) using the same `parseFindingsFromBody` parser this table's live
 * writer uses — so backfilled and live-written rows share identical
 * extraction semantics.
 */
export const reviewerFindingsTable = pgTable(
  "reviewer_findings",
  {
    /** Surrogate PK generated by Postgres. */
    id: uuid("id")
      .default(sql`gen_random_uuid()`)
      .primaryKey(),

    /** GitHub repository owner (org or user login). */
    prOwner: text("pr_owner").notNull(),

    /** GitHub repository name. */
    prRepo: text("pr_repo").notNull(),

    /** Pull request number within the repository. */
    prNumber: integer("pr_number").notNull(),

    /** Git SHA of the PR head commit the finding was raised against. */
    headSha: text("head_sha").notNull(),

    /**
     * 1-indexed review round the finding was raised in (1 = first review,
     * matching `reviewer_convergence_metrics.iteration_index`'s convention).
     */
    round: integer("round").notNull(),

    /** BLOCKING / NON-BLOCKING / PRE-EXISTING. See {@link FindingSeverity}. */
    severity: text("severity").notNull(),

    /** File path the finding refers to, relative to the repository root. */
    file: text("file").notNull(),

    /** 1-based line number, when the finding is line-anchored. */
    line: integer("line"),

    /** Inclusive end line for a multi-line finding range. */
    lineEnd: integer("line_end"),

    /**
     * Short summary of the finding. On the output-tools path this is the
     * model's own `submit_finding.summary` field (one sentence). On the
     * prose/backfill path (no separate summary/details split available),
     * this is derived from the finding's parsed text — see
     * `deriveTitleFromText` in findings.ts.
     */
    title: text("title").notNull(),

    /**
     * Full finding text. Output-tools path: `submit_finding.details`.
     * Prose/backfill path: the parsed post-dash description text (or a
     * synthesized fallback when no description text was present).
     */
    body: text("body").notNull(),

    /** See {@link FindingDisposition}. NULL = not yet evaluated. */
    disposition: text("disposition"),

    /** When `disposition` was last set. NULL while disposition is NULL. */
    dispositionSetAt: timestamp("disposition_set_at", { withTimezone: true }),

    /**
     * Idempotency key (mt#3295 PR #2391 R1): a stable hash of
     * (pr_owner, pr_repo, pr_number, round, file, line, line_end, title) —
     * see `computeFindingNaturalKey` in `findings.ts`. Unique-indexed so
     * `recordFindings` can `onConflictDoNothing` on it: the live writer path
     * (review-finalize.ts, one call per round) and the one-shot backfill
     * script (scripts/backfill-findings-from-webhook-events.ts, which can
     * legitimately re-run or overlap with the live writer for the same PR)
     * both go through `recordFindings`, so both share this same conflict
     * target and can never duplicate a row for the same logical finding.
     */
    naturalKey: text("natural_key").notNull(),

    /** Row insertion timestamp (UTC). */
    createdAt: timestamp("created_at", { withTimezone: true })
      .default(sql`now()`)
      .notNull(),
  },
  (table) => ({
    /** Per-PR trajectory lookup: all findings for a PR across rounds, in order. */
    byPrRound: index("idx_rf_pr_round").on(
      table.prOwner,
      table.prRepo,
      table.prNumber,
      table.round
    ),

    /** Rolling-window aggregation queries (SC#3). */
    byCreatedAt: index("idx_rf_created_at").on(table.createdAt),

    /** Disposition-backfill / disposition-rate queries (SC#2). */
    byDisposition: index("idx_rf_disposition").on(table.disposition),

    /** Severity-filtered aggregation (e.g. BLOCKING-only category counts). */
    bySeverity: index("idx_rf_severity").on(table.severity),

    /** Idempotency: one row per logical finding. See `naturalKey` above. */
    byNaturalKeyUnique: uniqueIndex("idx_rf_natural_key_unique").on(table.naturalKey),
  })
);

// ---------------------------------------------------------------------------
// Type helpers
// ---------------------------------------------------------------------------

export type ReviewerFindingRecord = typeof reviewerFindingsTable.$inferSelect;
export type ReviewerFindingInsert = typeof reviewerFindingsTable.$inferInsert;
