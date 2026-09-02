/**
 * Reviewer webhook-outcome reporting command (mt#4118).
 *
 * `observability.reviewer-events` — reads `reviewer_webhook_events`, the
 * reviewer service's per-delivery record, and answers the one question the
 * silence-diagnosis ladder in `/merge-coordination` §7a could not answer:
 * **did the reviewer never run, or did it run and fail?**
 *
 * **Why this command exists.** Both states present identically to every
 * agent-visible surface — `session_pr_wait-for-review` returns
 * `matched: false` with `reviewerCheckRunState: "absent"` for both, and the
 * documented next step after a fully-walked ladder is a bypass merge. So a
 * ladder blind to submission failure routes a repo-wide reviewer outage into
 * merging past review. That is not hypothetical: on 2026-08-08 every rung
 * reported "absent" while the service 422'd on every incremental review in the
 * repo (mt#3852), and on 2026-09-01 it reported "absent" while the service had
 * run and failed four times on a provider 400 (mt#4879).
 *
 * The signal existed both times. `reviewer_webhook_events.outcome` is a typed
 * enum recording the furthest stage each delivery reached, and `error_details`
 * carries the classified cause. Nothing an agent could call read it: the
 * reviewer service exposes four HTTP routes (`/health`, `/retrigger`,
 * `/alert-test`, `/webhook`) and none of them is this, and the only
 * Minsky-side reader was a cockpit widget. The gap was a command surface, not
 * a connection.
 *
 * **Access path.** Resolves the persistence provider from `context.container`
 * at execute time and reads through the daemon's existing connection — the
 * same pattern as `observability.reviewer-cost`, which reads `review_timing`
 * the same way. No second connection string; no credential passed by the
 * caller; SELECTs only.
 *
 * **Three coverage bounds, all measured 2026-09-02 and all reported in
 * `bounds` on every call.** They are emitted with the result rather than
 * documented here alone, because the failure mode this command exists to
 * prevent is exactly "an empty result read as proof of absence":
 *
 *  1. A retrigger-initiated review leaves NO row. `POST /retrigger` synthesises
 *     a `retrigger-…` delivery id and calls `startDetachedReview` directly;
 *     nothing inserts a receipt first, so the outcome update targets zero rows.
 *     Measured: 0 of 36,609 rows carry a `retrigger-` delivery id. This matters
 *     because `reviewer_retrigger` is the ladder rung immediately before this
 *     one — the record shows webhook-triggered attempts, never the retrigger
 *     you just fired.
 *  2. Rows are pruned at `MINSKY_REVIEWER_WEBHOOK_EVENT_RETENTION_DAYS`
 *     (default 90). Past that horizon the deployment logs are the fallback.
 *  3. The window is bounded — see {@link DEFAULT_WINDOW_DAYS}. "No record" is
 *     always relative to the window actually queried, which is why the
 *     effective window is echoed back in `filter.since`.
 *
 * @see mt#3852 — the submit-path 422 the ladder could not see
 * @see mt#4879 — the pre-submit provider 400, same signature
 * @see mem#1093 — the checklist this rung slots into, and the status-comment
 *      discriminator that is cheaper but can be absent entirely
 * @see mt#4881 — the push-side twin: the service alerting on these failures
 */
import { z } from "zod";
import { sharedCommandRegistry, CommandCategory } from "../command-registry";
import type { SharedCommandRegistry } from "../command-registry";
import type { AppContainerInterface } from "@minsky/domain/composition/types";

/**
 * Default lower bound on `received_at` when the caller names none.
 *
 * A bound is always applied, for two independent reasons. The table has no
 * index on the jsonb paths this command filters by (`reviewer_webhook_events`
 * carries no owner/repo/pr columns at all — its only repo signal is inside the
 * raw `body`), so `idx_rwe_received_at` is what keeps the scan bounded. And an
 * unbounded "no rows" answer would be indistinguishable from a bounded one,
 * which is the confusion this whole command exists to remove.
 */
