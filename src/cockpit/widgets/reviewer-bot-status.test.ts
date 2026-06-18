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
 */

import { describe, test, expect } from "bun:test";
import {
  createReviewerBotStatusWidget,
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

type QueryRows = (sql: string) => Promise<Record<string, unknown>[]>;

/**
 * Create a QueryRowsFn that returns stub data based on the SQL statement.
 * Uses simple substring matching for routing.
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
  } = overrides;

  return async (sql: string): Promise<Record<string, unknown>[]> => {
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
    return [];
  };
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

    // All anomalies false
    expect(payload.anomalies.a1ServiceUnreachable).toBe(false);
    expect(payload.anomalies.a2StaleInflight).toBe(false);
    expect(payload.anomalies.a3FailureRateSpike).toBe(false);
    expect(payload.anomalies.a4LatencyRegression).toBe(false);
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
// 6. DB failure degrades to null without crashing
// ---------------------------------------------------------------------------

describe("createReviewerBotStatusWidget — DB failure degrades gracefully", () => {
  test("db is null when queryRows throws, state is still ok", async () => {
    const throwingQueryRows: QueryRows = async (_sql: string) => {
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
    expect(payload.db).toBeNull();
    // Anomalies that require DB data must be false
    expect(payload.anomalies.a2StaleInflight).toBe(false);
    expect(payload.anomalies.a3FailureRateSpike).toBe(false);
    expect(payload.anomalies.a4LatencyRegression).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 7. extractTaskIdFromBranch unit tests
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
});
