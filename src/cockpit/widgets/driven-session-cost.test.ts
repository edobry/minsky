/**
 * Unit tests for the driven-session-cost widget's aggregation logic (mt#2753,
 * Rung 2D).
 *
 * Exercises `aggregateDrivenSessionCost` directly against fabricated
 * `driven_session_cost` rows (mirrors extractResultSummary's pure-function
 * test strategy in ../driven-session-host.test.ts) — the widget's own
 * `fetch()` is a thin DB-read wrapper around this function, so the
 * aggregation/rollup behavior (the acceptance-test-relevant logic:
 * "aggregates >=2 sessions correctly, sum + per-session list") is verified
 * here without mocking the shared Postgres connection.
 */

import { describe, test, expect } from "bun:test";
import { aggregateDrivenSessionCost } from "./driven-session-cost";
import type { DrivenSessionCostRecord } from "@minsky/domain/storage/schemas/driven-session-cost-schema";

function row(overrides: Partial<DrivenSessionCostRecord> = {}): DrivenSessionCostRecord {
  return {
    id: "id-1",
    localId: "local-1",
    harnessSessionId: "harness-1",
    taskId: "mt#2753",
    minskySessionId: "session-1",
    turnIndex: 0,
    subtype: "success",
    isError: false,
    totalCostUsd: "0.100000",
    inputTokens: 10,
    outputTokens: 20,
    cacheCreationInputTokens: 100,
    cacheReadInputTokens: 200,
    durationMs: 1000,
    durationApiMs: 900,
    numTurns: 1,
    modelUsage: null,
    recordedAt: new Date("2026-07-14T12:00:00.000Z"),
    ...overrides,
  };
}

describe("aggregateDrivenSessionCost", () => {
  test("returns 'no-data' for an empty row set", () => {
    expect(aggregateDrivenSessionCost([])).toEqual({ status: "no-data" });
  });

  test("a single row rolls up into one session and matches the global aggregate", () => {
    const result = aggregateDrivenSessionCost([row()]);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;

    expect(result.sessionCount).toBe(1);
    expect(result.turnCount).toBe(1);
    expect(result.totalCostUsd).toBeCloseTo(0.1);
    expect(result.inputTokens).toBe(10);
    expect(result.outputTokens).toBe(20);
    expect(result.cacheCreationInputTokens).toBe(100);
    expect(result.cacheReadInputTokens).toBe(200);

    const session = result.sessions[0];
    expect(session?.localId).toBe("local-1");
    expect(session?.taskId).toBe("mt#2753");
    expect(session?.turnCount).toBe(1);
    expect(session?.totalCostUsd).toBeCloseTo(0.1);
  });

  test("aggregates >=2 SESSIONS correctly — sum + per-session list (acceptance test 2)", () => {
    const rows = [
      row({ id: "a1", localId: "session-a", totalCostUsd: "0.100000", inputTokens: 10 }),
      row({ id: "b1", localId: "session-b", totalCostUsd: "0.200000", inputTokens: 20 }),
    ];
    const result = aggregateDrivenSessionCost(rows);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;

    expect(result.sessionCount).toBe(2);
    expect(result.turnCount).toBe(2);
    expect(result.totalCostUsd).toBeCloseTo(0.3);
    expect(result.inputTokens).toBe(30);
    expect(result.sessions.map((s) => s.localId).sort()).toEqual(["session-a", "session-b"]);
  });

  test("multiple TURNS of the SAME session roll up into ONE session entry with summed fields", () => {
    const rows = [
      row({
        id: "t0",
        localId: "session-multi",
        turnIndex: 0,
        totalCostUsd: "0.050000",
        inputTokens: 5,
        recordedAt: new Date("2026-07-14T10:00:00.000Z"),
      }),
      row({
        id: "t1",
        localId: "session-multi",
        turnIndex: 1,
        totalCostUsd: "0.070000",
        inputTokens: 7,
        recordedAt: new Date("2026-07-14T11:00:00.000Z"),
      }),
    ];
    const result = aggregateDrivenSessionCost(rows);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;

    expect(result.sessionCount).toBe(1);
    expect(result.turnCount).toBe(2);
    const session = result.sessions[0];
    expect(session?.turnCount).toBe(2);
    expect(session?.totalCostUsd).toBeCloseTo(0.12);
    expect(session?.inputTokens).toBe(12);
    expect(session?.firstRecordedAt).toBe("2026-07-14T10:00:00.000Z");
    expect(session?.lastRecordedAt).toBe("2026-07-14T11:00:00.000Z");
  });

  test("a null totalCostUsd row does not corrupt the sum — session cost stays null-safe", () => {
    const result = aggregateDrivenSessionCost([row({ totalCostUsd: null })]);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    // No priced rows observed at all: aggregate cost stays null, not 0 (no
    // estimation — mirrors the "no synthesized zero" discipline in
    // extractResultSummary's own tests).
    expect(result.totalCostUsd).toBeNull();
    expect(result.sessions[0]?.totalCostUsd).toBeNull();
  });

  test("model mix (modelUsage) merges across turns of the same session", () => {
    const SONNET = "claude-sonnet-4-6";
    const HAIKU = "claude-haiku-4-5";
    const rows = [
      row({
        id: "m0",
        localId: "session-mix",
        modelUsage: {
          [SONNET]: { inputTokens: 10, outputTokens: 5, costUsd: 0.01 },
        },
      }),
      row({
        id: "m1",
        localId: "session-mix",
        turnIndex: 1,
        modelUsage: {
          [SONNET]: { inputTokens: 3, outputTokens: 2, costUsd: 0.005 },
          [HAIKU]: { inputTokens: 50, outputTokens: 1, costUsd: 0.002 },
        },
      }),
    ];
    const result = aggregateDrivenSessionCost(rows);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    const mix = result.sessions[0]?.modelMix;
    expect(mix?.[SONNET]?.inputTokens).toBe(13);
    expect(mix?.[SONNET]?.outputTokens).toBe(7);
    expect(mix?.[SONNET]?.costUsd).toBeCloseTo(0.015);
    expect(mix?.[HAIKU]?.inputTokens).toBe(50);
  });

  test("projects daily/monthly spend from the observed window at a >1-day span", () => {
    const rows = [
      row({
        id: "p0",
        totalCostUsd: "1.000000",
        recordedAt: new Date("2026-07-10T00:00:00.000Z"),
      }),
      row({
        id: "p1",
        localId: "local-1", // same session, second turn
        turnIndex: 1,
        totalCostUsd: "1.000000",
        recordedAt: new Date("2026-07-12T00:00:00.000Z"),
      }),
    ];
    const result = aggregateDrivenSessionCost(rows);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    // $2 total over a 2-day span => $1/day => $30/month.
    expect(result.projectedDailyCostUsd).toBeCloseTo(1);
    expect(result.projectedMonthlyCostUsd).toBeCloseTo(30);
  });

  test("floors the projection window at 1 day for a sub-day burst (no inflated projection)", () => {
    const rows = [
      row({ id: "b0", totalCostUsd: "0.500000", recordedAt: new Date("2026-07-10T10:00:00.000Z") }),
      row({
        id: "b1",
        turnIndex: 1,
        totalCostUsd: "0.500000",
        recordedAt: new Date("2026-07-10T10:05:00.000Z"),
      }),
    ];
    const result = aggregateDrivenSessionCost(rows);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    // $1 total over a 5-minute span, floored at 1 day => $1/day, not $288/day.
    expect(result.projectedDailyCostUsd).toBeCloseTo(1);
  });
});