export const DEFAULT_WINDOW_DAYS = 7;

/** Cap on returned rows. A PR's whole history is a few dozen deliveries. */
const MAX_ROWS = 200;

/**
 * Event types that can cause the reviewer to run.
 *
 * `pull_request` is the push/open path; `issue_comment` is the comment-command
 * path (`/review`, `/resolve` — ADR-030's comment channel). `check_suite` and
 * `pull_request_review` deliveries are recorded but never advance past
 * `received`, which is normal and NOT evidence of a stuck reviewer — measured
 * over 30 days, 6,933 `issue_comment` and 3,962 `check_suite` rows sat at
 * `received` while only 5 `issue_comment` rows ever reached a terminal state.
 */
export const REVIEW_TRIGGER_EVENT_TYPES: readonly string[] = ["pull_request", "issue_comment"];

/**
 * What one delivery row says about whether a review was attempted.
 *
 * Deliberately NOT a restatement of the `outcome` enum: the enum's
 * `failed_at_reviewer` covers two states that call for opposite responses, and
 * collapsing them is the precision defect this classification removes.
 */
export type ReviewerEventVerdict =
  /** `runReview` threw or returned an error — the reviewer ran and did not complete. */
  | "ran-and-failed"
  /** `runReview` returned `status: "skipped"` — it DECLINED to run (another caller held the marker). */
  | "declined-to-run"
  /** Dispatched, no terminal outcome ever written — killed mid-review (container restart, tool-loop timeout). */
  | "dispatched-never-finished"
  /** A review was posted. */
  | "review-submitted"
  /** Deliberately skipped before dispatch — draft PR, tier=skip. */
  | "deliberately-skipped"
  /** Failed at signature verification or tier routing, before the reviewer was reached. */
  | "failed-before-dispatch"
  /** Delivered and verified; not yet routed, or still in flight. */
  | "awaiting-routing"
  /** Not a review trigger — normal traffic that never advances. */
  | "not-a-review-trigger";

/** The ladder-facing verdict for a whole PR, derived from its rows. */
export type ReviewerLadderVerdictKind =
  /** No delivery at all in the window — consistent with genuine webhook silence. */
  "no-record" | ReviewerEventVerdict;

export interface ReviewerEventRow {
  receivedAt: string;
  processedAt: string | null;
  eventType: string;
  action: string | null;
  outcome: string;
  repo: string | null;
  prNumber: number | null;
  headSha: string | null;
  errorStage: string | null;
  errorMessage: string | null;
  verdict: ReviewerEventVerdict;
}

export interface ReviewerFailureClass {
  /** First 80 chars of `error_details.message` — the full text varies per occurrence. */
  messagePrefix: string;
  count: number;
  distinctPrs: number;
  lastSeen: string;
}

export interface ReviewerEventsReport {
  filter: {
    owner: string | null;
    repo: string | null;
    pr: number | null;
    /** The effective lower bound actually queried — never null. */
    since: string;
  };
  verdict: {
    kind: ReviewerLadderVerdictKind;
    /**
     * True when the record holds no evidence that a review was ever ATTEMPTED
     * on this head — `no-record` (no delivery at all) and `not-a-review-trigger`
     * (only routine non-trigger traffic such as `check_suite` receipts). In both
     * cases the ladder may continue toward its webhook-silence bypass.
     *
     * False for every other verdict: the service received a reviewer-triggering
     * delivery and ran, declined, stalled, or is still in flight, so §7a's
     * webhook-silence condition does not hold.
     *
     * **This defaults toward permitting the bypass, deliberately.** A wrong
     * `false` blocks a legitimate merge on a PR the reviewer never saw, which
     * is a silent stall with no signal attached; a wrong `true` merely returns
     * the ladder to the behaviour it had before this command existed, where the
     * remaining rungs still apply. The asymmetry is why non-trigger traffic
     * must not be counted as reviewer activity (PR #3560 R1).
     */
    isSilence: boolean;
    detail: string;
  };
  rowCount: number;
  rows: ReviewerEventRow[];
  /**
   * `failed_at_reviewer` classes across the whole repo in the window, so a
   * systemic outage is distinguishable from one bad PR. Empty unless `owner`
   * and `repo` are given.
   */
  repoWideFailures: ReviewerFailureClass[];
  /** Coverage bounds. Read these before treating `no-record` as absence. */
  bounds: string[];
}

