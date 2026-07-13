/**
 * Reviewer-bot status widget (mt#2076).
 *
 * Answers: "Is the reviewer keeping up, and is it still calibrated?"
 *
 * Data-access is hybrid (per the mt#2075 design doc):
 *   - HTTP GET to reviewer `/health` → liveness, inflightCount, provider, model,
 *     tier2Enabled. Drives A1 (service unreachable).
 *   - Direct Postgres reads (via getSharedPersistenceService) against four
 *     reviewer tables: reviewer_inflight_reviews, reviewer_convergence_metrics,
 *     review_timing, reviewer_webhook_events.
 *
 * CRITICAL implementation notes (verified 2026-06-04):
 *   - reviewer_webhook_events uses `received_at` NOT `created_at`.
 *   - The "Recent mt# tasks reviewed" field reads `head_ref` from
 *     reviewer_convergence_metrics — the new nullable column added in mt#2076
 *     Part A (migration 0005_large_multiple_man.sql). Old rows remain NULL.
 *
 * Follows the `mcp-server-status` widget's testable-factory pattern:
 * pure logic lives in `createReviewerBotStatusWidget(deps)` with injectable IO;
 * the real-wired export `reviewerBotStatusWidget` binds the live probe + DB.
 */

import type { WidgetModule, WidgetContext, WidgetData } from "../types";
import { log } from "@minsky/shared/logger";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Reviewer service health endpoint. The Railway service is named
 * `minsky-reviewer-webhook` (see infra/index.ts), so its generated public
 * domain is `minsky-reviewer-webhook-production.up.railway.app` — verified 200
 * (the bare `minsky-reviewer.up.railway.app` host does not exist). Override in
 * prod via MINSKY_REVIEWER_HEALTH_URL once cockpit env-var IaC lands (mt#2407).
 */
export const REVIEWER_HEALTH_URL =
  process.env.MINSKY_REVIEWER_HEALTH_URL ??
  "https://minsky-reviewer-webhook-production.up.railway.app/health";

/** Probe request timeout. */
const PROBE_TIMEOUT_MS = 5_000;

/** Window for throughput, failure-rate, and latency queries. */
const WINDOW_24H_MS = 24 * 60 * 60 * 1_000;

/** Window for 7-day token/cost medians (mt#2288). */
const WINDOW_7D_MS = 7 * 24 * 60 * 60 * 1_000;

/** A2 — stale in-flight: acquired_at older than this many ms. */
const A2_STALE_INFLIGHT_TTL_MS = 10 * 60 * 1_000; // 10 min

/** A2 threshold: at least this many stale in-flight rows fires A2. */
const A2_STALE_INFLIGHT_THRESHOLD = 1;

/** A3 — failure-rate spike: failure fraction exceeding this fires A3. */
const A3_FAILURE_RATE_THRESHOLD = 0.5; // 50 %

/** A3 minimum window size to avoid trivial zero/one-event fractions. */
const A3_MIN_SAMPLE_SIZE = 5;

/** A4 — latency regression: P95 exceeding this fires A4. */
const A4_LATENCY_P95_MS_THRESHOLD = 120_000; // 120 s

/** A5 — cost trend: 24h median cost diverging from the 7d median by more than
 * this fraction fires A5 (mt#2288). */
const A5_COST_TREND_THRESHOLD = 0.5; // 50 %

/** A6 — verdict drift: any verdict's 24h ratio diverging from its 7d ratio by
 * more than this many percentage points fires A6 (mt#2287). */
const A6_VERDICT_DRIFT_THRESHOLD = 0.2; // 20 percentage points

/** A6 minimum sample size (per window) to avoid trivial zero/one-event drift
 * on low-volume windows — mirrors the A3_MIN_SAMPLE_SIZE pattern. */
const A6_MIN_SAMPLE_SIZE = 3;

/** Number of recent mt# task IDs to surface. */
const RECENT_TASKS_LIMIT = 5;

/**
 * Max stats queries in flight at once (mt#2765). Kept well under the shared
 * provider pool's max (15, postgres-provider.ts DEFAULT_POSTGRES_MAX_CONNECTIONS):
 * more than pool-max concurrent queries wedge postgres-js against the Supabase
 * transaction pooler (queries queue client-side and never settle), and this
 * widget's 15-query fan-out was exactly pool max — one racing sweeper query or a
 * second fetch pushed it over. Concurrent fetches are additionally single-flighted
 * in the widget factory so cross-request fan-out cannot multiply.
 */
const QUERY_CONCURRENCY_LIMIT = 4;

/**
 * Deadline for the whole DB-stats phase (mt#2765). On expiry the fetch returns
 * db:null (fields render as "—") with a rate-limited warn instead of holding
 * the HTTP request open indefinitely.
 */
const DB_STATS_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// Regex for extracting Minsky task IDs from branch names.
// Replicates extractTaskIdFromBranch from services/reviewer/src/server.ts:127
// (cockpit is a separate module graph — the function is trivially replicated).
// Case-insensitive so `Task/MT-123` and `task/mt-123` both parse.
// ---------------------------------------------------------------------------
const BRANCH_TASK_ID_RE = /^task\/mt-(\d+)(?:[-/_.].*)?$/i;

/** Extract a Minsky task ID from a PR head branch name, or return null.
 * Empty-string headRef is treated the same as null (returns null). */
export function extractTaskIdFromBranch(headRef: string | null | undefined): string | null {
  if (!headRef) return null;
  const match = BRANCH_TASK_ID_RE.exec(headRef);
  return match ? `mt#${match[1]}` : null;
}

// ---------------------------------------------------------------------------
// Payload shape (consumed by ReviewerBotStatus.tsx)
// ---------------------------------------------------------------------------

/** Health probe result (from /health HTTP endpoint). */
export interface ReviewerHealthProbeResult {
  ok: boolean;
  statusCode: number | null;
  inflightCount: number | null;
  provider: string | null;
  model: string | null;
  tier2Enabled: boolean | null;
}

/**
 * Verdict counts, keyed by GitHub review event (lowercased, camelCase for
 * request_changes). Mirrors the `verdict` column's accepted values on
 * reviewer_convergence_metrics (mt#2287).
 */
export interface VerdictCounts {
  approve: number;
  requestChanges: number;
  comment: number;
}

/** DB-backed statistics (from direct Postgres queries). */
export interface ReviewerDbStats {
  /** Review count in the last 24h (throughput). */
  reviewCount24h: number;
  /** Count of failed webhook events in the last 24h. */
  failureCount24h: number;
  /** Last error details string or null. */
  lastError: string | null;
  /** Recent mt# task IDs from head_ref on reviewer_convergence_metrics. */
  recentTaskIds: string[];
  /** Average total_wall_clock_ms over the last 24h (ms), or null. */
  avgLatencyMs: number | null;
  /** P95 total_wall_clock_ms over the last 24h (ms), or null. */
  p95LatencyMs: number | null;
  /** Count of stale in-flight reviews (acquired_at > A2_STALE_INFLIGHT_TTL_MS ago). */
  staleInflightCount: number;
  /** Count of rate-limit hits in the last 24h (from retry_outcomes). */
  rateLimitHitCount24h: number;
  /** ISO timestamp of the last received webhook event, or null. */
  lastWebhookReceivedAt: string | null;
  /** Median total tokens (input+output) per model-invoking review, last 24h (mt#2288). */
  medianTokens24h: number | null;
  /** Median total tokens per model-invoking review, last 7d. */
  medianTokens7d: number | null;
  /** Median USD cost per priced review, last 24h. */
  medianCostUsd24h: number | null;
  /** Median USD cost per priced review, last 7d. */
  medianCostUsd7d: number | null;
  /** Aggregate cache-hit ratio (SUM cached / SUM input tokens) over model-invoking reviews, 24h (mt#2721). */
  cacheHitRatio24h: number | null;
  /** Verdict counts (approve / requestChanges / comment) in the last 24h (mt#2287). */
  verdictCounts24h: VerdictCounts;
  /** Verdict counts (approve / requestChanges / comment) in the last 7d (mt#2287). */
  verdictCounts7d: VerdictCounts;
}

export interface ReviewerBotStatusPayload {
  /** Core liveness (from /health probe). */
  health: {
    ok: boolean;
    statusCode: number | null;
    lastProbeAt: string;
    /** In-flight review count from the /health endpoint (real-time). */
    inflightCount: number | null;
    provider: string | null;
    model: string | null;
    tier2Enabled: boolean | null;
  };
  /** Postgres-backed statistics. Null when the DB is unreachable. */
  db: ReviewerDbStats | null;
  anomalies: {
    /** A1 — reviewer /health returned non-200 or timed out. */
    a1ServiceUnreachable: boolean;
    /** A2 — stale in-flight marker(s) (stuck review / crashed worker). */
    a2StaleInflight: boolean;
    /** A3 — failure-rate spike (>50% failures in last 24h, sample ≥5). */
    a3FailureRateSpike: boolean;
    /** A4 — latency regression (P95 > 120s in last 24h). */
    a4LatencyRegression: boolean;
    /** A5 — cost trend: 24h median cost diverged >50% from 7d median cost (mt#2288). */
    a5CostTrend: boolean;
    /** A6 — verdict drift: any verdict's 24h ratio diverged >20pp from its 7d ratio (mt#2287). */
    a6VerdictDrift: boolean;
  };
}

// ---------------------------------------------------------------------------
// Injectable IO seams
// ---------------------------------------------------------------------------

/**
 * Seam: probe the reviewer /health endpoint. Must resolve (never reject).
 * Returns ok:false when the service is unreachable.
 */
export type ProbeHealthFn = () => Promise<ReviewerHealthProbeResult>;

/**
 * Seam: execute a parameterized SQL query against the shared DB and return rows.
 * The cockpit reads reviewer tables directly (shared Postgres, separate schema).
 * Must resolve (never reject) — returns [] on any error.
 *
 * The `params` array contains positional bind values corresponding to $1, $2, ...
 * placeholders in the SQL string. All values in queries here are
 * internally-generated (ISO timestamps + integer constants), so SQL injection is
 * not a live risk — but we parameterize anyway as a hardening measure and to
 * match pg best practices (future-proofing if user-supplied values are added).
 */
export type QueryRowsFn = (sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;

export interface ReviewerBotStatusDeps {
  probeHealth: ProbeHealthFn;
  queryRows: QueryRowsFn;
  now: () => number;
  /** Test seam: override the DB-stats phase deadline (defaults to DB_STATS_TIMEOUT_MS). */
  dbStatsTimeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Widget factory
// ---------------------------------------------------------------------------

export function createReviewerBotStatusWidget(deps: ReviewerBotStatusDeps): WidgetModule {
  // Single-flight: concurrent fetch() calls share ONE in-flight computation
  // (mt#2765). Without this, every polling client multiplies the query fan-out
  // (N requests x 15 queries) past the shared pool's capacity — and because the
  // cockpit frontend polls without a client-side timeout, hung requests pin the
  // endpoint permanently concurrent. Cleared on settle so sequential polls get
  // fresh data.
  let inflight: Promise<WidgetData> | null = null;

  async function runFetch(): Promise<WidgetData> {
    try {
      const nowMs = deps.now();
      const nowIso = new Date(nowMs).toISOString();

      // 1. Liveness probe (never throws).
      const health = await deps.probeHealth();

      const a1ServiceUnreachable = !health.ok;

      // 2. DB-backed stats (degrade independently to null on any failure),
      //    raced against a hard deadline so a wedged pool can never hold the
      //    request open (mt#2765).
      let db: ReviewerDbStats | null = null;
      const timeoutMs = deps.dbStatsTimeoutMs ?? DB_STATS_TIMEOUT_MS;
      let deadlineHandle: ReturnType<typeof setTimeout> | undefined;
      try {
        const deadline = new Promise<null>((resolve) => {
          deadlineHandle = setTimeout(() => resolve(null), timeoutMs);
          deadlineHandle.unref?.();
        });
        db = await Promise.race([fetchDbStats(deps.queryRows, nowMs), deadline]);
        if (db === null) {
          log.warn(
            `[reviewer-bot-status] DB stats timed out after ${timeoutMs}ms — returning db:null`
          );
        }
      } catch {
        db = null;
      } finally {
        if (deadlineHandle) clearTimeout(deadlineHandle);
      }

      // 3. Anomaly computation.
      const a2StaleInflight = db !== null && db.staleInflightCount >= A2_STALE_INFLIGHT_THRESHOLD;

      const totalEvents24h = db !== null ? db.reviewCount24h + db.failureCount24h : 0;
      const a3FailureRateSpike =
        db !== null &&
        totalEvents24h >= A3_MIN_SAMPLE_SIZE &&
        db.reviewCount24h + db.failureCount24h > 0 &&
        db.failureCount24h / (db.reviewCount24h + db.failureCount24h) > A3_FAILURE_RATE_THRESHOLD;

      const a4LatencyRegression =
        db !== null && db.p95LatencyMs !== null && db.p95LatencyMs > A4_LATENCY_P95_MS_THRESHOLD;

      // A5 — cost trend: 24h median cost diverged >50% from the 7d median (mt#2288).
      // Requires both medians present and a non-zero 7d baseline.
      const a5CostTrend =
        db !== null &&
        db.medianCostUsd24h !== null &&
        db.medianCostUsd7d !== null &&
        db.medianCostUsd7d > 0 &&
        Math.abs(db.medianCostUsd24h - db.medianCostUsd7d) / db.medianCostUsd7d >
          A5_COST_TREND_THRESHOLD;

      // A6 — verdict drift: any verdict's 24h ratio diverged >20pp from its
      // 7d ratio (mt#2287). Gated on both windows having >= A6_MIN_SAMPLE_SIZE
      // verdicts total, mirroring A3's min-sample gate — otherwise a single
      // review in an otherwise-empty window trivially "drifts" 100pp.
      const a6VerdictDrift =
        db !== null &&
        verdictTotal(db.verdictCounts24h) >= A6_MIN_SAMPLE_SIZE &&
        verdictTotal(db.verdictCounts7d) >= A6_MIN_SAMPLE_SIZE &&
        (["approve", "requestChanges", "comment"] as const).some(
          (key) =>
            Math.abs(
              verdictRatio(db.verdictCounts24h, key) - verdictRatio(db.verdictCounts7d, key)
            ) > A6_VERDICT_DRIFT_THRESHOLD
        );

      const payload: ReviewerBotStatusPayload = {
        health: {
          ok: health.ok,
          statusCode: health.statusCode,
          lastProbeAt: nowIso,
          inflightCount: health.inflightCount,
          provider: health.provider,
          model: health.model,
          tier2Enabled: health.tier2Enabled,
        },
        db,
        anomalies: {
          a1ServiceUnreachable,
          a2StaleInflight,
          a3FailureRateSpike,
          a4LatencyRegression,
          a5CostTrend,
          a6VerdictDrift,
        },
      };

      return { state: "ok", payload };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { state: "degraded", reason: `reviewer-bot status error: ${message}` };
    }
  }

  return {
    id: "reviewer-bot-status",
    title: "Reviewer Bot",
    updateMode: { type: "polling", intervalMs: 30_000 },
    async fetch(_ctx: WidgetContext): Promise<WidgetData> {
      if (inflight) return inflight;
      inflight = runFetch();
      try {
        return await inflight;
      } finally {
        inflight = null;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// DB stats query helpers
// ---------------------------------------------------------------------------

/**
 * Compute the ISO timestamp for `windowMs` milliseconds ago.
 * Returns a literal SQL-safe ISO string for use as a query parameter.
 */
function windowStartIso(nowMs: number, windowMs: number): string {
  return new Date(nowMs - windowMs).toISOString();
}

/** Total verdict count across all three classes (mt#2287). */
function verdictTotal(counts: VerdictCounts): number {
  return counts.approve + counts.requestChanges + counts.comment;
}

/** Ratio of one verdict class within its window's total. 0 when the window has no verdicts. */
function verdictRatio(counts: VerdictCounts, key: keyof VerdictCounts): number {
  const total = verdictTotal(counts);
  return total > 0 ? counts[key] / total : 0;
}

/**
 * Run query thunks with at most `limit` in flight, resolving to results in
 * submission order (mt#2765). A thunk that rejects yields `fallback` for its
 * slot — preserving the old Promise.allSettled semantics where one failing
 * query degrades only its own field. Exported for tests.
 */
export async function runQueriesWithLimit<T>(
  thunks: Array<() => Promise<T>>,
  limit: number,
  fallback: T
): Promise<T[]> {
  const results = new Array<T>(thunks.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, thunks.length)) }, async () => {
    while (next < thunks.length) {
      const i = next++;
      const thunk = thunks[i];
      if (!thunk) continue;
      try {
        results[i] = await thunk();
      } catch {
        results[i] = fallback;
      }
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Fetch all DB-backed reviewer stats. Queries run through a bounded-concurrency
 * runner (QUERY_CONCURRENCY_LIMIT, mt#2765) instead of an unbounded
 * Promise.allSettled fan-out — 15 parallel queries was exactly the shared
 * pool's max and wedged it whenever anything else raced. Each query still
 * degrades independently: a failing query yields [] for only THAT field.
 *
 * Note on parameterization: all bind values ($1, $2) are internally-generated
 * ISO timestamps and integer constants — not user-supplied input. We
 * parameterize anyway per pg best practices and for future-proofing.
 */
async function fetchDbStats(queryRows: QueryRowsFn, nowMs: number): Promise<ReviewerDbStats> {
  const window24hIso = windowStartIso(nowMs, WINDOW_24H_MS);
  const window7dIso = windowStartIso(nowMs, WINDOW_7D_MS);
  const staleThresholdIso = windowStartIso(nowMs, A2_STALE_INFLIGHT_TTL_MS);

  const queryThunks: Array<() => Promise<Record<string, unknown>[]>> = [
    // Throughput: count of review_submitted outcomes in the last 24h
    () =>
      queryRows(
        `SELECT COUNT(*) AS count FROM reviewer_webhook_events
       WHERE outcome = 'review_submitted' AND received_at >= $1`,
        [window24hIso]
      ),
    // Failure count: any failed_at_* outcomes in the last 24h. `outcome` is the
    // webhook_outcome ENUM — Postgres has no LIKE operator for enums, so the
    // column must be cast to text for the pattern match (without the cast the
    // query errors and the runner silently zeroes the field, breaking A3).
    () =>
      queryRows(
        `SELECT COUNT(*) AS count FROM reviewer_webhook_events
       WHERE outcome::text LIKE 'failed_at_%' AND received_at >= $1`,
        [window24hIso]
      ),
    // Last error: most recent failed event details (same enum::text cast)
    () =>
      queryRows(
        `SELECT error_details, received_at FROM reviewer_webhook_events
       WHERE outcome::text LIKE 'failed_at_%' AND received_at >= $1
       ORDER BY received_at DESC LIMIT 1`,
        [window24hIso]
      ),
    // Recent mt# tasks: head_ref from convergence metrics (new column, may be NULL on old rows).
    // Empty-string head_ref is excluded by the != '' filter at the DB level.
    // Use subquery form so we can ORDER BY the aggregate without DISTINCT conflict.
    () =>
      queryRows(
        `SELECT head_ref FROM (
         SELECT head_ref, MAX(created_at) AS last_seen
         FROM reviewer_convergence_metrics
         WHERE head_ref IS NOT NULL AND head_ref != '' AND head_ref LIKE 'task/mt-%'
         GROUP BY head_ref
         ORDER BY last_seen DESC
         LIMIT $1
       ) subq`,
        [RECENT_TASKS_LIMIT]
      ),
    // Latency: avg + percentile over last 24h
    () =>
      queryRows(
        `SELECT
         AVG(total_wall_clock_ms)::integer AS avg_ms,
         PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY total_wall_clock_ms)::integer AS p95_ms
       FROM review_timing
       WHERE created_at >= $1`,
        [window24hIso]
      ),
    // Stale in-flight: markers acquired more than A2_STALE_INFLIGHT_TTL_MS ago
    () =>
      queryRows(
        `SELECT COUNT(*) AS count FROM reviewer_inflight_reviews
       WHERE acquired_at <= $1`,
        [staleThresholdIso]
      ),
    // Rate-limit hits: count 'rate_limited' entries across all rows'
    // retry_outcomes (text[]) in the window, via explicit CROSS JOIN LATERAL
    // with a named column alias — unambiguous set-returning-function form.
    // retry_outcomes is NOT NULL DEFAULT '{}', so an empty array contributes
    // 0 rows (correctly 0 hits).
    () =>
      queryRows(
        `SELECT COUNT(*) AS count
       FROM review_timing rt
       CROSS JOIN LATERAL unnest(rt.retry_outcomes) AS ro(outcome)
       WHERE rt.created_at >= $1 AND ro.outcome = 'rate_limited'`,
        [window24hIso]
      ),
    // Last webhook received
    () =>
      queryRows(
        `SELECT received_at FROM reviewer_webhook_events
       ORDER BY received_at DESC LIMIT 1`
      ),
    // mt#2288: median total tokens (input+output) per model-invoking review, 24h.
    // Filter to rows with token data — the two pre-model skip paths write NULL
    // tokens and must not skew the median. PERCENTILE_DISC returns an actual
    // observed integer token total (no interpolation → no fractional/cast surprise).
    () =>
      queryRows(
        `SELECT PERCENTILE_DISC(0.5) WITHIN GROUP (ORDER BY (input_tokens + output_tokens)) AS median_tokens
       FROM review_timing
       WHERE created_at >= $1 AND input_tokens IS NOT NULL AND output_tokens IS NOT NULL`,
        [window24hIso]
      ),
    // mt#2288: median total tokens per model-invoking review, 7d.
    () =>
      queryRows(
        `SELECT PERCENTILE_DISC(0.5) WITHIN GROUP (ORDER BY (input_tokens + output_tokens)) AS median_tokens
       FROM review_timing
       WHERE created_at >= $1 AND input_tokens IS NOT NULL AND output_tokens IS NOT NULL`,
        [window7dIso]
      ),
    // mt#2288: median USD cost per priced review, 24h (cost_usd NULL when the
    // model is unpriced — excluded so the median reflects only priced reviews).
    () =>
      queryRows(
        `SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY cost_usd)::numeric AS median_cost
       FROM review_timing
       WHERE created_at >= $1 AND cost_usd IS NOT NULL`,
        [window24hIso]
      ),
    // mt#2288: median USD cost per priced review, 7d.
    () =>
      queryRows(
        `SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY cost_usd)::numeric AS median_cost
       FROM review_timing
       WHERE created_at >= $1 AND cost_usd IS NOT NULL`,
        [window7dIso]
      ),
    // mt#2721: aggregate cache-hit ratio (cached/input) over cache-reporting
    // reviews in 24h. SUM/SUM (not avg-of-ratios) reflects how much of the real
    // input volume was served from cache. Scoped to `cached_tokens IS NOT NULL`
    // so providers that don't report caching (Anthropic/Google rows, where the
    // column is NULL) don't dilute the ratio and understate OpenAI's cache
    // effectiveness. NULLIF guards divide-by-zero.
    () =>
      queryRows(
        `SELECT SUM(cached_tokens)::float8 / NULLIF(SUM(input_tokens), 0) AS cache_hit_ratio
       FROM review_timing
       WHERE created_at >= $1 AND input_tokens IS NOT NULL AND cached_tokens IS NOT NULL`,
        [window24hIso]
      ),
    // mt#2287: verdict distribution, 24h. Nullable `verdict` column (mt#2287
    // migration) — rows written before that migration retain NULL and are
    // excluded so the distribution reflects only reviews with a known verdict.
    () =>
      queryRows(
        `SELECT verdict, COUNT(*) AS count FROM reviewer_convergence_metrics
       WHERE verdict IS NOT NULL AND created_at >= $1
       GROUP BY verdict`,
        [window24hIso]
      ),
    // mt#2287: verdict distribution, 7d (baseline for the drift comparison).
    () =>
      queryRows(
        `SELECT verdict, COUNT(*) AS count FROM reviewer_convergence_metrics
       WHERE verdict IS NOT NULL AND created_at >= $1
       GROUP BY verdict`,
        [window7dIso]
      ),
  ];

  const settled = await runQueriesWithLimit(
    queryThunks,
    QUERY_CONCURRENCY_LIMIT,
    [] as Record<string, unknown>[]
  );
  const throughputRows = settled[0] ?? [];
  const failureRows = settled[1] ?? [];
  const lastErrorRows = settled[2] ?? [];
  const recentTaskRows = settled[3] ?? [];
  const latencyRows = settled[4] ?? [];
  const staleInflightRows = settled[5] ?? [];
  const rateLimitRows = settled[6] ?? [];
  const lastWebhookRows = settled[7] ?? [];
  const medianTokens24hRows = settled[8] ?? [];
  const medianTokens7dRows = settled[9] ?? [];
  const medianCost24hRows = settled[10] ?? [];
  const medianCost7dRows = settled[11] ?? [];
  const cacheHitRows = settled[12] ?? [];
  const verdictRows24h = settled[13] ?? [];
  const verdictRows7d = settled[14] ?? [];

  const reviewCount24h = Number(throughputRows[0]?.["count"] ?? 0);
  const failureCount24h = Number(failureRows[0]?.["count"] ?? 0);

  // Last error: stringify error_details JSON or null
  const lastErrorRow = lastErrorRows[0];
  let lastError: string | null = null;
  if (lastErrorRow) {
    const errorDetails = lastErrorRow["error_details"];
    if (errorDetails !== null && errorDetails !== undefined) {
      try {
        lastError =
          typeof errorDetails === "string"
            ? errorDetails
            : JSON.stringify(errorDetails).slice(0, 200);
      } catch {
        lastError = String(errorDetails).slice(0, 200);
      }
    }
  }

  // Recent task IDs: extract mt# from head_ref values.
  // extractTaskIdFromBranch already handles empty strings (returns null).
  const recentTaskIds = (recentTaskRows ?? [])
    .map((row) => {
      const ref = row["head_ref"];
      return typeof ref === "string" ? extractTaskIdFromBranch(ref) : null;
    })
    .filter((id): id is string => id !== null)
    .slice(0, RECENT_TASKS_LIMIT);

  const latencyRow = latencyRows[0];
  const avgLatencyMs = latencyRow?.["avg_ms"] != null ? Number(latencyRow["avg_ms"]) : null;
  const p95LatencyMs = latencyRow?.["p95_ms"] != null ? Number(latencyRow["p95_ms"]) : null;

  const staleInflightCount = Number(staleInflightRows[0]?.["count"] ?? 0);
  const rateLimitHitCount24h = Number(rateLimitRows[0]?.["count"] ?? 0);

  const lastWebhookRow = lastWebhookRows[0];
  const lastWebhookReceivedAt =
    lastWebhookRow?.["received_at"] != null ? String(lastWebhookRow["received_at"]) : null;

  // mt#2288: token/cost medians. PERCENTILE_CONT over an empty/all-NULL set
  // returns NULL, which parses to null (no data → "—" in the widget).
  const medianTokens24h =
    medianTokens24hRows[0]?.["median_tokens"] != null
      ? Number(medianTokens24hRows[0]["median_tokens"])
      : null;
  const medianTokens7d =
    medianTokens7dRows[0]?.["median_tokens"] != null
      ? Number(medianTokens7dRows[0]["median_tokens"])
      : null;
  const medianCostUsd24h =
    medianCost24hRows[0]?.["median_cost"] != null
      ? Number(medianCost24hRows[0]["median_cost"])
      : null;
  const medianCostUsd7d =
    medianCost7dRows[0]?.["median_cost"] != null
      ? Number(medianCost7dRows[0]["median_cost"])
      : null;
  const cacheHitRatio24h =
    cacheHitRows[0]?.["cache_hit_ratio"] != null
      ? Number(cacheHitRows[0]["cache_hit_ratio"])
      : null;

  // mt#2287: verdict distribution. Each row is { verdict: "approve" |
  // "request_changes" | "comment", count: <n> }; unrecognized verdict values
  // (defensive — schema comment documents the accepted set) are ignored.
  const verdictCounts24h = extractVerdictCounts(verdictRows24h);
  const verdictCounts7d = extractVerdictCounts(verdictRows7d);

  return {
    reviewCount24h,
    failureCount24h,
    lastError,
    recentTaskIds,
    avgLatencyMs,
    p95LatencyMs,
    staleInflightCount,
    rateLimitHitCount24h,
    lastWebhookReceivedAt,
    medianTokens24h,
    medianTokens7d,
    medianCostUsd24h,
    medianCostUsd7d,
    cacheHitRatio24h,
    verdictCounts24h,
    verdictCounts7d,
  };
}

/**
 * Build a VerdictCounts object from GROUP-BY-verdict query rows.
 * Unrecognized verdict values are ignored defensively — the schema comment
 * on reviewer_convergence_metrics.verdict documents the accepted set
 * (approve / request_changes / comment / NULL); NULL rows are already
 * excluded by the query's WHERE clause.
 */
function extractVerdictCounts(rows: Record<string, unknown>[]): VerdictCounts {
  const counts: VerdictCounts = { approve: 0, requestChanges: 0, comment: 0 };
  for (const row of rows) {
    const verdict = row["verdict"];
    const count = Number(row["count"] ?? 0);
    if (verdict === "approve") counts.approve = count;
    else if (verdict === "request_changes") counts.requestChanges = count;
    else if (verdict === "comment") counts.comment = count;
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Real-wired probe implementation
// ---------------------------------------------------------------------------

/**
 * HTTP GET to the reviewer /health endpoint with abort timeout. Never rejects.
 * Parses inflightCount, provider, model, tier2Enabled from the JSON body.
 */
async function probeReviewerHealth(): Promise<ReviewerHealthProbeResult> {
  try {
    const res = await fetch(REVIEWER_HEALTH_URL, {
      method: "GET",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });

    if (res.status !== 200) {
      return {
        ok: false,
        statusCode: res.status,
        inflightCount: null,
        provider: null,
        model: null,
        tier2Enabled: null,
      };
    }

    let body: Record<string, unknown> = {};
    try {
      body = (await res.json()) as Record<string, unknown>;
    } catch {
      // Non-JSON body — health OK but can't extract fields.
    }

    return {
      ok: true,
      statusCode: 200,
      inflightCount: body["inflightCount"] != null ? Number(body["inflightCount"]) : null,
      provider: body["provider"] != null ? String(body["provider"]) : null,
      model: body["model"] != null ? String(body["model"]) : null,
      tier2Enabled: body["tier2Enabled"] != null ? Boolean(body["tier2Enabled"]) : null,
    };
  } catch {
    // Network failure, timeout, DNS — unreachable.
    return {
      ok: false,
      statusCode: null,
      inflightCount: null,
      provider: null,
      model: null,
      tier2Enabled: null,
    };
  }
}

/**
 * Minimal shape of the postgres-js `Sql` instance this widget needs. Raw
 * string queries MUST go through `sql.unsafe(query, params)`; calling the
 * instance as a plain function throws NOT_TAGGED_CALL (it is a tagged-template
 * function). The resolved value is the row ARRAY (postgres-js RowList), NOT
 * `{ rows }`. Both mistakes shipped in the original mt#2076 wiring and made
 * every DB field render as zero since birth (mt#2757). Vendor reference:
 * node_modules/postgres/README.md §"Advanced unsafe use cases".
 */
export interface RawSqlLike {
  unsafe: (query: string, params?: unknown[]) => PromiseLike<unknown>;
}

/** The slice of PersistenceProvider that buildQueryRows consumes. */
export interface RawSqlProviderLike {
  getRawSqlConnection?: () => Promise<unknown>;
}

/** Rate-limit window for query-failure warn logs — one line per window, not
 * 15 lines per 30s poll cycle. */
const QUERY_WARN_SUPPRESS_MS = 60_000;

let _lastQueryWarnAtMs = 0;

/** Rate-limited warn for reviewer DB query failures (mt#2757: the previous
 * fully-silent catch made a total query-layer failure indistinguishable from
 * "no data"). */
function warnQueryFailure(err: unknown): void {
  const nowMs = Date.now();
  if (nowMs - _lastQueryWarnAtMs < QUERY_WARN_SUPPRESS_MS) return;
  _lastQueryWarnAtMs = nowMs;
  const message = err instanceof Error ? err.message : String(err);
  log.warn(
    `[reviewer-bot-status] reviewer DB query failed (repeats suppressed ${QUERY_WARN_SUPPRESS_MS / 1000}s): ${message}`
  );
}

/**
 * Wrap a postgres-js-like connection into a QueryRowsFn. Exported as a seam so
 * tests can verify the wiring shape (`.unsafe` call, array result) that the
 * original implementation got wrong (mt#2757).
 */
export function createUnsafeQueryRows(
  rawSql: RawSqlLike,
  warn: (err: unknown) => void = warnQueryFailure
): QueryRowsFn {
  return async (query: string, params?: unknown[]): Promise<Record<string, unknown>[]> => {
    try {
      const rows = await rawSql.unsafe(query, params);
      return (Array.isArray(rows) ? rows : []) as Record<string, unknown>[];
    } catch (err) {
      warn(err);
      return [];
    }
  };
}

async function defaultLoadProvider(): Promise<RawSqlProviderLike> {
  const { getSharedPersistenceService } = await import("../shared-persistence");
  const svc = await getSharedPersistenceService();
  return svc.getProvider() as RawSqlProviderLike;
}

/**
 * Build the queryRows dep from the shared PersistenceService. Exported with an
 * injectable provider-loader seam for tests (mt#2757 — the previous private,
 * untested version is exactly where the never-worked wiring hid).
 *
 * The former drizzle `getDatabaseConnection` fallback was removed: drizzle's
 * `execute()` does not accept `(string, params[])` either, and the postgres
 * provider always exposes `getRawSqlConnection` — the fallback was
 * dead-and-broken code. Providers without raw SQL (e.g. SQLite) degrade to
 * empty results: the reviewer tables live in the shared Postgres only.
 */
export async function buildQueryRows(
  loadProvider: () => Promise<RawSqlProviderLike> = defaultLoadProvider
): Promise<QueryRowsFn> {
  try {
    const provider = await loadProvider();
    if (typeof provider.getRawSqlConnection === "function") {
      const rawSql = (await provider.getRawSqlConnection()) as RawSqlLike | null;
      if (rawSql && typeof rawSql.unsafe === "function") {
        return createUnsafeQueryRows(rawSql);
      }
    }
    log.debug("[reviewer-bot-status] provider has no raw SQL connection; DB stats disabled");
    return async (_query: string, _params?: unknown[]) => [];
  } catch (err) {
    warnQueryFailure(err);
    return async (_query: string, _params?: unknown[]) => [];
  }
}

// ---------------------------------------------------------------------------
// Real-wired export
// ---------------------------------------------------------------------------

/**
 * Lazily-built queryRows dep — computed once on first fetch, then cached.
 * Avoids paying the PersistenceService init cost at import time (cockpit
 * boot doesn't know if this default-disabled widget will actually be used).
 */
let _cachedQueryRows: QueryRowsFn | null = null;

async function getQueryRows(): Promise<QueryRowsFn> {
  if (_cachedQueryRows) return _cachedQueryRows;
  _cachedQueryRows = await buildQueryRows();
  return _cachedQueryRows;
}

export const reviewerBotStatusWidget: WidgetModule = createReviewerBotStatusWidget({
  probeHealth: probeReviewerHealth,
  queryRows: async (sql: string, params?: unknown[]) => {
    const queryFn = await getQueryRows();
    return queryFn(sql, params);
  },
  now: () => Date.now(),
});
