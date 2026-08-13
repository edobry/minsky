/**
 * Unit tests for the interceptor state + attention-count derivation (mt#4057).
 *
 * The load-bearing cases are the ones where two situations look alike and mean
 * different things: dormant vs deterrent (both quiet), never-verified vs
 * canary-unavailable (both without a verdict), and a zero count vs an
 * unavailable one. mt#3754 AT2 is the second test below.
 */
import { describe, expect, test } from "bun:test";
import {
  computeAttentionCounts,
  deriveInterceptorCost,
  deriveInterceptorState,
  isGraduationOverdue,
  type AttentionCounts,
} from "./interceptor-state";
import type {
  CanaryStatusJoin,
  InterceptorAggregateRow,
  InterceptorAggregatesSnapshot,
} from "./aggregates";

function row(
  overrides: {
    guardName?: string;
    windowFires?: number;
    lifetimeFires?: number;
    lastFireAt?: string | null;
    canary?: CanaryStatusJoin | null;
    duration?: InterceptorAggregateRow["fireLog"]["window"]["duration"];
  } = {}
): InterceptorAggregateRow {
  return {
    guardName: overrides.guardName ?? "some-guard",
    fireLog: {
      window: {
        days: 7,
        fires: overrides.windowFires ?? 0,
        byDecision: { allow: 0, warn: 0, deny: 0, other: 0 },
        overrides: { total: 0, byEnvVar: {} },
        duration: overrides.duration ?? null,
      },
      lifetime: {
        totalFires: overrides.lifetimeFires ?? 0,
        firstFireAt: null,
        lastFireAt: overrides.lastFireAt ?? null,
      },
    },
    canary: overrides.canary === undefined ? { state: "passing" } : overrides.canary,
    health: null,
    calibration: null,
    registry: null,
  };
}

describe("deriveInterceptorState", () => {
  test("a broken canary is BROKEN regardless of fire counts, and carries brokenSinceAt", () => {
    const state = deriveInterceptorState(
      row({
        windowFires: 4000,
        lifetimeFires: 90000,
        canary: {
          state: "broken",
          brokenSinceAt: "2026-08-11T03:00:00.000Z",
          lastCheckedAt: "2026-08-13T03:00:00.000Z",
        },
      })
    );
    expect(state.kind).toBe("broken");
    expect(state.brokenSinceAt).toBe("2026-08-11T03:00:00.000Z");
    // The fire-count-derived figures are untouched by the broken verdict
    // (mt#3754 AT1: "its fire-count-derived row is unchanged").
    expect(state.windowFires).toBe(4000);
    expect(state.lifetimeFires).toBe(90000);
  });

  test("mt#3754 AT2: zero fires + a passing canary is DORMANT, not broken and not healthy-by-default", () => {
    const state = deriveInterceptorState(
      row({
        windowFires: 0,
        lifetimeFires: 0,
        canary: { state: "passing", lastVerifiedAt: "2026-08-13T03:00:00.000Z" },
      })
    );
    expect(state.kind).toBe("dormant");
    expect(state.lastVerifiedAt).toBe("2026-08-13T03:00:00.000Z");
  });

  test("quiet in the window but fired before is DETERRENT, which dormant must not absorb", () => {
    const state = deriveInterceptorState(
      row({ windowFires: 0, lifetimeFires: 312, lastFireAt: "2026-06-02T10:00:00.000Z" })
    );
    expect(state.kind).toBe("deterrent");
    expect(state.lastFireAt).toBe("2026-06-02T10:00:00.000Z");
  });

  test("fires in the window with a passing canary is ACTIVE", () => {
    expect(deriveInterceptorState(row({ windowFires: 7, lifetimeFires: 900 })).kind).toBe("active");
  });

  test("never-verified and canary-unavailable are DIFFERENT kinds", () => {
    expect(deriveInterceptorState(row({ canary: { state: "never-verified" } })).kind).toBe(
      "never-verified"
    );
    expect(deriveInterceptorState(row({ canary: null })).kind).toBe("canary-unavailable");
  });

  test("an unrecognized canary state is never read as working", () => {
    // A vocabulary this module does not know must not produce active/deterrent/
    // dormant — all three assert the thing WORKS.
    const state = deriveInterceptorState(
      row({ windowFires: 50, canary: { state: "quarantined" } })
    );
    expect(state.kind).toBe("never-verified");
  });

  test("a malformed timestamp degrades to null instead of throwing", () => {
    const state = deriveInterceptorState(
      row({ canary: { state: "broken", brokenSinceAt: 1723500000000 as unknown as string } })
    );
    expect(state.kind).toBe("broken");
    expect(state.brokenSinceAt).toBeNull();
  });
});

