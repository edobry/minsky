/**
 * Reviewer-cost reporting command (mt#4546).
 *
 * `observability.reviewer-cost` — reports reviewer LLM spend from the
 * `review_timing` table, which is the only place spend is attributable to a
 * PR, a round, or a scope class. OpenAI's own usage dashboard reports by model
 * and project and structurally cannot answer those questions.
 *
 * **Why this command exists.** Before it, nothing registered could read the
 * table: every reader (`src/cockpit/widgets/reviewer-bot-status.ts`, the
 * reviewer service, `services/reviewer/scripts/*.ts`) resolves its handle
 * through `services/reviewer/src/db/client.ts`, i.e.
 * `MINSKY_PERSISTENCE_POSTGRES_URL` from `process.env`. So measuring reviewer
 * spend required whoever was asking to hold a Postgres URL in their shell,
 * which is why it had been measured twice in three weeks (mt#3659) and not
 * since. That variable is the same canonical name the domain container uses,
 * so the daemon is already connected to this database — the gap was a command
 * surface, not a connection.
 *
 * **Access path.** Resolves the persistence provider from `context.container`
 * at execute time (the `guard-events.ts` / `transcripts.ts` pattern), then
 * reads through the existing connection. This MATCHES the access decision
 * already recorded in the Notion design doc "cockpit reviewer-bot + MCP-server
 * status pages" (2026-06-03): *"the cockpit widget can either (a) reuse the
 * same Drizzle client with raw reviewer schemas imported, or (b) instantiate a
 * second Drizzle client … (a) is preferred for simplicity."* No second
 * connection string, and no credential passed by the caller.
 *
 * **Two data hazards this query handles, both learned the hard way:**
 *
 *  1. `iteration_index = 0` rows are the pre-model skip paths (routing-skip,
 *     concurrent-inflight). They carry no token data, and mem#800 records that
 *     including them "skews every split." Excluded from every statistic; their
 *     count is reported separately so the exclusion is visible rather than
 *     silent.
 *  2. `cached_tokens IS NULL` was a real defect (mt#3665: chunked reviews
 *     recorded no cached count, and `computeCostUsd` priced a null as 0%
 *     cached, inflating those rows ~4x). It is fixed, but historical rows
 *     remain, and a window spanning the fix is not comparable on any statistic
 *     that includes them. The count is surfaced as `nullCachedRows` so a caller
 *     can see whether the window is contaminated instead of quoting a delta
 *     that silently is.
 *
 * @see mt#3526 — the round-cap diagnosis this measures
 * @see mt#3659 — the production watch that needs these numbers
 * @see mem#800 — the reusable query shapes and the index-0 warning
 */
import { z } from "zod";
import { sharedCommandRegistry, CommandCategory } from "../command-registry";
import type { SharedCommandRegistry } from "../command-registry";
import type { AppContainerInterface } from "@minsky/domain/composition/types";

/**
 * The reviewer's tool-loop cap, from `services/reviewer/src/providers.ts:430`
 * (`const MAX_TOOL_ROUNDS = 10`). A row whose `per_round_latencies_ms` array is
 * at least this long spent every available round — mt#3526 measured that class
 * at 83% of calls and 67% of spend.
 *
 * Duplicated rather than imported: `services/reviewer` is a separate workspace
 * with its own tsconfig, and this command must not take a build dependency on
 * it to read one integer. The cost of drift is a mislabelled bucket, not a
 * wrong total, and `atRoundCap.capValue` is reported so a reader can see which
 * value produced the number.
 */
const REVIEWER_MAX_TOOL_ROUNDS = 10;

/** Per-round-bucket statistics. All costs in USD. */
export interface ReviewerCostBucket {
  calls: number;
  medianInputTokens: number | null;
  medianUncachedInputTokens: number | null;
  meanCostUsd: number | null;
  medianCostUsd: number | null;
  totalCostUsd: number;
}

