/**
 * Unit tests for the pure snapshot assembly (mt#4009).
 *
 * The SQL fetchers are exercised live by `scripts/verify-interceptor-aggregates.ts`
 * (AT2: a sampled guard's aggregate equals the value recomputed from the
 * on-disk stream); these tests cover the merge semantics — absent-as-absent
 * joins, decision bucketing, and the mt#2758 failed-source-vs-no-data
 * distinction.
 */
import { describe, expect, test } from "bun:test";
import {
  assembleInterceptorAggregates,
  SNAPSHOT_SOURCES,
  toIsoOrNull,
  type AssembleInput,
} from "./aggregates";

/** Narrow an indexed access without a non-null assertion; throws on a genuinely missing value. */
function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("expected a value");
  return value;
}

function baseInput(overrides: Partial<AssembleInput> = {}): AssembleInput {
  return {
    computedAt: "2026-08-12T20:00:00.000Z",
    windowDays: 7,
    refreshDurationMs: 1234,
    decisionCounts: [],
    durations: [],
    lifetime: [],
    overrides: [],
    canaryByGuard: new Map(),
    healthByGuard: new Map(),
    calibrationByGuard: new Map(),
    registryByGuard: new Map(),
    calibrationReviewDue: [],
    ...overrides,
  };
}

describe("toIsoOrNull", () => {
  test("maps Dates and parseable strings to ISO-8601, everything else to null without throwing", () => {
    expect(toIsoOrNull(new Date("2026-08-12T20:00:00.000Z"))).toBe("2026-08-12T20:00:00.000Z");
    expect(toIsoOrNull("2026-08-12T20:00:00.000Z")).toBe("2026-08-12T20:00:00.000Z");
    // PR #2939 R1: an unparseable string used to reach Invalid Date's
    // toISOString(), which throws a RangeError.
    expect(toIsoOrNull("not-a-date")).toBeNull();
    expect(toIsoOrNull(new Date("not-a-date"))).toBeNull();
    expect(toIsoOrNull("")).toBeNull();
    expect(toIsoOrNull(42)).toBeNull();
    expect(toIsoOrNull(null)).toBeNull();
    expect(toIsoOrNull(undefined)).toBeNull();
  });
});

