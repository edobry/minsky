/**
 * Unit tests for rationalization-review.ts pure logic (mt#2901).
 *
 * All tests operate on in-memory data — no filesystem or DB I/O (mt#2876
 * discipline: tests never touch real state; this module has no fs/DB seam
 * at all, so isolation is automatic rather than requiring a temp
 * MINSKY_STATE_DIR override).
 */

import { describe, test, expect } from "bun:test";
import {
  computeLatencyPercentiles,
  buildPanel,
  computeCadenceRecommendation,
  dedupeLegacyCalibrationOverlap,
  OVERRIDE_RATE_BUDGET,
  type RawFireRecord,
  type GuardPanelRow,
  type RationalizationPanel,
} from "./rationalization-review";

const GUARD_A = "guard-a";
const GUARD_B = "guard-b";
const GUARD_ZERO = "guard-zero-fire";
const CAUSAL_PREMISE_GUARD = "causal-premise-detector";

function fireLogRecord(overrides: Partial<RawFireRecord> = {}): RawFireRecord {
  return {
    timestamp: "2026-07-10T00:00:00.000Z",
    guardName: GUARD_A,
    decision: "deny",
    durationMs: 5,
    source: "fire-log",
    ...overrides,
  };
}

/** Narrowing helper — avoids non-null assertions when a test knows a row must exist. */
function requireRow(panel: RationalizationPanel, guardName: string): GuardPanelRow {
  const row = panel.rows.find((r) => r.guardName === guardName);
  if (!row) throw new Error(`Expected a panel row for guard "${guardName}"`);
  return row;
}

describe("computeLatencyPercentiles", () => {
  test("empty input -> null", () => {
    expect(computeLatencyPercentiles([])).toBeNull();
  });

  test("computes p50/p95/p99 over a sorted set", () => {
    const durations = Array.from({ length: 100 }, (_, i) => i + 1); // 1..100
    const result = computeLatencyPercentiles(durations);
    expect(result).toEqual({ p50: 50, p95: 95, p99: 99 });
  });

  test("single value -> all percentiles equal that value", () => {
    const result = computeLatencyPercentiles([42]);
    expect(result).toEqual({ p50: 42, p95: 42, p99: 42 });
  });
});

describe("buildPanel", () => {
  test("guard with no overrides, canary passing, real fires -> auto-affirm", () => {
    const panel = buildPanel({
      records: [
        fireLogRecord({ guardName: GUARD_A, timestamp: "2026-07-10T00:00:00.000Z" }),
        fireLogRecord({ guardName: GUARD_A, timestamp: "2026-07-11T00:00:00.000Z" }),
      ],
      canaryStatuses: [{ guardName: GUARD_A, status: "PASS" }],
      attentionCosts: [{ guardName: GUARD_A, denialMessageSizeChars: 200, optionCount: 1 }],
      familyRecurrences: [],
      now: new Date("2026-07-12T00:00:00.000Z"),
    });

    expect(panel.rows).toHaveLength(1);
    const row = requireRow(panel, GUARD_A);
    expect(row.guardName).toBe(GUARD_A);
    expect(row.fireCount).toBe(2);
    expect(row.overrideCount).toBe(0);
    expect(row.overrideRate).toBe(0);
    expect(row.canaryStatus).toBe("PASS");
    expect(row.disposition).toBe("auto-affirm");
    expect(row.outlierReasons).toEqual([]);
    expect(row.recurrencesSinceDone).toBe("n/a");
    expect(panel.autoAffirmed).toHaveLength(1);
    expect(panel.outliers).toHaveLength(0);
    expect(panel.autoAffirmSummaryLine).toContain(GUARD_A);
  });

  test("guard exceeding override budget -> outlier, never auto-affirm", () => {
    const panel = buildPanel({
      records: [
        fireLogRecord({
          guardName: GUARD_B,
          overrideClassification: "authorized_exception",
        }),
        fireLogRecord({ guardName: GUARD_B }),
        fireLogRecord({ guardName: GUARD_B }),
        fireLogRecord({ guardName: GUARD_B }),
      ],
      canaryStatuses: [{ guardName: GUARD_B, status: "PASS" }],
      attentionCosts: [],
      familyRecurrences: [],
    });

    const row = requireRow(panel, GUARD_B);
    // 1 override / 4 fires = 25% > 20% budget
    expect(row.overrideRate).toBeGreaterThan(OVERRIDE_RATE_BUDGET);
    expect(row.disposition).toBe("outlier");
    expect(row.outlierReasons).toContain("override-budget-exceeded");
    expect(panel.outliers.map((r) => r.guardName)).toContain(GUARD_B);
  });

  test("zero-fire guard is always an outlier (zero-fire anomaly), even with a passing canary", () => {
    const panel = buildPanel({
      records: [],
      canaryStatuses: [{ guardName: GUARD_ZERO, status: "PASS" }],
      attentionCosts: [{ guardName: GUARD_ZERO, denialMessageSizeChars: 100, optionCount: 0 }],
      familyRecurrences: [],
    });

    const row = requireRow(panel, GUARD_ZERO);
    expect(row.fireCount).toBe(0);
    expect(row.disposition).toBe("outlier");
    expect(row.outlierReasons).toContain("zero-fire-anomaly");
    expect(row.latency).toBeNull();
    expect(row.daysSinceLastFire).toBeNull();
  });

  test("missing or failing canary forces outlier regardless of override rate", () => {
    const missingPanel = buildPanel({
      records: [fireLogRecord({ guardName: GUARD_A })],
      canaryStatuses: [],
      attentionCosts: [],
      familyRecurrences: [],
    });
    const missing = requireRow(missingPanel, GUARD_A);
    expect(missing.canaryStatus).toBe("MISSING");
    expect(missing.disposition).toBe("outlier");
    expect(missing.outlierReasons).toContain("canary-missing");

    const failingPanel = buildPanel({
      records: [fireLogRecord({ guardName: GUARD_A })],
      canaryStatuses: [{ guardName: GUARD_A, status: "FAIL" }],
      attentionCosts: [],
      familyRecurrences: [],
    });
    const failing = requireRow(failingPanel, GUARD_A);
    expect(failing.disposition).toBe("outlier");
    expect(failing.outlierReasons).toContain("canary-fail");
  });

  test("recurrence-since-done forces outlier even when override rate and canary are clean", () => {
    const panel = buildPanel({
      records: [fireLogRecord({ guardName: CAUSAL_PREMISE_GUARD })],
      canaryStatuses: [{ guardName: CAUSAL_PREMISE_GUARD, status: "PASS" }],
      attentionCosts: [],
      familyRecurrences: [
        {
          guardName: CAUSAL_PREMISE_GUARD,
          familySlug: "causal-premise",
          fixTaskId: "mt#2216",
          fixTaskStatus: "DONE",
          fixTaskDoneAt: "2026-06-08T21:37:01.928Z",
          recurrencesSinceDone: 1,
        },
      ],
    });

    const row = requireRow(panel, CAUSAL_PREMISE_GUARD);
    expect(row.recurrencesSinceDone).toBe(1);
    expect(row.familySlug).toBe("causal-premise");
    expect(row.disposition).toBe("outlier");
    expect(row.outlierReasons).toContain("recurrence-since-done");
  });

  test("latency excludes calibration-sourced (durationMs=0) records from the real-fire-log signal", () => {
    const panel = buildPanel({
      records: [
        fireLogRecord({ guardName: GUARD_A, durationMs: 10, source: "fire-log" }),
        fireLogRecord({ guardName: GUARD_A, durationMs: 0, source: "calibration" }),
      ],
      canaryStatuses: [{ guardName: GUARD_A, status: "PASS" }],
      attentionCosts: [],
      familyRecurrences: [],
    });
    const row = requireRow(panel, GUARD_A);
    expect(row.fireCount).toBe(2); // both count toward fire count
    expect(row.latency).toEqual({ p50: 10, p95: 10, p99: 10 }); // only the real fire-log duration
  });

  test("never computes a composite score — panel rows expose only named raw fields", () => {
    const panel = buildPanel({
      records: [fireLogRecord()],
      canaryStatuses: [{ guardName: GUARD_A, status: "PASS" }],
      attentionCosts: [],
      familyRecurrences: [],
    });
    const row = requireRow(panel, GUARD_A);
    // No field named "score" or "health" anywhere on the row (Goodhart threat, RFC).
    const keys = Object.keys(row);
    expect(keys.some((k) => /score|health/i.test(k))).toBe(false);
  });
});

