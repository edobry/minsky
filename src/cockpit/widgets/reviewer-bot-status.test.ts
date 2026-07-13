/**
 * Tests for src/cockpit/widgets/reviewer-bot-status.ts (mt#2076).
 *
 * Follows the mcp-server-status.test.ts template: inject IO seams via
 * createReviewerBotStatusWidget(deps) and assert payload shape / anomalies.
 *
 * Test scenarios:
 *   1. Healthy probe + DB → 14 payload fields present, all anomalies false
 *   2. Probe failure (A1) → health.ok:false, a1ServiceUnreachable:true
 *   3. Stale in-flight (A2) → a2StaleInflight:true
 *   4. Failure-rate spike (A3) → a3FailureRateSpike:true
 *   5. Latency regression (A4) → a4LatencyRegression:true
 *   6. extractTaskIdFromBranch unit tests
 *   7. Verdict distribution + A6 drift (mt#2287)
 */

import { describe, test, expect, mock } from "bun:test";
import {
  createReviewerBotStatusWidget,
  createUnsafeQueryRows,
  buildQueryRows,
  runQueriesWithLimit,
  extractTaskIdFromBranch,
  type ReviewerBotStatusPayload,
  type ReviewerHealthProbeResult,
} from "./reviewer-bot-status";
import type { WidgetContext } from "../types";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

const FIXED_NOW = new Date("2026-06-04T12:00:00Z").getTime();

function fakeCtx(): WidgetContext {
  return {} as WidgetContext;
}

function healthyProbe(): Promise<ReviewerHealthProbeResult> {
  return Promise.resolve({
    ok: true,
    statusCode: 200,
    inflightCount: 3,
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    tier2Enabled: true,
  });
}

function unreachableProbe(): Promise<ReviewerHealthProbeResult> {
  return Promise.resolve({
    ok: false,
    statusCode: null,
    inflightCount: null,
    provider: null,
    model: null,
    tier2Enabled: null,
  });
}

type QueryRows = (sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;

/**
 * Create a QueryRowsFn that returns stub data based on the SQL statement.
 * Uses simple substring matching for routing. The `params` argument is accepted
 * but ignored in stubs — routing is done entirely by SQL text.
 */
function makeQueryRows(overrides: {
  throughputCount?: number;
  failureCount?: number;
  lastError?: string | null;
  recentTaskHeadRefs?: string[];
  avgLatencyMs?: number | null;
  p95LatencyMs?: number | null;
  staleInflightCount?: number;
  rateLimitCount?: number;
  lastWebhookAt?: string | null;
  medianTokens?: number | null;
  medianCostUsd?: number | null;
  cacheHitRatio?: number | null;
  /** Verdict counts — used for BOTH the 24h and 7d GROUP BY verdict queries
   * (mirrors the medianTokens/medianCostUsd single-value-for-both-windows
   * pattern), so the default healthy fixture has equal 24h/7d ratios and
   * a6VerdictDrift stays false. */
  verdictCounts?: { approve: number; requestChanges: number; comment: number };
}): QueryRows {
  const {
    throughputCount = 10,
    failureCount = 0,
    lastError = null,
    recentTaskHeadRefs = ["task/mt-2076", "task/mt-2075"],
    avgLatencyMs = 30_000,
    p95LatencyMs = 45_000,
    staleInflightCount = 0,
    rateLimitCount = 0,
    lastWebhookAt = "2026-06-04T11:55:00Z",
    medianTokens = 42_000,
    medianCostUsd = 0.15,
    cacheHitRatio = 0.6,
    verdictCounts = { approve: 7, requestChanges: 2, comment: 1 },
  } = overrides;

  return async (sql: string, _params?: unknown[]): Promise<Record<string, unknown>[]> => {
    // mt#2288 median queries — MUST be routed before the latency PERCENTILE_CONT
    // branch below (both hit review_timing + PERCENTILE_CONT).
    if (sql.includes("median_tokens")) {
      return [{ median_tokens: medianTokens }];
    }
    if (sql.includes("median_cost")) {
      return [{ median_cost: medianCostUsd }];
    }
    // mt#2721 cache-hit ratio (SUM/SUM, no PERCENTILE — distinct branch).
    if (sql.includes("cache_hit_ratio")) {
      return [{ cache_hit_ratio: cacheHitRatio }];
    }
    // Throughput query
    if (sql.includes("review_submitted") && sql.includes("COUNT")) {
      return [{ count: throughputCount }];
    }
    // Failure count
    if (sql.includes("failed_at_%") && sql.includes("COUNT")) {
      return [{ count: failureCount }];
    }
    // Last error — text of the query also matches failed_at_% but has LIMIT 1
    if (sql.includes("failed_at_%") && sql.includes("LIMIT 1")) {
      if (lastError) {
        return [{ error_details: lastError, received_at: "2026-06-04T11:00:00Z" }];
      }
      return [];
    }
    // Recent tasks (subquery form)
    if (sql.includes("reviewer_convergence_metrics") && sql.includes("head_ref")) {
      return recentTaskHeadRefs.map((ref) => ({ head_ref: ref }));
    }
    // Latency (AVG + PERCENTILE)
    if (sql.includes("review_timing") && sql.includes("PERCENTILE_CONT")) {
      return [{ avg_ms: avgLatencyMs, p95_ms: p95LatencyMs }];
    }
    // Stale in-flight
    if (sql.includes("reviewer_inflight_reviews")) {
      return [{ count: staleInflightCount }];
    }
    // Rate-limit hits
    if (sql.includes("rate_limited")) {
      return [{ count: rateLimitCount }];
    }
    // Last webhook
    if (sql.includes("reviewer_webhook_events") && sql.includes("received_at")) {
      return lastWebhookAt ? [{ received_at: lastWebhookAt }] : [];
    }
    // mt#2287 verdict distribution (24h and 7d — same stub value for both,
    // see the verdictCounts doc comment above).
    if (sql.includes("GROUP BY verdict")) {
      return verdictCountsToRows(verdictCounts);
    }
    return [];
  };
}

/** Convert a { approve, requestChanges, comment } counts object into
 * GROUP-BY-verdict-shaped rows, matching the real query's row shape
 * (`{ verdict: "approve" | "request_changes" | "comment", count: n }`).
 * Zero-count classes are omitted, matching a real GROUP BY (mt#2287). */
function verdictCountsToRows(counts: {
  approve: number;
  requestChanges: number;
  comment: number;
}): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  if (counts.approve > 0) rows.push({ verdict: "approve", count: counts.approve });
  if (counts.requestChanges > 0) {
    rows.push({ verdict: "request_changes", count: counts.requestChanges });
  }
  if (counts.comment > 0) rows.push({ verdict: "comment", count: counts.comment });
  return rows;
}