describe("assembleInterceptorAggregates", () => {
  test("population is the lifetime row set, sorted by guard name", () => {
    const snapshot = assembleInterceptorAggregates(
      baseInput({
        lifetime: [
          { guardName: "zeta", totalFires: 5, firstFireAt: null, lastFireAt: null },
          { guardName: "alpha", totalFires: 9, firstFireAt: null, lastFireAt: null },
        ],
      })
    );
    expect(snapshot.population).toBe(2);
    expect(snapshot.rows.map((r) => r.guardName)).toEqual(["alpha", "zeta"]);
  });

  test("declared names absent from the fire log become declaredOnlyRows, not rows (mt#4057)", () => {
    const NEVER_FIRED_LAST = "zulu-never-fired";
    const snapshot = assembleInterceptorAggregates(
      baseInput({
        lifetime: [{ guardName: "has-fired", totalFires: 5, firstFireAt: null, lastFireAt: null }],
        declaredNames: [NEVER_FIRED_LAST, "has-fired", "alpha-never-fired"],
        canaryByGuard: new Map([[NEVER_FIRED_LAST, { state: "passing" }]]),
      })
    );
    // `population` stays the fire-log count — folding the declared-only names
    // in would silently redefine SC3's population.
    expect(snapshot.population).toBe(1);
    expect(snapshot.rows.map((r) => r.guardName)).toEqual(["has-fired"]);
    expect(snapshot.declaredOnlyRows.map((r) => r.guardName)).toEqual([
      "alpha-never-fired",
      NEVER_FIRED_LAST,
    ]);
    // Their fire-log figures are measured zeros, and their joins are real.
    expect(must(snapshot.declaredOnlyRows[1]).fireLog.lifetime.totalFires).toBe(0);
    expect(must(snapshot.declaredOnlyRows[1]).fireLog.window.fires).toBe(0);
    expect(must(snapshot.declaredOnlyRows[1]).canary).toEqual({ state: "passing" });
  });

  test("declaredNames omitted leaves the snapshot fire-log-only", () => {
    const snapshot = assembleInterceptorAggregates(
      baseInput({
        lifetime: [{ guardName: "only", totalFires: 1, firstFireAt: null, lastFireAt: null }],
      })
    );
    expect(snapshot.declaredOnlyRows).toEqual([]);
  });

  test("decision counts bucket allow/warn/deny and collapse the rest to other", () => {
    const snapshot = assembleInterceptorAggregates(
      baseInput({
        lifetime: [{ guardName: "g", totalFires: 10, firstFireAt: null, lastFireAt: null }],
        decisionCounts: [
          { guardName: "g", decision: "allow", fires: 4 },
          { guardName: "g", decision: "deny", fires: 2 },
          { guardName: "g", decision: "warn", fires: 1 },
          { guardName: "g", decision: null, fires: 2 },
          { guardName: "g", decision: "ask", fires: 1 },
        ],
      })
    );
    const window = must(snapshot.rows[0]).fireLog.window;
    expect(window.fires).toBe(10);
    expect(window.byDecision).toEqual({ allow: 4, warn: 1, deny: 2, other: 3 });
  });

  test("override rows accumulate per env var and total", () => {
    const snapshot = assembleInterceptorAggregates(
      baseInput({
        lifetime: [{ guardName: "g", totalFires: 3, firstFireAt: null, lastFireAt: null }],
        overrides: [
          { guardName: "g", overrideEnvVar: "MINSKY_SKIP_A", fires: 2 },
          { guardName: "g", overrideEnvVar: "MINSKY_SKIP_B", fires: 1 },
        ],
      })
    );
    const overrides = must(snapshot.rows[0]).fireLog.window.overrides;
    expect(overrides.total).toBe(3);
    expect(overrides.byEnvVar).toEqual({ MINSKY_SKIP_A: 2, MINSKY_SKIP_B: 1 });
  });

  test("a guard with lifetime history but no window activity gets a zeroed window, not nulls", () => {
    const snapshot = assembleInterceptorAggregates(
      baseInput({
        lifetime: [
          {
            guardName: "dormant",
            totalFires: 100,
            firstFireAt: "2026-05-01T00:00:00.000Z",
            lastFireAt: "2026-06-01T00:00:00.000Z",
          },
        ],
      })
    );
    const row = must(snapshot.rows[0]);
    expect(row.fireLog.window.fires).toBe(0);
    expect(row.fireLog.window.duration).toBeNull();
    expect(row.fireLog.lifetime.totalFires).toBe(100);
  });

  test("a failed source is named in sourceFailures and null on every row", () => {
    const snapshot = assembleInterceptorAggregates(
      baseInput({
        lifetime: [{ guardName: "g", totalFires: 1, firstFireAt: null, lastFireAt: null }],
        canaryByGuard: null,
        healthByGuard: null,
      })
    );
    expect(snapshot.sourceFailures.sort()).toEqual(["canary", "health"]);
    expect(must(snapshot.rows[0]).canary).toBeNull();
    expect(must(snapshot.rows[0]).health).toBeNull();
    // Present sources with no entry for the guard are ALSO null on the row —
    // but NOT named as failures. The sourceFailures list is what separates
    // "query layer broken" from "genuinely no data" (mt#2758).
    expect(must(snapshot.rows[0]).calibration).toBeNull();
    expect(snapshot.sourceFailures).not.toContain("calibration");
  });

  test("present joins attach by guard name; absent guards stay null", () => {
    const snapshot = assembleInterceptorAggregates(
      baseInput({
        lifetime: [
          { guardName: "a", totalFires: 1, firstFireAt: null, lastFireAt: null },
          { guardName: "b", totalFires: 1, firstFireAt: null, lastFireAt: null },
        ],
        canaryByGuard: new Map([["a", { state: "passing" }]]),
        registryByGuard: new Map([["a", { registered: true, stratum: "registry" }]]),
        calibrationByGuard: new Map([
          [
            "a",
            [
              {
                logName: "a-log",
                totalFires: 12,
                firesSinceLastReview: 3,
                injectedFiresSinceLastReview: 2,
                reviewDue: true,
                reviewDueReason: "past-threshold",
                lastReviewedAt: "2026-08-01T00:00:00.000Z",
              },
            ],
          ],
        ]),
      })
    );
    const a = must(snapshot.rows[0]);
    const b = must(snapshot.rows[1]);
    expect(a.canary).toEqual({ state: "passing" });
    expect(a.registry).toEqual({ registered: true, stratum: "registry" });
    expect(a.calibration?.[0]?.reviewDue).toBe(true);
    expect(b.canary).toBeNull();
    expect(b.registry).toBeNull();
    expect(b.calibration).toBeNull();
    expect(snapshot.sourceFailures).toEqual([]);
  });

  test("snapshot carries the SC2 source map and the review-due passthrough", () => {
    const snapshot = assembleInterceptorAggregates(
      baseInput({
        calibrationReviewDue: [
          {
            logName: "wall-of-text",
            mappedGuardName: "wall-of-text-detector",
            reason: "past-threshold",
            injectedFiresSinceLastReview: 14,
          },
        ],
      })
    );
    expect(snapshot.sources).toEqual(SNAPSHOT_SOURCES);
    expect(snapshot.calibrationReviewDue).toHaveLength(1);
    expect(must(snapshot.calibrationReviewDue[0]).mappedGuardName).toBe("wall-of-text-detector");
  });

  test("null review-due input (failed calibration source) degrades to an empty list", () => {
    const snapshot = assembleInterceptorAggregates(
      baseInput({ calibrationByGuard: null, calibrationReviewDue: null })
    );
    expect(snapshot.calibrationReviewDue).toEqual([]);
    expect(snapshot.sourceFailures).toContain("calibration");
  });
});