// ---------------------------------------------------------------------------
// Classification (pure — no IO, no container, no database)
// ---------------------------------------------------------------------------

/**
 * `runReview` returning `status: "skipped"` is persisted with the SAME outcome
 * value as `status: "error"` — `services/reviewer/src/server.ts` writes
 * `result.status === "reviewed" ? "review_submitted" : "failed_at_reviewer"`
 * and puts `result.reason` in `error_details.message`. So the message is the
 * only thing separating "declined to run" from "ran and failed", and the two
 * have different remedies: a decline clears on a new head (mem#1093), a
 * failure does not.
 */
const CONCURRENT_INFLIGHT_MARKER = "concurrent_inflight";

export function classifyEventRow(input: {
  eventType: string;
  outcome: string;
  errorMessage: string | null;
}): ReviewerEventVerdict {
  const { eventType, outcome, errorMessage } = input;

  switch (outcome) {
    case "failed_at_reviewer":
      return (errorMessage ?? "").toLowerCase().includes(CONCURRENT_INFLIGHT_MARKER)
        ? "declined-to-run"
        : "ran-and-failed";
    case "reviewer_called":
      return "dispatched-never-finished";
    case "review_submitted":
      return "review-submitted";
    case "skipped":
      return "deliberately-skipped";
    case "failed_at_signature":
    case "failed_at_tier_resolve":
      return "failed-before-dispatch";
    case "received":
    case "tier_resolved":
      return REVIEW_TRIGGER_EVENT_TYPES.includes(eventType)
        ? "awaiting-routing"
        : "not-a-review-trigger";
    default:
      // An outcome value added to the enum after this command shipped. Fail
      // toward "the service saw something", never toward silence — the cost of
      // over-reporting activity is one extra diagnostic step; the cost of
      // under-reporting it is a bypass merge past a live reviewer.
      return "awaiting-routing";
  }
}

/** A row that says something about whether a review was ATTEMPTED. */
function isInformative(verdict: ReviewerEventVerdict): boolean {
  return verdict !== "not-a-review-trigger" && verdict !== "awaiting-routing";
}

const VERDICT_DETAIL: Record<ReviewerLadderVerdictKind, string> = {
  "no-record":
    "No delivery recorded in this window. Consistent with genuine webhook silence — but read `bounds` first: a retrigger-initiated review leaves no row, and the window is bounded.",
  "ran-and-failed":
    "The reviewer RAN and did not complete. This is not silence and §7a's bypass condition (c) does not hold. Read `errorMessage`, then check `repoWideFailures` to tell a systemic outage from one bad PR.",
  "declined-to-run":
    "The reviewer DECLINED to run — another caller held the in-flight marker. Not a failure and not silence. The remedy is a new head, not a retrigger (mem#1093).",
  "dispatched-never-finished":
    "The reviewer was dispatched and never wrote a terminal outcome — killed mid-review (container restart, or the tool-loop timeout, mt#1897). Not silence.",
  "review-submitted":
    "A review was submitted for this delivery. If no review is visible on the PR, that is a different problem from silence — check the PR's reviews list directly.",
  "deliberately-skipped":
    "The delivery was deliberately skipped before dispatch (draft PR, or tier=skip). Not silence, and not reviewable in this state.",
  "failed-before-dispatch":
    "The delivery failed at signature verification or tier routing, before the reviewer was reached. Not silence.",
  "awaiting-routing":
    "The delivery arrived and was verified but has not been routed yet. Recent — wait rather than diagnose.",
  "not-a-review-trigger":
    "Only routine non-trigger traffic recorded (check_suite receipts, comment events the reviewer does not act on). No reviewer-triggering delivery arrived in this window, so this says nothing about reviewer activity and does NOT block the ladder — read `bounds`, then continue.",
};

