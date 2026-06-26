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

/** Number of recent mt# task IDs to surface. */
const RECENT_TASKS_LIMIT = 5;

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
}

// ---------------------------------------------------------------------------
// Widget factory
// ---------------------------------------------------------------------------

export function createReviewerBotStatusWidget(deps: ReviewerBotStatusDeps): WidgetModule {
  return {
    id: "reviewer-bot-status",
    title: "Reviewer Bot",
    updateMode: { type: "polling", intervalMs: 30_000 },
    async fetch(_ctx: WidgetContext): Promise<WidgetData> {
      try {
        const nowMs = deps.now();
        const nowIso = new Date(nowMs).toISOString();

        // 1. Liveness probe (never throws).
        const health = await deps.probeHealth();

        const a1ServiceUnreachable = !health.ok;

        // 2. DB-backed stats (degrade independently to null on any failure).
        let db: ReviewerDbStats | null = null;
        try {
          db = await fetchDbStats(deps.queryRows, nowMs);
        } catch {
          db = null;
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
          },
        };

        return { state: "ok", payload };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { state: "degraded", reason: `reviewer-bot status error: ${message}` };
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

/**
 * Fetch all DB-backed reviewer stats. Each query runs independently via
 * Promise.allSettled so one failing query (e.g. PERCENTILE_CONT unsupported
 * on some PG variant) degrades only THAT field — db is still non-null when
 * only some queries fail.
 *
 * Note on parameterization: all bind values ($1, $2) are internally-generated
 * ISO timestamps and integer constants — not user-supplied input. We
 * parameterize anyway per pg best practices and for future-proofing.
 */
async function fetchDbStats(queryRows: QueryRowsFn, nowMs: number): Promise<ReviewerDbStats> {
  const window24hIso = windowStartIso(nowMs, WINDOW_24H_MS);
  const staleThresholdIso = windowStartIso(nowMs, A2_STALE_INFLIGHT_TTL_MS);

  const results = await Promise.allSettled([
    // Throughput: count of review_submitted outcomes in the last 24h
    queryRows(
      `SELECT COUNT(*) AS count FROM reviewer_webhook_events
       WHERE outcome = 'review_submitted' AND received_at >= $1`,
      [window24hIso]
    ),
    // Failure count: any failed_at_* outcomes in the last 24h
    queryRows(
      `SELECT COUNT(*) AS count FROM reviewer_webhook_events
       WHERE outcome LIKE 'failed_at_%' AND received_at >= $1`,
      [window24hIso]
    ),
    // Last error: most recent failed event details
    queryRows(
      `SELECT error_details, received_at FROM reviewer_webhook_events
       WHERE outcome LIKE 'failed_at_%' AND received_at >= $1
       ORDER BY received_at DESC LIMIT 1`,
      [window24hIso]
    ),
    // Recent mt# tasks: head_ref from convergence metrics (new column, may be NULL on old rows).
    // Empty-string head_ref is excluded by the != '' filter at the DB level.
    // Use subquery form so we can ORDER BY the aggregate without DISTINCT conflict.
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
    queryRows(
      `SELECT
         AVG(total_wall_clock_ms)::integer AS avg_ms,
         PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY total_wall_clock_ms)::integer AS p95_ms
       FROM review_timing
       WHERE created_at >= $1`,
      [window24hIso]
    ),
    // Stale in-flight: markers acquired more than A2_STALE_INFLIGHT_TTL_MS ago
    queryRows(
      `SELECT COUNT(*) AS count FROM reviewer_inflight_reviews
       WHERE acquired_at <= $1`,
      [staleThresholdIso]
    ),
    // Rate-limit hits: count 'rate_limited' entries across all rows'
    // retry_outcomes (text[]) in the window. A lateral unnest cross-join is the
    // valid form — the prior `SELECT unnest(...) WHERE unnest = ...` was invalid
    // SQL (can't reference the set-returning fn output by name in WHERE), which
    // rejected the query and zeroed the field. retry_outcomes is NOT NULL
    // DEFAULT '{}', so an empty array contributes 0 rows (correctly 0 hits).
    queryRows(
      `SELECT COUNT(*) AS count
       FROM review_timing rt, unnest(rt.retry_outcomes) AS ro
       WHERE rt.created_at >= $1 AND ro = 'rate_limited'`,
      [window24hIso]
    ),
    // Last webhook received
    queryRows(
      `SELECT received_at FROM reviewer_webhook_events
       ORDER BY received_at DESC LIMIT 1`
    ),
  ]);

  // Extract rows from each settled result — rejected results fall back to [].
  const settled = results.map((r): Record<string, unknown>[] =>
    r.status === "fulfilled" ? r.value : []
  );
  const throughputRows = settled[0] ?? [];
  const failureRows = settled[1] ?? [];
  const lastErrorRows = settled[2] ?? [];
  const recentTaskRows = settled[3] ?? [];
  const latencyRows = settled[4] ?? [];
  const staleInflightRows = settled[5] ?? [];
  const rateLimitRows = settled[6] ?? [];
  const lastWebhookRows = settled[7] ?? [];

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
  };
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
 * Build the queryRows dep from the shared PersistenceService.
 * Returns a function that executes raw SQL queries against the shared Postgres.
 * Returns [] on any error (fail-open for cockpit observability).
 */
async function buildQueryRows(): Promise<QueryRowsFn> {
  try {
    const { getSharedPersistenceService } = await import("../shared-persistence");
    const svc = await getSharedPersistenceService();
    const provider = svc.getProvider();

    // Need raw SQL access — check for getRawSqlConnection() first, then
    // fall back to getDatabaseConnection() which returns a drizzle instance.
    if (
      "getRawSqlConnection" in provider &&
      typeof (provider as { getRawSqlConnection?: unknown }).getRawSqlConnection === "function"
    ) {
      const sqlProvider = provider as {
        getRawSqlConnection: () => Promise<
          (query: string, params?: unknown[]) => Promise<{ rows: unknown[] }>
        >;
      };
      const rawSql = await sqlProvider.getRawSqlConnection();
      // postgres-js supports parameterized queries via sql.unsafe(query, params)
      return async (query: string, params?: unknown[]): Promise<Record<string, unknown>[]> => {
        try {
          const result = await rawSql(query, params);
          return (result.rows ?? []) as Record<string, unknown>[];
        } catch {
          return [];
        }
      };
    }

    if (
      "getDatabaseConnection" in provider &&
      typeof (provider as { getDatabaseConnection?: unknown }).getDatabaseConnection === "function"
    ) {
      const dbProvider = provider as {
        getDatabaseConnection: () => Promise<{
          execute: (query: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
        }>;
      };
      const db = await dbProvider.getDatabaseConnection();
      // drizzle's execute() accepts an optional params array for parameterized queries
      return async (query: string, params?: unknown[]): Promise<Record<string, unknown>[]> => {
        try {
          const result = await db.execute(query, params);
          return (result.rows ?? []) as Record<string, unknown>[];
        } catch {
          return [];
        }
      };
    }

    // No SQL provider available — return empty results for all queries.
    return async (_query: string, _params?: unknown[]) => [];
  } catch {
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