describe("isGraduationOverdue", () => {
  test("splits the sweep's four reasons by mechanism", () => {
    expect(isGraduationOverdue("never-reviewed")).toBe(true);
    expect(isGraduationOverdue("never-fired")).toBe(true);
    expect(isGraduationOverdue("past-threshold")).toBe(false);
    expect(isGraduationOverdue("time-stale")).toBe(false);
  });
});

type CountableSnapshot = Pick<
  InterceptorAggregatesSnapshot,
  "rows" | "declaredOnlyRows" | "calibrationReviewDue" | "sourceFailures"
>;

function snapshot(overrides: Partial<CountableSnapshot> = {}): CountableSnapshot {
  return {
    rows: overrides.rows ?? [],
    declaredOnlyRows: overrides.declaredOnlyRows ?? [],
    calibrationReviewDue: overrides.calibrationReviewDue ?? [],
    sourceFailures: overrides.sourceFailures ?? [],
  };
}

function due(reason: string, logName = "some-log") {
  return { logName, mappedGuardName: logName, reason, injectedFiresSinceLastReview: 3 };
}

describe("computeAttentionCounts", () => {
  test("counts each attention class from its own source", () => {
    const counts = computeAttentionCounts(
      snapshot({
        rows: [
          row({
            guardName: "a",
            canary: { state: "broken", brokenSinceAt: "2026-08-11T00:00:00Z" },
          }),
          row({ guardName: "b", canary: { state: "never-verified" } }),
          row({ guardName: "c", canary: { state: "never-verified" } }),
          row({ guardName: "d", windowFires: 5 }),
        ],
        calibrationReviewDue: [
          due("past-threshold", "l1"),
          due("time-stale", "l2"),
          due("never-fired", "l3"),
        ],
      })
    );
    const expected: AttentionCounts = {
      broken: 1,
      neverVerified: 2,
      reviewDue: 2,
      graduationOverdue: 1,
    };
    expect(counts).toEqual(expected);
  });

  test("declared-but-never-fired rows are counted too — they are the unwatched ones", () => {
    // A never-fired interceptor appears only in `declaredOnlyRows`; counting
    // `rows` alone would report 0 broken while a declared guard is broken.
    const counts = computeAttentionCounts(
      snapshot({
        rows: [row({ guardName: "busy", windowFires: 10 })],
        declaredOnlyRows: [
          row({
            guardName: "quiet-broken",
            canary: { state: "broken", brokenSinceAt: "2026-08-01T00:00:00Z" },
          }),
          row({ guardName: "quiet-unverified", canary: { state: "never-verified" } }),
        ],
      })
    );
    expect(counts.broken).toBe(1);
    expect(counts.neverVerified).toBe(1);
  });

  test("a failed canary source yields null, NOT zero", () => {
    // Zero would read as "nothing is broken" — the exact false reassurance the
    // absent-as-absent convention exists to prevent.
    const counts = computeAttentionCounts(
      snapshot({ rows: [row({ canary: null })], sourceFailures: ["canary"] })
    );
    expect(counts.broken).toBeNull();
    expect(counts.neverVerified).toBeNull();
    // The calibration counts are unaffected by an unrelated source's failure.
    expect(counts.reviewDue).toBe(0);
    expect(counts.graduationOverdue).toBe(0);
  });

  test("a failed calibration source yields null, since its empty list is ambiguous", () => {
    const counts = computeAttentionCounts(snapshot({ sourceFailures: ["calibration"] }));
    expect(counts.reviewDue).toBeNull();
    expect(counts.graduationOverdue).toBeNull();
    expect(counts.broken).toBe(0);
  });
});

describe("deriveInterceptorCost", () => {
  test("returns null when no window row carried a duration", () => {
    expect(deriveInterceptorCost(row({ windowFires: 12 }))).toBeNull();
  });

  test("reports the denominator the figure was measured over", () => {
    const cost = deriveInterceptorCost(
      row({
        windowFires: 400,
        duration: { avgMs: 12.5, p95Ms: 30, maxMs: 88, totalMs: 150, measuredFires: 12 },
      })
    );
    expect(cost).not.toBeNull();
    expect(cost?.totalMs).toBe(150);
    expect(cost?.measuredFires).toBe(12);
    // 388 fires carried no duration and are outside the figure — rendering the
    // total without this would overstate its coverage.
    expect(cost?.unmeasuredFires).toBe(388);
  });

  test("never reports a negative unmeasured count if the denominator exceeds the window count", () => {
    const cost = deriveInterceptorCost(
      row({
        windowFires: 2,
        duration: { avgMs: 1, p95Ms: 1, maxMs: 1, totalMs: 5, measuredFires: 5 },
      })
    );
    expect(cost?.unmeasuredFires).toBe(0);
  });
});