/**
 * Derive the PR-level verdict from its rows.
 *
 * Rows must arrive newest-first. The rule is recency among INFORMATIVE rows: a
 * successful review three days ago followed by a failure five minutes ago is a
 * failure, and reading it any other way is how the ladder would go back to
 * being wrong in the opposite direction.
 */
export function deriveLadderVerdict(rows: ReviewerEventRow[]): ReviewerEventsReport["verdict"] {
  if (rows.length === 0) {
    return { kind: "no-record", isSilence: true, detail: VERDICT_DETAIL["no-record"] };
  }

  const informative = rows.find((r) => isInformative(r.verdict));
  if (informative) {
    return {
      kind: informative.verdict,
      isSilence: false,
      detail: VERDICT_DETAIL[informative.verdict],
    };
  }

  // A trigger-type delivery arrived and has not been routed yet. Not silence:
  // the webhook landed, so the miss this ladder is diagnosing did not happen.
  if (rows.some((r) => r.verdict === "awaiting-routing")) {
    return {
      kind: "awaiting-routing",
      isSilence: false,
      detail: VERDICT_DETAIL["awaiting-routing"],
    };
  }

  // Only non-trigger traffic — check_suite receipts and the like. Routine, and
  // it says NOTHING about whether a reviewer-triggering delivery arrived. This
  // must stay silence-permitting: `check_suite` rows accompany almost every
  // push, so counting them as reviewer activity would block the webhook-silence
  // bypass on nearly every genuinely-missed PR, which is the opposite of this
  // command's purpose. (PR #3560 R1 — the earlier code returned a
  // "routing stall" verdict here and flipped `isSilence` to false.)
  return {
    kind: "not-a-review-trigger",
    isSilence: true,
    detail: VERDICT_DETAIL["not-a-review-trigger"],
  };
}

/**
 * The coverage bounds, rendered with the window actually queried.
 *
 * Returned on EVERY call, including calls that found rows. A caller who only
 * sees them on an empty result learns them at the moment they are least likely
 * to be read carefully.
 */
export function buildBounds(since: string): string[] {
  return [
    `Window: deliveries received at or after ${since}. "No record" means no record IN THIS WINDOW.`,
    "A retrigger-initiated review leaves NO row: POST /retrigger synthesises its own delivery id and no receipt is inserted (measured: 0 of 36,609 rows). This record shows webhook-triggered attempts only.",
    "Rows are pruned at MINSKY_REVIEWER_WEBHOOK_EVENT_RETENTION_DAYS (default 90). Past that horizon, the reviewer service's deployment logs are the fallback.",
    "error_details.message is best-effort: an octokit HttpError can carry an empty message with the cause only in .stack (2 of 143 rows). Key on `outcome`; read the message as a hint.",
  ];
}

// ---------------------------------------------------------------------------
// Result formatting
// ---------------------------------------------------------------------------