// ---------------------------------------------------------------------------
// 1. Healthy path — 14 fields present, all anomalies false
// ---------------------------------------------------------------------------

describe("createReviewerBotStatusWidget — healthy", () => {
  test("state is ok with expected payload shape", async () => {
    const widget = createReviewerBotStatusWidget({
      probeHealth: healthyProbe,
      queryRows: makeQueryRows({}),
      now: () => FIXED_NOW,
    });

    const data = await widget.fetch(fakeCtx());

    expect(data.state).toBe("ok");
    const payload = (data as { state: "ok"; payload: ReviewerBotStatusPayload }).payload;

    // Health fields (5)
    expect(payload.health.ok).toBe(true);
    expect(payload.health.statusCode).toBe(200);
    expect(typeof payload.health.lastProbeAt).toBe("string");
    expect(payload.health.inflightCount).toBe(3);
    expect(payload.health.provider).toBe("anthropic");
    expect(payload.health.model).toBe("claude-sonnet-4-6");
    expect(payload.health.tier2Enabled).toBe(true);

    // DB fields (9)
    expect(payload.db).not.toBeNull();
    if (payload.db === null) throw new Error("expected db to be non-null");
    const db = payload.db;
    expect(db.reviewCount24h).toBe(10);
    expect(db.failureCount24h).toBe(0);
    expect(db.lastError).toBeNull();
    expect(db.recentTaskIds).toEqual(["mt#2076", "mt#2075"]);
    expect(db.avgLatencyMs).toBe(30_000);
    expect(db.p95LatencyMs).toBe(45_000);
    expect(db.staleInflightCount).toBe(0);
    expect(db.rateLimitHitCount24h).toBe(0);
    expect(db.lastWebhookReceivedAt).toBe("2026-06-04T11:55:00Z");
    // Cost fields (mt#2288) — same value for 24h and 7d → no cost trend
    expect(db.medianTokens24h).toBe(42_000);
    expect(db.medianTokens7d).toBe(42_000);
    expect(db.medianCostUsd24h).toBe(0.15);
    expect(db.medianCostUsd7d).toBe(0.15);
    // Cache-hit ratio (mt#2721)
    expect(db.cacheHitRatio24h).toBe(0.6);
    // Verdict distribution (mt#2287) — same counts for 24h and 7d → no drift
    expect(db.verdictCounts24h).toEqual({ approve: 7, requestChanges: 2, comment: 1 });
    expect(db.verdictCounts7d).toEqual({ approve: 7, requestChanges: 2, comment: 1 });

    // All anomalies false
    expect(payload.anomalies.a1ServiceUnreachable).toBe(false);
    expect(payload.anomalies.a2StaleInflight).toBe(false);
    expect(payload.anomalies.a3FailureRateSpike).toBe(false);
    expect(payload.anomalies.a4LatencyRegression).toBe(false);
    expect(payload.anomalies.a5CostTrend).toBe(false);
    expect(payload.anomalies.a6VerdictDrift).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. Probe failure → A1
// ---------------------------------------------------------------------------

describe("createReviewerBotStatusWidget — A1 service unreachable", () => {
  test("a1ServiceUnreachable is true when probe returns ok:false", async () => {
    const widget = createReviewerBotStatusWidget({
      probeHealth: unreachableProbe,
      queryRows: makeQueryRows({}),
      now: () => FIXED_NOW,
    });

    const data = await widget.fetch(fakeCtx());

    expect(data.state).toBe("ok");
    const payload = (data as { state: "ok"; payload: ReviewerBotStatusPayload }).payload;

    expect(payload.health.ok).toBe(false);
    expect(payload.health.statusCode).toBeNull();
    expect(payload.anomalies.a1ServiceUnreachable).toBe(true);
    // Other anomalies must not fire just from a probe failure
    expect(payload.anomalies.a2StaleInflight).toBe(false);
    expect(payload.anomalies.a3FailureRateSpike).toBe(false);
    expect(payload.anomalies.a4LatencyRegression).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. Stale in-flight → A2
// ---------------------------------------------------------------------------

describe("createReviewerBotStatusWidget — A2 stale in-flight", () => {
  test("a2StaleInflight is true when staleInflightCount >= 1", async () => {
    const widget = createReviewerBotStatusWidget({
      probeHealth: healthyProbe,
      queryRows: makeQueryRows({ staleInflightCount: 2 }),
      now: () => FIXED_NOW,
    });

    const data = await widget.fetch(fakeCtx());
    expect(data.state).toBe("ok");
    const payload = (data as { state: "ok"; payload: ReviewerBotStatusPayload }).payload;

    if (payload.db === null) throw new Error("expected db to be non-null");
    expect(payload.db.staleInflightCount).toBe(2);
    expect(payload.anomalies.a2StaleInflight).toBe(true);
    expect(payload.anomalies.a1ServiceUnreachable).toBe(false);
    expect(payload.anomalies.a3FailureRateSpike).toBe(false);
    expect(payload.anomalies.a4LatencyRegression).toBe(false);
  });

  test("a2StaleInflight is false when staleInflightCount is 0", async () => {
    const widget = createReviewerBotStatusWidget({
      probeHealth: healthyProbe,
      queryRows: makeQueryRows({ staleInflightCount: 0 }),
      now: () => FIXED_NOW,
    });

    const data = await widget.fetch(fakeCtx());
    const payload = (data as { state: "ok"; payload: ReviewerBotStatusPayload }).payload;
    expect(payload.anomalies.a2StaleInflight).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. Failure-rate spike → A3
// ---------------------------------------------------------------------------

describe("createReviewerBotStatusWidget — A3 failure-rate spike", () => {
  test("a3FailureRateSpike is true when >50% failures with sample >= 5", async () => {
    // 3 successes + 4 failures = 7 total, failure rate = 57% > 50%, sample ≥ 5
    const widget = createReviewerBotStatusWidget({
      probeHealth: healthyProbe,
      queryRows: makeQueryRows({ throughputCount: 3, failureCount: 4 }),
      now: () => FIXED_NOW,
    });

    const data = await widget.fetch(fakeCtx());
    const payload = (data as { state: "ok"; payload: ReviewerBotStatusPayload }).payload;

    if (payload.db === null) throw new Error("expected db to be non-null");
    expect(payload.db.reviewCount24h).toBe(3);
    expect(payload.db.failureCount24h).toBe(4);
    expect(payload.anomalies.a3FailureRateSpike).toBe(true);
  });

  test("a3FailureRateSpike is false when failure rate <= 50%", async () => {
    // 10 successes + 4 failures = 14 total, failure rate = 28.6% < 50%
    const widget = createReviewerBotStatusWidget({
      probeHealth: healthyProbe,
      queryRows: makeQueryRows({ throughputCount: 10, failureCount: 4 }),
      now: () => FIXED_NOW,
    });

    const data = await widget.fetch(fakeCtx());
    const payload = (data as { state: "ok"; payload: ReviewerBotStatusPayload }).payload;
    expect(payload.anomalies.a3FailureRateSpike).toBe(false);
  });

  test("a3FailureRateSpike is false when sample < 5 (below minimum)", async () => {
    // 1 success + 3 failures = 4 total — rate would be 75% but sample < 5
    const widget = createReviewerBotStatusWidget({
      probeHealth: healthyProbe,
      queryRows: makeQueryRows({ throughputCount: 1, failureCount: 3 }),
      now: () => FIXED_NOW,
    });

    const data = await widget.fetch(fakeCtx());
    const payload = (data as { state: "ok"; payload: ReviewerBotStatusPayload }).payload;
    expect(payload.anomalies.a3FailureRateSpike).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 5. Latency regression → A4
// ---------------------------------------------------------------------------

describe("createReviewerBotStatusWidget — A4 latency regression", () => {
  test("a4LatencyRegression is true when P95 > 120s", async () => {
    // P95 = 125s (125_000 ms) > 120s threshold
    const widget = createReviewerBotStatusWidget({
      probeHealth: healthyProbe,
      queryRows: makeQueryRows({ p95LatencyMs: 125_000 }),
      now: () => FIXED_NOW,
    });

    const data = await widget.fetch(fakeCtx());
    const payload = (data as { state: "ok"; payload: ReviewerBotStatusPayload }).payload;

    if (payload.db === null) throw new Error("expected db to be non-null");
    expect(payload.db.p95LatencyMs).toBe(125_000);
    expect(payload.anomalies.a4LatencyRegression).toBe(true);
  });

  test("a4LatencyRegression is false when P95 <= 120s", async () => {
    const widget = createReviewerBotStatusWidget({
      probeHealth: healthyProbe,
      queryRows: makeQueryRows({ p95LatencyMs: 119_999 }),
      now: () => FIXED_NOW,
    });

    const data = await widget.fetch(fakeCtx());
    const payload = (data as { state: "ok"; payload: ReviewerBotStatusPayload }).payload;
    expect(payload.anomalies.a4LatencyRegression).toBe(false);
  });

  test("a4LatencyRegression is false when P95 is null (no data)", async () => {
    const widget = createReviewerBotStatusWidget({
      probeHealth: healthyProbe,
      queryRows: makeQueryRows({ p95LatencyMs: null }),
      now: () => FIXED_NOW,
    });

    const data = await widget.fetch(fakeCtx());
    const payload = (data as { state: "ok"; payload: ReviewerBotStatusPayload }).payload;
    if (payload.db === null) throw new Error("expected db to be non-null");
    expect(payload.db.p95LatencyMs).toBeNull();
    expect(payload.anomalies.a4LatencyRegression).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 5b. Cost trend → A5 (mt#2288)
// ---------------------------------------------------------------------------

describe("createReviewerBotStatusWidget — A5 cost trend", () => {
  const WINDOW_7D_ISO = new Date(FIXED_NOW - 7 * 24 * 60 * 60 * 1_000).toISOString();

  test("a5CostTrend fires when 24h median cost diverges >50% from 7d median", async () => {
    // 24h median $0.20 is 100% above the 7d median $0.10 → >50% divergence.
    const costTrendQueryRows: QueryRows = async (sql, params) => {
      if (sql.includes("median_cost")) {
        const is7d = params?.[0] === WINDOW_7D_ISO;
        return [{ median_cost: is7d ? 0.1 : 0.2 }];
      }
      if (sql.includes("median_tokens")) {
        return [{ median_tokens: 40_000 }];
      }
      return makeQueryRows({})(sql, params);
    };

    const widget = createReviewerBotStatusWidget({
      probeHealth: healthyProbe,
      queryRows: costTrendQueryRows,
      now: () => FIXED_NOW,
    });

    const data = await widget.fetch(fakeCtx());
    const payload = (data as { state: "ok"; payload: ReviewerBotStatusPayload }).payload;

    if (payload.db === null) throw new Error("expected db to be non-null");
    expect(payload.db.medianCostUsd24h).toBe(0.2);
    expect(payload.db.medianCostUsd7d).toBe(0.1);
    expect(payload.anomalies.a5CostTrend).toBe(true);
  });

  test("a5CostTrend is false when both median-cost windows are null (no priced reviews)", async () => {
    const widget = createReviewerBotStatusWidget({
      probeHealth: healthyProbe,
      queryRows: makeQueryRows({ medianCostUsd: null }),
      now: () => FIXED_NOW,
    });

    const data = await widget.fetch(fakeCtx());
    const payload = (data as { state: "ok"; payload: ReviewerBotStatusPayload }).payload;
    if (payload.db === null) throw new Error("expected db to be non-null");
    expect(payload.db.medianCostUsd24h).toBeNull();
    expect(payload.anomalies.a5CostTrend).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 6. DB failure degrades gracefully without crashing
// ---------------------------------------------------------------------------

describe("createReviewerBotStatusWidget — DB failure degrades gracefully", () => {
  test("db has empty/null defaults when all queryRows calls reject, state is still ok", async () => {
    // With Promise.allSettled, individual query rejections produce empty rows ([])
    // for each query. fetchDbStats still returns a valid ReviewerDbStats with zero/null defaults
    // rather than null — this is the intended behavior (db is non-null, fields are empty).
    const throwingQueryRows: QueryRows = async (_sql: string, _params?: unknown[]) => {
      throw new Error("connection refused");
    };

    const widget = createReviewerBotStatusWidget({
      probeHealth: healthyProbe,
      queryRows: throwingQueryRows,
      now: () => FIXED_NOW,
    });

    const data = await widget.fetch(fakeCtx());
    expect(data.state).toBe("ok");
    const payload = (data as { state: "ok"; payload: ReviewerBotStatusPayload }).payload;
    // db is non-null — Promise.allSettled handles per-query failures gracefully.
    // All fields default to 0 / null / [] when every query rejects.
    expect(payload.db).not.toBeNull();
    if (payload.db === null) throw new Error("expected db to be non-null");
    expect(payload.db.reviewCount24h).toBe(0);
    expect(payload.db.failureCount24h).toBe(0);
    expect(payload.db.recentTaskIds).toEqual([]);
    expect(payload.db.avgLatencyMs).toBeNull();
    expect(payload.db.p95LatencyMs).toBeNull();
    expect(payload.db.staleInflightCount).toBe(0);
    // Verdict distribution defaults to zero counts on every query rejecting (mt#2287)
    expect(payload.db.verdictCounts24h).toEqual({ approve: 0, requestChanges: 0, comment: 0 });
    expect(payload.db.verdictCounts7d).toEqual({ approve: 0, requestChanges: 0, comment: 0 });
    // Anomalies that require DB data must be false when all queries produce empty results
    expect(payload.anomalies.a2StaleInflight).toBe(false);
    expect(payload.anomalies.a3FailureRateSpike).toBe(false);
    expect(payload.anomalies.a4LatencyRegression).toBe(false);
    expect(payload.anomalies.a6VerdictDrift).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 7. Promise.allSettled — partial query failure degrades only affected field
// ---------------------------------------------------------------------------

describe("createReviewerBotStatusWidget — partial DB failure degrades gracefully", () => {
  test("db is non-null when only the latency query rejects (PERCENTILE_CONT unsupported)", async () => {
    // Latency query throws (simulates a PG variant that doesn't support PERCENTILE_CONT);
    // all other queries succeed. db should still be non-null with latency fields as null.
    const partialFailQueryRows: QueryRows = async (
      sql: string,
      _params?: unknown[]
    ): Promise<Record<string, unknown>[]> => {
      if (sql.includes("PERCENTILE_CONT")) {
        throw new Error("function percentile_cont(double precision) does not exist");
      }
      // All other queries succeed via the standard stub
      return makeQueryRows({})(sql, _params);
    };

    const widget = createReviewerBotStatusWidget({
      probeHealth: healthyProbe,
      queryRows: partialFailQueryRows,
      now: () => FIXED_NOW,
    });

    const data = await widget.fetch(fakeCtx());
    expect(data.state).toBe("ok");
    const payload = (data as { state: "ok"; payload: ReviewerBotStatusPayload }).payload;

    // db must be non-null (not the whole batch failed)
    expect(payload.db).not.toBeNull();
    if (payload.db === null) throw new Error("expected db to be non-null");

    // Latency fields are null (that query failed)
    expect(payload.db.avgLatencyMs).toBeNull();
    expect(payload.db.p95LatencyMs).toBeNull();

    // Other fields succeeded
    expect(payload.db.reviewCount24h).toBe(10);
    expect(payload.db.failureCount24h).toBe(0);
    expect(payload.db.staleInflightCount).toBe(0);

    // A4 must not fire when p95LatencyMs is null
    expect(payload.anomalies.a4LatencyRegression).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 8. extractTaskIdFromBranch unit tests
// ---------------------------------------------------------------------------

describe("extractTaskIdFromBranch", () => {
  test("extracts task ID from canonical branch name", () => {
    expect(extractTaskIdFromBranch("task/mt-2076")).toBe("mt#2076");
  });

  test("extracts task ID from branch with hyphen suffix", () => {
    expect(extractTaskIdFromBranch("task/mt-1234-some-description")).toBe("mt#1234");
  });

  test("extracts task ID from branch with slash suffix", () => {
    expect(extractTaskIdFromBranch("task/mt-999/feature-name")).toBe("mt#999");
  });

  test("extracts task ID from branch with dot suffix", () => {
    expect(extractTaskIdFromBranch("task/mt-42.patch")).toBe("mt#42");
  });

  test("returns null for non-task branch names", () => {
    expect(extractTaskIdFromBranch("main")).toBeNull();
    expect(extractTaskIdFromBranch("feature/xyz")).toBeNull();
    expect(extractTaskIdFromBranch("hotfix/mt-123")).toBeNull();
    expect(extractTaskIdFromBranch("task/mt-")).toBeNull();
    expect(extractTaskIdFromBranch("")).toBeNull();
  });

  test("case-insensitive: Task/MT-123 parses the same as task/mt-123", () => {
    expect(extractTaskIdFromBranch("Task/MT-123")).toBe("mt#123");
    expect(extractTaskIdFromBranch("TASK/MT-456")).toBe("mt#456");
  });

  test("returns null for null and undefined inputs", () => {
    expect(extractTaskIdFromBranch(null)).toBeNull();
    expect(extractTaskIdFromBranch(undefined)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 7. Verdict distribution + A6 drift (mt#2287)
// ---------------------------------------------------------------------------

describe("createReviewerBotStatusWidget — verdict distribution (mt#2287)", () => {
  const WINDOW_7D_ISO_VERDICT = new Date(FIXED_NOW - 7 * 24 * 60 * 60 * 1_000).toISOString();

  /**
   * Build a QueryRowsFn where the 24h and 7d GROUP BY verdict queries can be
   * given independent counts (distinguished via the window-start param, same
   * technique as the "5b. Cost trend" describe block above). All other
   * queries fall back to the standard makeQueryRows({}) stub.
   */
  function makeVerdictDriftQueryRows(
    counts24h: { approve: number; requestChanges: number; comment: number },
    counts7d: { approve: number; requestChanges: number; comment: number }
  ): QueryRows {
    const fallback = makeQueryRows({});
    return async (sql, params) => {
      if (sql.includes("GROUP BY verdict")) {
        const is7d = params?.[0] === WINDOW_7D_ISO_VERDICT;
        return verdictCountsToRows(is7d ? counts7d : counts24h);
      }
      return fallback(sql, params);
    };
  }

  test("parses GROUP BY verdict rows into counts keyed by camelCase class", async () => {
    const widget = createReviewerBotStatusWidget({
      probeHealth: healthyProbe,
      queryRows: makeVerdictDriftQueryRows(
        { approve: 8, requestChanges: 4, comment: 2 },
        { approve: 8, requestChanges: 4, comment: 2 }
      ),
      now: () => FIXED_NOW,
    });

    const data = await widget.fetch(fakeCtx());
    const payload = (data as { state: "ok"; payload: ReviewerBotStatusPayload }).payload;
    if (payload.db === null) throw new Error("expected db to be non-null");

    expect(payload.db.verdictCounts24h).toEqual({ approve: 8, requestChanges: 4, comment: 2 });
    expect(payload.db.verdictCounts7d).toEqual({ approve: 8, requestChanges: 4, comment: 2 });
  });

  test("a verdict class with zero rows in the GROUP BY result parses to a zero count", async () => {
    // No request_changes or comment rows at all — GROUP BY only returns the
    // classes with >= 1 matching row (mirrors real Postgres GROUP BY behavior).
    const widget = createReviewerBotStatusWidget({
      probeHealth: healthyProbe,
      queryRows: makeVerdictDriftQueryRows(
        { approve: 5, requestChanges: 0, comment: 0 },
        { approve: 5, requestChanges: 0, comment: 0 }
      ),
      now: () => FIXED_NOW,
    });

    const data = await widget.fetch(fakeCtx());
    const payload = (data as { state: "ok"; payload: ReviewerBotStatusPayload }).payload;
    if (payload.db === null) throw new Error("expected db to be non-null");

    expect(payload.db.verdictCounts24h).toEqual({ approve: 5, requestChanges: 0, comment: 0 });
  });

  test("a6VerdictDrift fires when a verdict's 24h ratio diverges >20pp from its 7d ratio", async () => {
    // 24h: 9 approve / 10 total = 90% approve.
    // 7d: 5 approve / 10 total = 50% approve. Divergence = 40pp > 20pp threshold.
    const widget = createReviewerBotStatusWidget({
      probeHealth: healthyProbe,
      queryRows: makeVerdictDriftQueryRows(
        { approve: 9, requestChanges: 1, comment: 0 },
        { approve: 5, requestChanges: 3, comment: 2 }
      ),
      now: () => FIXED_NOW,
    });

    const data = await widget.fetch(fakeCtx());
    const payload = (data as { state: "ok"; payload: ReviewerBotStatusPayload }).payload;
    if (payload.db === null) throw new Error("expected db to be non-null");

    expect(payload.db.verdictCounts24h).toEqual({ approve: 9, requestChanges: 1, comment: 0 });
    expect(payload.db.verdictCounts7d).toEqual({ approve: 5, requestChanges: 3, comment: 2 });
    expect(payload.anomalies.a6VerdictDrift).toBe(true);
  });

  test("a6VerdictDrift is false when ratios diverge <= 20pp", async () => {
    // 24h: 6/10 = 60% approve. 7d: 5/10 = 50% approve. Divergence = 10pp <= threshold.
    const widget = createReviewerBotStatusWidget({
      probeHealth: healthyProbe,
      queryRows: makeVerdictDriftQueryRows(
        { approve: 6, requestChanges: 3, comment: 1 },
        { approve: 5, requestChanges: 3, comment: 2 }
      ),
      now: () => FIXED_NOW,
    });

    const data = await widget.fetch(fakeCtx());
    const payload = (data as { state: "ok"; payload: ReviewerBotStatusPayload }).payload;
    expect(payload.anomalies.a6VerdictDrift).toBe(false);
  });

  test("a6VerdictDrift is false when the 24h sample is below the minimum size, even with a huge ratio gap", async () => {
    // 24h: 2 approve / 2 total = 100% approve, but total < A6_MIN_SAMPLE_SIZE (3).
    // 7d: 5 approve / 10 total = 50% approve — would be a 50pp gap if not gated.
    const widget = createReviewerBotStatusWidget({
      probeHealth: healthyProbe,
      queryRows: makeVerdictDriftQueryRows(
        { approve: 2, requestChanges: 0, comment: 0 },
        { approve: 5, requestChanges: 3, comment: 2 }
      ),
      now: () => FIXED_NOW,
    });

    const data = await widget.fetch(fakeCtx());
    const payload = (data as { state: "ok"; payload: ReviewerBotStatusPayload }).payload;
    expect(payload.anomalies.a6VerdictDrift).toBe(false);
  });

  test("a6VerdictDrift is false when the 7d baseline sample is below the minimum size", async () => {
    // 7d total = 2 (below A6_MIN_SAMPLE_SIZE), even though 24h has ample volume.
    const widget = createReviewerBotStatusWidget({
      probeHealth: healthyProbe,
      queryRows: makeVerdictDriftQueryRows(
        { approve: 9, requestChanges: 1, comment: 0 },
        { approve: 2, requestChanges: 0, comment: 0 }
      ),
      now: () => FIXED_NOW,
    });

    const data = await widget.fetch(fakeCtx());
    const payload = (data as { state: "ok"; payload: ReviewerBotStatusPayload }).payload;
    expect(payload.anomalies.a6VerdictDrift).toBe(false);
  });

  test("a6VerdictDrift is false when both windows have zero verdict data", async () => {
    const widget = createReviewerBotStatusWidget({
      probeHealth: healthyProbe,
      queryRows: makeVerdictDriftQueryRows(
        { approve: 0, requestChanges: 0, comment: 0 },
        { approve: 0, requestChanges: 0, comment: 0 }
      ),
      now: () => FIXED_NOW,
    });

    const data = await widget.fetch(fakeCtx());
    const payload = (data as { state: "ok"; payload: ReviewerBotStatusPayload }).payload;
    if (payload.db === null) throw new Error("expected db to be non-null");
    expect(payload.db.verdictCounts24h).toEqual({ approve: 0, requestChanges: 0, comment: 0 });
    expect(payload.anomalies.a6VerdictDrift).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Query wiring (mt#2757) — the real buildQueryRows path was never covered;
// the original wiring called the postgres-js Sql instance as a plain function
// (NOT_TAGGED_CALL on every query) and read `.rows` off an array result, so
// every DB field rendered as zero since birth. These tests pin the corrected
// shape: raw string queries go through `.unsafe(query, params)` and the
// resolved value IS the row array.
// ---------------------------------------------------------------------------

describe("createUnsafeQueryRows / buildQueryRows wiring (mt#2757)", () => {
  test("routes queries through sql.unsafe(query, params) and returns the row array", async () => {
    const unsafe = mock((_query: string, _params?: unknown[]) => Promise.resolve([{ count: "7" }]));
    const queryRows = createUnsafeQueryRows({ unsafe });

    const rows = await queryRows("SELECT 1", ["a"]);

    expect(unsafe).toHaveBeenCalledTimes(1);
    expect(unsafe).toHaveBeenCalledWith("SELECT 1", ["a"]);
    expect(rows).toEqual([{ count: "7" }]);
  });

  test("non-array resolution degrades to [] (defensive against driver-shape drift)", async () => {
    const unsafe = mock((_query: string, _params?: unknown[]) =>
      Promise.resolve({ rows: [{ count: "7" }] } as unknown)
    );
    const queryRows = createUnsafeQueryRows({ unsafe });

    expect(await queryRows("SELECT 1")).toEqual([]);
  });

  test("query rejection returns [] AND invokes the warn seam (no silent fail-open)", async () => {
    const warn = mock((_err: unknown) => {});
    const unsafe = mock((_query: string, _params?: unknown[]) =>
      Promise.reject(new Error("NOT_TAGGED_CALL"))
    );
    const queryRows = createUnsafeQueryRows({ unsafe }, warn);

    const rows = await queryRows("SELECT 1");

    expect(rows).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  test("buildQueryRows wires provider.getRawSqlConnection().unsafe (not a plain call)", async () => {
    const unsafe = mock((_query: string, _params?: unknown[]) => Promise.resolve([{ ok: 1 }]));
    const provider = { getRawSqlConnection: () => Promise.resolve({ unsafe }) };

    const queryRows = await buildQueryRows(() => Promise.resolve(provider));
    const rows = await queryRows("SELECT ok", [1]);

    expect(unsafe).toHaveBeenCalledWith("SELECT ok", [1]);
    expect(rows).toEqual([{ ok: 1 }]);
  });

  test("buildQueryRows degrades to empty results when the provider has no raw SQL support", async () => {
    const queryRows = await buildQueryRows(() => Promise.resolve({}));
    expect(await queryRows("SELECT 1")).toEqual([]);
  });

  test("buildQueryRows degrades to empty results when the provider loader throws", async () => {
    const queryRows = await buildQueryRows(() => Promise.reject(new Error("init failed")));
    expect(await queryRows("SELECT 1")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Concurrency discipline (mt#2765) — >pool-max concurrent queries wedge the
// shared postgres-js pool forever, and the frontend's timeout-less polling
// turned that into a permanently hung endpoint. These tests pin the three
// defenses: bounded query fan-out, single-flighted concurrent fetches, and a
// hard deadline on the DB-stats phase.
// ---------------------------------------------------------------------------

describe("concurrency discipline (mt#2765)", () => {
  test("runQueriesWithLimit never exceeds its bound and preserves order", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const thunks = Array.from({ length: 15 }, (_, i) => async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return i;
    });

    const results = await runQueriesWithLimit(thunks, 4, -1);

    expect(maxInFlight).toBeLessThanOrEqual(4);
    expect(results).toEqual(Array.from({ length: 15 }, (_, i) => i));
  });

  test("runQueriesWithLimit maps a rejecting thunk to the fallback for only its slot", async () => {
    const thunks = [
      async () => "a",
      async () => {
        throw new Error("boom");
      },
      async () => "c",
    ];
    expect(await runQueriesWithLimit(thunks, 2, "FALLBACK")).toEqual(["a", "FALLBACK", "c"]);
  });

  test("widget query fan-out stays within the concurrency limit", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    let calls = 0;
    const countingQueryRows = async (): Promise<Record<string, unknown>[]> => {
      calls++;
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 2));
      inFlight--;
      return [];
    };
    const widget = createReviewerBotStatusWidget({
      probeHealth: healthyProbe,
      queryRows: countingQueryRows,
      now: () => FIXED_NOW,
    });

    const data = await widget.fetch(fakeCtx());

    expect((data as { state: string }).state).toBe("ok");
    expect(calls).toBe(15);
    expect(maxInFlight).toBeLessThanOrEqual(4);
  });

  test("concurrent fetches are single-flighted: one probe, one stats pass, all callers resolve", async () => {
    let probeCalls = 0;
    let queryCalls = 0;
    const widget = createReviewerBotStatusWidget({
      probeHealth: async () => {
        probeCalls++;
        await new Promise((r) => setTimeout(r, 5));
        return healthyProbe();
      },
      queryRows: async () => {
        queryCalls++;
        await new Promise((r) => setTimeout(r, 2));
        return [];
      },
      now: () => FIXED_NOW,
    });

    const results = await Promise.all(Array.from({ length: 5 }, () => widget.fetch(fakeCtx())));

    expect(probeCalls).toBe(1);
    expect(queryCalls).toBe(15);
    for (const r of results) expect((r as { state: string }).state).toBe("ok");
  });

  test("sequential fetches are NOT coalesced (fresh data per poll)", async () => {
    let probeCalls = 0;
    const widget = createReviewerBotStatusWidget({
      probeHealth: async () => {
        probeCalls++;
        return healthyProbe();
      },
      queryRows: async () => [],
      now: () => FIXED_NOW,
    });

    await widget.fetch(fakeCtx());
    await widget.fetch(fakeCtx());

    expect(probeCalls).toBe(2);
  });

  test("DB-stats deadline: never-settling queries resolve to db:null within the deadline", async () => {
    const widget = createReviewerBotStatusWidget({
      probeHealth: healthyProbe,
      queryRows: () => new Promise<Record<string, unknown>[]>(() => {}),
      now: () => FIXED_NOW,
      dbStatsTimeoutMs: 25,
    });

    // If the deadline were broken this await would never settle and the test
    // itself would time out — no elapsed-time assertion needed.
    const data = await widget.fetch(fakeCtx());

    const payload = (data as { state: "ok"; payload: ReviewerBotStatusPayload }).payload;
    expect(payload.db).toBeNull();
    expect(payload.health.ok).toBe(true);
  });
});