describe("dedupeLegacyCalibrationOverlap", () => {
  test("drops calibration-source records for a guard that also has real fire-log records", () => {
    const records: RawFireRecord[] = [
      fireLogRecord({ guardName: CAUSAL_PREMISE_GUARD, source: "fire-log", timestamp: "T1" }),
      fireLogRecord({ guardName: CAUSAL_PREMISE_GUARD, source: "calibration", timestamp: "T2" }),
    ];
    const result = dedupeLegacyCalibrationOverlap(records);
    expect(result).toHaveLength(1);
    expect(result[0]?.source).toBe("fire-log");
  });

  test("keeps calibration-source records for a guard with NO real fire-log records", () => {
    const records: RawFireRecord[] = [
      fireLogRecord({ guardName: "policy-coverage-detector", source: "calibration" }),
      fireLogRecord({ guardName: "policy-coverage-detector", source: "calibration" }),
    ];
    const result = dedupeLegacyCalibrationOverlap(records);
    expect(result).toHaveLength(2);
  });

  test("real fire-log records for other guards are never dropped by an unrelated guard's overlap", () => {
    const records: RawFireRecord[] = [
      fireLogRecord({ guardName: GUARD_A, source: "fire-log" }),
      fireLogRecord({ guardName: GUARD_A, source: "calibration" }),
      fireLogRecord({ guardName: GUARD_B, source: "calibration" }),
    ];
    const result = dedupeLegacyCalibrationOverlap(records);
    expect(result).toHaveLength(2); // GUARD_A's fire-log record + GUARD_B's sole calibration record
    expect(result.filter((r) => r.guardName === GUARD_A)).toHaveLength(1);
    expect(result.filter((r) => r.guardName === GUARD_B)).toHaveLength(1);
  });
});

describe("computeCadenceRecommendation", () => {
  test("first review holds the RFC's quarterly (90-day) default and cites observed volume", () => {
    const result = computeCadenceRecommendation({
      totalFires: 3517,
      distinctGuardsWithFires: 37,
      corpusWindowDays: 30,
    });
    expect(result.recommendedDays).toBe(90);
    expect(result.rationale).toContain("3517");
    expect(result.rationale).toContain("37");
    expect(result.rationale).toContain("quarterly");
  });

  test("an all-quiet prior review doubles the interval, capped at 365 days", () => {
    const result = computeCadenceRecommendation({
      totalFires: 100,
      distinctGuardsWithFires: 10,
      corpusWindowDays: 90,
      priorReviewAllQuiet: true,
      priorRecommendedDays: 90,
    });
    expect(result.recommendedDays).toBe(180);

    const cappedResult = computeCadenceRecommendation({
      totalFires: 100,
      distinctGuardsWithFires: 10,
      corpusWindowDays: 300,
      priorReviewAllQuiet: true,
      priorRecommendedDays: 300,
    });
    expect(cappedResult.recommendedDays).toBe(365);
  });
});