/** Human-readable rendering. Pure: report in, string out, no IO. */
export function formatReviewerEventsReport(report: ReviewerEventsReport): string {
  const { filter, verdict, rows, repoWideFailures, bounds } = report;
  const lines: string[] = [];

  const target =
    filter.owner && filter.repo
      ? `${filter.owner}/${filter.repo}${filter.pr === null ? "" : ` PR #${filter.pr}`}`
      : "(all repos)";
  lines.push(`Reviewer delivery record — ${target}, since ${filter.since}`);
  lines.push("");
  lines.push(`  VERDICT: ${verdict.kind}${verdict.isSilence ? "" : "  (NOT reviewer silence)"}`);
  lines.push(`  ${verdict.detail}`);
  lines.push("");

  if (rows.length === 0) {
    lines.push("  No rows.");
  } else {
    lines.push(`  ${report.rowCount} row(s), newest first:`);
    for (const r of rows) {
      const pr = r.prNumber === null ? "?" : `#${r.prNumber}`;
      lines.push(
        `    ${r.receivedAt}  ${pr.padEnd(7)}${r.eventType.padEnd(24)}${r.outcome.padEnd(20)}${r.verdict}`
      );
      if (r.errorMessage) {
        lines.push(`        ${r.errorStage ?? "?"}: ${r.errorMessage.slice(0, 200)}`);
      } else if (r.errorStage) {
        lines.push(`        ${r.errorStage}: (empty message — cause is in error_details.stack)`);
      }
    }
  }

  if (repoWideFailures.length > 0) {
    lines.push("");
    lines.push("  Repo-wide failure classes in this window (systemic vs single-PR):");
    for (const f of repoWideFailures) {
      lines.push(
        `    ${String(f.count).padStart(4)}x across ${String(f.distinctPrs).padStart(3)} PR(s)  last ${f.lastSeen}  ${f.messagePrefix}`
      );
    }
  }

  lines.push("");
  lines.push("  Bounds — read before treating an empty result as absence:");
  for (const b of bounds) lines.push(`    - ${b}`);

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Row coercion
// ---------------------------------------------------------------------------

function str(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value);
  return s.length === 0 ? null : s;
}

/**
 * Coerce a jsonb-extracted value to an integer, or null.
 *
 * The empty-string guard is load-bearing, not defensive noise: `Number("")` is
 * **0**, and `Number.isFinite(0)` is true, so without it an absent PR number
 * that surfaced as `""` rather than NULL would become a valid-looking
 * `prNumber: 0` — rendered as `#0`, and counted by the repo-wide
 * `count(DISTINCT …)`. The `->>` operator should yield NULL for a missing path,
 * but this reads jsonb across four heterogeneous event shapes and a driver or
 * row-shaping change is exactly the kind of thing that surfaces `""` instead.
 * A wrong zero is worse than a null here because it looks like data.
 * (PR #3560 R1.)
 */