export interface ReviewerCostReport {
  window: { since: string | null; until: string | null };
  totals: {
    calls: number;
    distinctPrs: number;
    totalCostUsd: number;
    /** Distinct UTC days with at least one call — the divisor for costPerDay. */
    activeDays: number;
    costPerActiveDay: number | null;
  };
  /**
   * Rows excluded from every statistic above, reported so the exclusion is
   * visible. `indexZeroRows` and `nullTokenRows` are excluded; `nullCachedRows`
   * are INCLUDED in the totals but flagged, because their cost is mis-priced
   * (mt#3665) and a window containing them is not comparable to one that does
   * not.
   */
  excluded: {
    indexZeroRows: number;
    nullTokenRows: number;
    nullCachedRows: number;
  };
  /** R1 = first review of a head; R>=2 = re-reviews. Index-0 rows excluded. */
  rounds: { r1: ReviewerCostBucket; rGe2: ReviewerCostBucket };
  /** Mean of per-row cached_tokens / input_tokens. Null when no priced rows. */
  cacheHitRatio: number | null;
  atRoundCap: {
    capValue: number;
    calls: number;
    shareOfCalls: number | null;
    totalCostUsd: number;
    shareOfCost: number | null;
    /**
     * Median summed input tokens for the at-cap cohort specifically — NOT the
     * same statistic as `rounds.*.medianInputTokens`, which buckets by review
     * iteration rather than by round exhaustion. mt#3654 pre-registered this
     * one against a baseline of 446,484 (mt#3547 §Closeout), so it has to be
     * readable on its own rather than inferred from the R1/R>=2 split.
     */
    medianInputTokens: number | null;
  };
  perDay: Array<{ day: string; calls: number; costUsd: number }>;
}