function int(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

/**
 * A PR number is 1-based, so anything at or below zero is a coercion artifact
 * rather than data. Normalised to null rather than thrown: this command runs
 * while an agent is diagnosing a reviewer outage, and a diagnostic that throws
 * on malformed input takes away the one signal the caller came for.
 */
function prNumberOrNull(value: unknown): number | null {
  const n = int(value);
  return n !== null && n > 0 ? n : null;
}

export function toEventRow(row: Record<string, unknown>): ReviewerEventRow {
  const eventType = str(row["event_type"]) ?? "unknown";
  const outcome = str(row["outcome"]) ?? "unknown";
  const errorMessage = str(row["error_message"]);
  return {
    receivedAt: str(row["received_at"]) ?? "",
    processedAt: str(row["processed_at"]),
    eventType,
    action: str(row["action"]),
    outcome,
    repo: str(row["repo"]),
    prNumber: prNumberOrNull(row["pr_number"]),
    headSha: str(row["head_sha"]),
    errorStage: str(row["error_stage"]),
    errorMessage,
    verdict: classifyEventRow({ eventType, outcome, errorMessage }),
  };
}

// ---------------------------------------------------------------------------
// The query
// ---------------------------------------------------------------------------

export interface ReviewerEventsQuery {
  owner: string | null;
  repo: string | null;
  pr: number | null;
  /** Effective lower bound on `received_at` (ISO 8601). Never null. */
  since: string;
  limit: number;
}

/**
 * The slice of a Drizzle connection this query needs.
 *
 * Narrow on purpose, and the query is a free function rather than a closure
 * inside the command handler, so that `scripts/verify-reviewer-events.ts` can
 * run THIS SQL against the live database. A verification artifact that re-typed
 * the SQL would verify a copy, which is the one thing it must not do
 * (`/implement-task` §7a).
 */
export interface ReviewerEventsDb {
  execute(query: unknown): Promise<unknown>;
}

export async function queryReviewerEvents(
  db: ReviewerEventsDb,
  q: ReviewerEventsQuery
): Promise<ReviewerEventsReport> {
  const { owner, repo: repoName, pr, since, limit } = q;
  const slug = owner && repoName ? `${owner}/${repoName}` : null;

  const { sql } = await import("drizzle-orm");

  // The table carries no owner/repo/pr columns — its only repo and PR signal
  // is inside the raw `body` jsonb, and each event shape puts the PR number
  // somewhere different. A `pull_request`-only extraction reads null for every
  // comment-triggered review, which is precisely the class an agent diagnosing
  // a `/review` comment would be looking for.
  const prExpr = sql`coalesce(
    body->'pull_request'->>'number',
    body->'issue'->>'number',
    body->'check_run'->'pull_requests'->0->>'number',
    body->'check_suite'->'pull_requests'->0->>'number'
  )`;
  const repoExpr = sql`body->'repository'->>'full_name'`;
  const headExpr = sql`coalesce(
    body->'pull_request'->'head'->>'sha',
    body->'check_suite'->>'head_sha',
    body->'check_run'->>'head_sha'
  )`;
  const iso = (col: unknown): unknown =>
    sql`to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`;

  const scopeClause = sql`
    AND received_at >= ${since}::timestamptz
    ${slug ? sql`AND ${repoExpr} = ${slug}` : sql``}
    ${pr === null ? sql`` : sql`AND ${prExpr} = ${String(pr)}`}
  `;

  const rawRows = (await db.execute(sql`
    SELECT
      ${iso(sql`received_at`)}  AS received_at,
      ${iso(sql`processed_at`)} AS processed_at,
      event_type,
      body->>'action'           AS action,
      outcome::text             AS outcome,
      ${repoExpr}               AS repo,
      ${prExpr}                 AS pr_number,
      ${headExpr}               AS head_sha,
      error_details->>'stage'   AS error_stage,
      error_details->>'message' AS error_message
    FROM reviewer_webhook_events
    WHERE TRUE ${scopeClause}
    ORDER BY received_at DESC
    LIMIT ${limit}
  `)) as Array<Record<string, unknown>>;

  const rows = rawRows.map(toEventRow);

  // Repo-wide failure classes: the same query minus the PR filter. This is what
  // separates "the reviewer is down for everyone" (mt#3852: 32 submit 422s
  // across the repo) from "this one PR is too big" (mt#4879: one PR,
  // deterministic) — two findings with the same per-PR signature and very
  // different responses.
  const repoWideFailures: ReviewerFailureClass[] = slug
    ? (
        (await db.execute(sql`
          SELECT
            left(coalesce(nullif(error_details->>'message', ''), '(empty message)'), 80)
                                            AS message_prefix,
            count(*)::int                   AS count,
            count(DISTINCT ${prExpr})::int  AS distinct_prs,
            ${iso(sql`max(received_at)`)}   AS last_seen
          FROM reviewer_webhook_events
          WHERE outcome = 'failed_at_reviewer'
            AND received_at >= ${since}::timestamptz
            AND ${repoExpr} = ${slug}
          GROUP BY 1
          ORDER BY 2 DESC
          LIMIT 10
        `)) as Array<Record<string, unknown>>
      ).map((r) => ({
        messagePrefix: str(r["message_prefix"]) ?? "(empty message)",
        count: int(r["count"]) ?? 0,
        distinctPrs: int(r["distinct_prs"]) ?? 0,
        lastSeen: str(r["last_seen"]) ?? "",
      }))
    : [];

  return {
    filter: { owner, repo: repoName, pr, since },
    verdict: deriveLadderVerdict(rows),
    rowCount: rows.length,
    rows,
    repoWideFailures,
    bounds: buildBounds(since),
  };
}

/** The default window as an ISO timestamp, resolved against the caller's clock. */
export function defaultSince(nowMs: number = Date.now()): string {
  return new Date(nowMs - DEFAULT_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
}

export function registerReviewerEventsCommands(
  _container?: AppContainerInterface,
  registry?: SharedCommandRegistry
): void {
  const targetRegistry = registry ?? sharedCommandRegistry;

  targetRegistry.registerCommand({
    id: "observability.reviewer-events",
    category: CommandCategory.OBSERVABILITY,
    name: "reviewer-events",
    description:
      "Read the reviewer service's per-delivery outcome record (`reviewer_webhook_events`) to " +
      "distinguish 'the reviewer never ran' from 'the reviewer ran and failed'. Both look " +
      "identical to session_pr_wait-for-review, which reports reviewerCheckRunState 'absent' for " +
      "each — and 'absent' is a bypass-merge condition. Returns a per-PR verdict, the classified " +
      "delivery rows, repo-wide failure classes in the window (systemic vs one PR), and the " +
      "coverage bounds that stop an empty result being read as proof of silence. Reads through " +
      "the daemon's existing database connection; no credential is passed by the caller and none " +
      "appears in the output. SELECTs only.",
    parameters: {
      owner: {
        schema: z.string().min(1),
        description: "GitHub repo owner (e.g. 'edobry'). Required to scope to a repo.",
        required: false,
      },
      repo: {
        schema: z.string().min(1),
        description: "GitHub repo name (e.g. 'minsky').",
        required: false,
      },
      pr: {
        schema: z.number().int().min(1),
        description:
          "PR number. Matched across every event shape that carries one — pull_request, " +
          "issue_comment (comment-triggered reviews), check_run and check_suite — because the " +
          "PR number lives at a different JSON path in each.",
        required: false,
      },
      since: {
        schema: z.string(),
        description: `Lower bound on received_at (ISO 8601). Defaults to ${DEFAULT_WINDOW_DAYS} days ago. A bound is always applied and the effective value is echoed in the result, so "no record" is never ambiguous about its window.`,
        required: false,
      },
      limit: {
        schema: z.number().int().min(1).max(MAX_ROWS),
        description: `Maximum delivery rows to return, newest first (default 20, max ${MAX_ROWS}).`,
        required: false,
      },
      json: {
        schema: z.boolean(),
        description: "Return the structured report instead of the human-readable summary.",
        required: false,
      },
    },
    async execute(
      params,
      context
    ): Promise<ReviewerEventsReport | { success: true; text: string }> {
      const persistenceProvider = context.container?.has("persistence")
        ? (context.container.get(
            "persistence"
          ) as import("@minsky/domain/persistence/types").SqlCapablePersistenceProvider)
        : null;

      if (!persistenceProvider) {
        throw new Error(
          "DI container missing 'persistence'. Ensure the container was initialized before " +
            "running this command."
        );
      }

      const db = await persistenceProvider.getDatabaseConnection();
      if (!db) {
        // Deliberately does not name the connection target: a failure message
        // is an output channel, and this one must never carry a URL.
        throw new Error(
          "getDatabaseConnection() returned null. observability.reviewer-events requires a " +
            "PostgreSQL backend with Drizzle ORM."
        );
      }

      const report = await queryReviewerEvents(db, {
        owner: (params.owner as string | undefined) ?? null,
        repo: (params.repo as string | undefined) ?? null,
        pr: (params.pr as number | undefined) ?? null,
        since: (params.since as string | undefined) ?? defaultSince(),
        limit: (params.limit as number | undefined) ?? 20,
      });

      return params.json === true
        ? report
        : { success: true, text: formatReviewerEventsReport(report) };
    },
  });
}