/** Coerce a possibly-null numeric/bigint column to a number. */
function num(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Coerce to a number, defaulting to 0 — for counts and sums that cannot be null. */
function numOr0(value: unknown): number {
  return num(value) ?? 0;
}

// ---------------------------------------------------------------------------
// Result formatting
// ---------------------------------------------------------------------------

/** Render a USD amount, or an em dash when the statistic has no priced rows. */
function usd(value: number | null): string {
  return value === null ? "—" : `$${value.toFixed(4)}`;
}

/** Render a 0..1 ratio as a percentage, or an em dash when undefined. */
function pct(value: number | null): string {
  return value === null ? "—" : `${(value * 100).toFixed(1)}%`;
}

/** Render a token count with thousands separators, or an em dash. */
function tokens(value: number | null): string {
  return value === null ? "—" : Math.round(value).toLocaleString("en-US");
}

/**
 * Human-readable rendering of a {@link ReviewerCostReport}.
 *
 * Pure: takes a report, returns a string, touches no IO. That is what makes it
 * unit-testable without a database — the DB-backed query needs a live run, but
 * the presentation of its result does not, and the two failure modes are
 * independent (`/implement-task` §6 testable-design checkpoint).
 *
 * **The contamination counters are rendered unconditionally, including when
 * zero.** A window with no mis-priced rows and a window whose counter was
 * simply never displayed look identical otherwise, and the entire point of
 * surfacing `nullCachedRows` (mt#3665) is that a reader can tell a comparable
 * window from a contaminated one at a glance.
 */
export function formatReviewerCostReport(report: ReviewerCostReport): string {
  const { window, totals, excluded, rounds, atRoundCap, perDay } = report;
  const lines: string[] = [];

  const from = window.since ?? "(no lower bound)";
  const to = window.until ?? "(no upper bound)";
  lines.push(`Reviewer cost — ${from} → ${to}`);
  lines.push("");

  lines.push(
    `  ${totals.calls.toLocaleString("en-US")} priced calls across ` +
      `${totals.distinctPrs.toLocaleString("en-US")} PRs over ${totals.activeDays} active day(s)`
  );
  lines.push(
    `  Total: ${usd(totals.totalCostUsd)}   Per active day: ${usd(totals.costPerActiveDay)}`
  );
  lines.push(`  Cache-hit ratio: ${pct(report.cacheHitRatio)}`);
  lines.push("");

  lines.push("  Excluded / flagged rows");
  lines.push(`    iteration_index = 0 (pre-model skip paths, excluded): ${excluded.indexZeroRows}`);
  lines.push(`    null input_tokens (excluded):                         ${excluded.nullTokenRows}`);
  lines.push(
    `    null cached_tokens (INCLUDED but mis-priced, mt#3665):  ${excluded.nullCachedRows}${
      excluded.nullCachedRows > 0 ? "  <- window is NOT comparable to one without these" : ""
    }`
  );
  lines.push("");

  lines.push("  Round split                    R1              R>=2");
  const row = (label: string, a: string, b: string): string =>
    `    ${label.padEnd(27)}${a.padEnd(16)}${b}`;
  lines.push(row("calls", String(rounds.r1.calls), String(rounds.rGe2.calls)));
  lines.push(
    row(
      "median input tokens",
      tokens(rounds.r1.medianInputTokens),
      tokens(rounds.rGe2.medianInputTokens)
    )
  );
  lines.push(
    row(
      "median uncached tokens",
      tokens(rounds.r1.medianUncachedInputTokens),
      tokens(rounds.rGe2.medianUncachedInputTokens)
    )
  );
  lines.push(row("mean cost", usd(rounds.r1.meanCostUsd), usd(rounds.rGe2.meanCostUsd)));
  lines.push(row("median cost", usd(rounds.r1.medianCostUsd), usd(rounds.rGe2.medianCostUsd)));
  lines.push(row("total cost", usd(rounds.r1.totalCostUsd), usd(rounds.rGe2.totalCostUsd)));
  lines.push("");

  lines.push(
    `  At the ${atRoundCap.capValue}-round tool-loop cap: ${atRoundCap.calls} calls ` +
      `(${pct(atRoundCap.shareOfCalls)} of calls), ${usd(atRoundCap.totalCostUsd)} ` +
      `(${pct(atRoundCap.shareOfCost)} of spend)`
  );
  lines.push(`    median input tokens for that cohort: ${tokens(atRoundCap.medianInputTokens)}`);

  if (perDay.length > 0) {
    lines.push("");
    lines.push("  Per day");
    for (const d of perDay) {
      lines.push(`    ${d.day}  ${String(d.calls).padStart(5)} calls  ${usd(d.costUsd)}`);
    }
  }

  return lines.join("\n");
}

export function registerReviewerCostCommands(
  _container?: AppContainerInterface,
  registry?: SharedCommandRegistry
): void {
  const targetRegistry = registry ?? sharedCommandRegistry;

  targetRegistry.registerCommand({
    id: "observability.reviewer-cost",
    category: CommandCategory.OBSERVABILITY,
    name: "reviewer-cost",
    description:
      "Report reviewer LLM spend from `review_timing`: total and per-day cost, the R1 vs R>=2 " +
      "split, median input and uncached-input tokens, cache-hit ratio, and how many calls " +
      "terminated at the tool-loop round cap. Reads through the daemon's existing database " +
      "connection — no credential is passed by the caller and none appears in the output. " +
      "Rows with iteration_index = 0 (pre-model skip paths) are excluded from every statistic " +
      "and counted separately; rows with a null cached_tokens are counted separately because " +
      "their cost is mis-priced (mt#3665) and a window containing them is not comparable.",
    parameters: {
      since: {
        schema: z.string(),
        description:
          "Only include calls created on/after this timestamp (ISO 8601, e.g. " +
          "'2026-08-04T08:07:36Z'). Omit for no lower bound.",
        required: false,
      },
      until: {
        schema: z.string(),
        description:
          "Only include calls created before this timestamp (ISO 8601). Omit for no upper bound.",
        required: false,
      },
      json: {
        schema: z.boolean(),
        description:
          "Return the full structured report instead of the human-readable summary. mt#3654 " +
          "needs to paste actual output into a findings section, so both shapes are supported.",
        required: false,
      },
    },
    async execute(params, context): Promise<ReviewerCostReport | { success: true; text: string }> {
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
          "getDatabaseConnection() returned null. observability.reviewer-cost requires a " +
            "PostgreSQL backend with Drizzle ORM."
        );
      }

      const since = (params.since as string | undefined) ?? null;
      const until = (params.until as string | undefined) ?? null;

      const { sql } = await import("drizzle-orm");

      // One window predicate, reused by every query below so the buckets
      // cannot silently disagree about which rows they cover.
      const windowClause = sql`
        ${since ? sql`AND created_at >= ${since}::timestamptz` : sql``}
        ${until ? sql`AND created_at < ${until}::timestamptz` : sql``}
      `;

      // Priced rows: a real model call with token data. Everything except the
      // `excluded` counters is computed over exactly this population.
      const priced = sql`iteration_index >= 1 AND input_tokens IS NOT NULL`;

      const [totalsRow] = (await db.execute(sql`
        SELECT
          count(*)::int                                        AS calls,
          count(DISTINCT pr_number)::int                       AS distinct_prs,
          coalesce(sum(cost_usd), 0)::float8                   AS total_cost_usd,
          count(DISTINCT date_trunc('day', created_at))::int   AS active_days,
          avg(
            CASE WHEN input_tokens > 0
                 THEN coalesce(cached_tokens, 0)::float8 / input_tokens
            END
          )::float8                                            AS cache_hit_ratio
        FROM review_timing
        WHERE ${priced} ${windowClause}
      `)) as Array<Record<string, unknown>>;

      const [excludedRow] = (await db.execute(sql`
        SELECT
          count(*) FILTER (WHERE iteration_index = 0)::int                       AS index_zero_rows,
          count(*) FILTER (WHERE iteration_index >= 1
                             AND input_tokens IS NULL)::int                      AS null_token_rows,
          count(*) FILTER (WHERE ${priced} AND cached_tokens IS NULL)::int       AS null_cached_rows
        FROM review_timing
        WHERE TRUE ${windowClause}
      `)) as Array<Record<string, unknown>>;

      const roundRows = (await db.execute(sql`
        SELECT
          CASE WHEN iteration_index = 1 THEN 'r1' ELSE 'rGe2' END AS bucket,
          count(*)::int                                            AS calls,
          percentile_cont(0.5) WITHIN GROUP (
            ORDER BY input_tokens
          )::float8                                                AS median_input_tokens,
          percentile_cont(0.5) WITHIN GROUP (
            ORDER BY (input_tokens - coalesce(cached_tokens, 0))
          )::float8                                                AS median_uncached_input_tokens,
          avg(cost_usd)::float8                                    AS mean_cost_usd,
          percentile_cont(0.5) WITHIN GROUP (
            ORDER BY cost_usd
          )::float8                                                AS median_cost_usd,
          coalesce(sum(cost_usd), 0)::float8                       AS total_cost_usd
        FROM review_timing
        WHERE ${priced} ${windowClause}
        GROUP BY 1
      `)) as Array<Record<string, unknown>>;

      // A row's round count is the length of its per-round latency array; a row
      // at or beyond the cap spent every round available to it.
      const [capRow] = (await db.execute(sql`
        SELECT
          count(*)::int                       AS calls,
          coalesce(sum(cost_usd), 0)::float8  AS total_cost_usd,
          percentile_cont(0.5) WITHIN GROUP (
            ORDER BY input_tokens
          )::float8                           AS median_input_tokens
        FROM review_timing
        WHERE ${priced} ${windowClause}
          AND coalesce(array_length(per_round_latencies_ms, 1), 0) >= ${REVIEWER_MAX_TOOL_ROUNDS}
      `)) as Array<Record<string, unknown>>;

      const perDayRows = (await db.execute(sql`
        SELECT
          to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day,
          count(*)::int                                        AS calls,
          coalesce(sum(cost_usd), 0)::float8                   AS cost_usd
        FROM review_timing
        WHERE ${priced} ${windowClause}
        GROUP BY 1
        ORDER BY 1
      `)) as Array<Record<string, unknown>>;

      const emptyBucket = (): ReviewerCostBucket => ({
        calls: 0,
        medianInputTokens: null,
        medianUncachedInputTokens: null,
        meanCostUsd: null,
        medianCostUsd: null,
        totalCostUsd: 0,
      });

      const toBucket = (row: Record<string, unknown> | undefined): ReviewerCostBucket =>
        row
          ? {
              calls: numOr0(row["calls"]),
              medianInputTokens: num(row["median_input_tokens"]),
              medianUncachedInputTokens: num(row["median_uncached_input_tokens"]),
              meanCostUsd: num(row["mean_cost_usd"]),
              medianCostUsd: num(row["median_cost_usd"]),
              totalCostUsd: numOr0(row["total_cost_usd"]),
            }
          : emptyBucket();

      const totalCalls = numOr0(totalsRow?.["calls"]);
      const totalCost = numOr0(totalsRow?.["total_cost_usd"]);
      const activeDays = numOr0(totalsRow?.["active_days"]);
      const capCalls = numOr0(capRow?.["calls"]);
      const capCost = numOr0(capRow?.["total_cost_usd"]);

      const report: ReviewerCostReport = {
        window: { since, until },
        totals: {
          calls: totalCalls,
          distinctPrs: numOr0(totalsRow?.["distinct_prs"]),
          totalCostUsd: totalCost,
          activeDays,
          costPerActiveDay: activeDays > 0 ? totalCost / activeDays : null,
        },
        excluded: {
          indexZeroRows: numOr0(excludedRow?.["index_zero_rows"]),
          nullTokenRows: numOr0(excludedRow?.["null_token_rows"]),
          nullCachedRows: numOr0(excludedRow?.["null_cached_rows"]),
        },
        rounds: {
          r1: toBucket(roundRows.find((r) => r["bucket"] === "r1")),
          rGe2: toBucket(roundRows.find((r) => r["bucket"] === "rGe2")),
        },
        cacheHitRatio: num(totalsRow?.["cache_hit_ratio"]),
        atRoundCap: {
          capValue: REVIEWER_MAX_TOOL_ROUNDS,
          calls: capCalls,
          shareOfCalls: totalCalls > 0 ? capCalls / totalCalls : null,
          totalCostUsd: capCost,
          shareOfCost: totalCost > 0 ? capCost / totalCost : null,
          medianInputTokens: num(capRow?.["median_input_tokens"]),
        },
        perDay: perDayRows.map((r) => ({
          day: String(r["day"]),
          calls: numOr0(r["calls"]),
          costUsd: numOr0(r["cost_usd"]),
        })),
      };

      // Default is the human-readable summary; `json: true` returns the full
      // structured report. The structured shape is a superset — nothing in the
      // text is absent from it — so a caller that wants both can ask for JSON
      // and re-render with `formatReviewerCostReport`.
      return params.json === true
        ? report
        : { success: true, text: formatReviewerCostReport(report) };
    },
  });
}
