/**
 * Unit tests for response-labeling.ts pure logic (mt#3583, ADR-032 §D2).
 *
 * In-memory only — this module has no fs/DB seam and reads no clock, so
 * isolation is automatic.
 *
 * The end-to-end property these pin: a corpus in which the agent kept tripping a
 * guard produces a bounded threshold proposal through the shipped decider, and
 * the same corpus in which it stopped does not.
 */

import { describe, test, expect } from "bun:test";
import {
  labelFires,
  toGuardEvaluations,
  toThresholdObservations,
  summarizeLabels,
  type GuardEvaluation,
} from "./response-labeling";
import { proposeThresholdAdjustment, MIN_LABELED_OBSERVATIONS } from "./threshold-tuning";

const GUARD = "silent-stretch-detector";
const OTHER_GUARD = "wall-of-text-detector";
const SESSION_A = "session-a";
const SESSION_B = "session-b";

function evaluation(overrides: Partial<GuardEvaluation> = {}): GuardEvaluation {
  return {
    timestamp: "2026-07-30T12:00:00.000Z",
    guardName: GUARD,
    sessionId: SESSION_A,
    observedValue: 12,
    fired: true,
    ...overrides,
  };
}

/** Minutes past a fixed base — keeps the ordering readable in each test. */
function at(minute: number): string {
  return new Date(Date.UTC(2026, 6, 30, 12, minute, 0)).toISOString();
}

describe("labelFires — the three bases", () => {
  test("a fire followed by another fire is dismissed", () => {
    const labeled = labelFires([
      evaluation({ timestamp: at(0) }),
      evaluation({ timestamp: at(5) }),
    ]);

    expect(labeled[0]?.response).toBe("dismissed");
    expect(labeled[0]?.basis).toBe("next-evaluation-fired");
  });

  test("a fire followed by a non-firing evaluation is heeded", () => {
    const labeled = labelFires([
      evaluation({ timestamp: at(0) }),
      evaluation({ timestamp: at(5), fired: false, observedValue: 3 }),
    ]);

    expect(labeled).toHaveLength(1);
    expect(labeled[0]?.response).toBe("heeded");
    expect(labeled[0]?.basis).toBe("next-evaluation-did-not-fire");
  });

  test("a fire with nothing after it is unknown", () => {
    const labeled = labelFires([evaluation({ timestamp: at(0) })]);

    expect(labeled[0]?.response).toBe("unknown");
    expect(labeled[0]?.basis).toBe("no-subsequent-evaluation");
  });

  test("non-fire evaluations are evidence, never labeled themselves", () => {
    const labeled = labelFires([
      evaluation({ timestamp: at(0), fired: false }),
      evaluation({ timestamp: at(5), fired: false }),
    ]);

    expect(labeled).toEqual([]);
  });
});

describe("labelFires — sequencing boundaries", () => {
  test("evidence does not cross session boundaries", () => {
    // Session A's fire is last in ITS session; session B's later fire must not
    // be read as evidence about it.
    const labeled = labelFires([
      evaluation({ timestamp: at(0), sessionId: SESSION_A }),
      evaluation({ timestamp: at(5), sessionId: SESSION_B }),
    ]);

    expect(labeled).toHaveLength(2);
    for (const fire of labeled) expect(fire.response).toBe("unknown");
  });

  test("evidence does not cross guard boundaries", () => {
    const labeled = labelFires([
      evaluation({ timestamp: at(0), guardName: GUARD }),
      evaluation({ timestamp: at(5), guardName: OTHER_GUARD, fired: false }),
    ]);

    const own = labeled.find((f) => f.guardName === GUARD);
    expect(own?.response).toBe("unknown");
  });

  test("input order does not matter — sequencing is by timestamp", () => {
    const outOfOrder = labelFires([
      evaluation({ timestamp: at(5), fired: false, observedValue: 3 }),
      evaluation({ timestamp: at(0) }),
    ]);

    expect(outOfOrder).toHaveLength(1);
    expect(outOfOrder[0]?.response).toBe("heeded");
  });

  test("a fire with no session id is labeled unknown rather than dropped", () => {
    const labeled = labelFires([
      evaluation({ timestamp: at(0), sessionId: null }),
      evaluation({ timestamp: at(5), sessionId: "" }),
    ]);

    expect(labeled).toHaveLength(2);
    for (const fire of labeled) {
      expect(fire.response).toBe("unknown");
      expect(fire.basis).toBe("unsequenceable");
    }
  });

  test("a non-fire with no session id is discarded entirely", () => {
    expect(labelFires([evaluation({ fired: false, sessionId: null })])).toEqual([]);
  });

  // PR #2569 R1. An unparseable timestamp used to sort to the END of its group,
  // which made it the "next evaluation" of the genuinely-last fire — silently
  // relabeling that fire off a junk record.
  test("an unparseable timestamp cannot become the next evaluation of a real fire", () => {
    const labeled = labelFires([
      evaluation({ timestamp: at(0) }),
      evaluation({ timestamp: "not-a-timestamp", fired: false }),
    ]);

    const realFire = labeled.find((f) => f.timestamp === at(0));
    expect(realFire?.response).toBe("unknown");
    expect(realFire?.basis).toBe("no-subsequent-evaluation");
  });

  test("a FIRE with an unparseable timestamp is surfaced as unsequenceable", () => {
    const labeled = labelFires([evaluation({ timestamp: "not-a-timestamp" })]);

    expect(labeled).toHaveLength(1);
    expect(labeled[0]?.basis).toBe("unsequenceable");
    expect(labeled[0]?.response).toBe("unknown");
  });
});

/**
 * PR #2569 R1 — the emit and consume shapes differ, and nothing bridged them
 * before this adapter, so the two halves of this task did not actually connect.
 */
describe("toGuardEvaluations — bridging the emitted record shape", () => {
  const emitted = {
    timestamp: at(0),
    session_id: SESSION_A,
    guardName: GUARD,
    turnAnchor: "a::b",
    gapMinutes: 8.43,
    toolCallCount: 18,
    fired: true,
  };

  test("maps session_id onto sessionId and selects the named measured field", () => {
    const [byGap] = toGuardEvaluations([emitted], "gapMinutes");
    expect(byGap?.sessionId).toBe(SESSION_A);
    expect(byGap?.observedValue).toBe(8.43);
    expect(byGap?.fired).toBe(true);

    // The SAME record answers a different threshold's question differently —
    // which is why the record cannot carry a single `observedValue` itself.
    const [byCalls] = toGuardEvaluations([emitted], "toolCallCount");
    expect(byCalls?.observedValue).toBe(18);
  });

  test("a missing or non-finite measured field yields null, never a coerced number", () => {
    const [missing] = toGuardEvaluations([emitted], "notAField");
    expect(missing?.observedValue).toBeNull();

    const [nonFinite] = toGuardEvaluations([{ ...emitted, gapMinutes: NaN }], "gapMinutes");
    expect(nonFinite?.observedValue).toBeNull();
  });

  test("a record missing fired is not treated as a fire", () => {
    const [noFired] = toGuardEvaluations([{ ...emitted, fired: undefined }], "gapMinutes");
    expect(noFired?.fired).toBe(false);
  });

  test("round-trips an emitted corpus through labeling into the decider's input", () => {
    const records = [
      { ...emitted, timestamp: at(0), fired: true },
      { ...emitted, timestamp: at(5), fired: true },
      { ...emitted, timestamp: at(10), fired: false, gapMinutes: 2 },
    ];

    const labeled = labelFires(toGuardEvaluations(records, "gapMinutes"));
    expect(summarizeLabels(labeled)).toEqual({ heeded: 1, dismissed: 1, unknown: 0 });
    expect(toThresholdObservations(labeled, GUARD)).toHaveLength(2);
  });
});

describe("toThresholdObservations", () => {
  test("selects one guard and carries its labels through", () => {
    const labeled = labelFires([
      evaluation({ timestamp: at(0) }),
      evaluation({ timestamp: at(5) }),
      evaluation({ timestamp: at(10), guardName: OTHER_GUARD }),
    ]);

    const observations = toThresholdObservations(labeled, GUARD);
    expect(observations).toHaveLength(2);
    expect(observations[0]?.response).toBe("dismissed");
  });

  test("fires with no numeric observed value are dropped, not zero-filled", () => {
    const labeled = labelFires([
      evaluation({ timestamp: at(0), observedValue: null }),
      evaluation({ timestamp: at(5), observedValue: 14 }),
    ]);

    const observations = toThresholdObservations(labeled, GUARD);
    expect(observations).toHaveLength(1);
    expect(observations[0]?.observedValue).toBe(14);
  });
});

describe("summarizeLabels", () => {
  test("counts every response class, including the zero ones", () => {
    const labeled = labelFires([
      evaluation({ timestamp: at(0) }),
      evaluation({ timestamp: at(5) }),
      evaluation({ timestamp: at(10), fired: false }),
    ]);

    expect(summarizeLabels(labeled)).toEqual({ heeded: 1, dismissed: 1, unknown: 0 });
  });
});

/**
 * The property that matters: labeling plus the shipped decider produce a bounded
 * threshold move on a corpus where the agent kept tripping the guard, and no
 * move on one where it stopped. Neither half is useful alone — ADR-032 shipped
 * the decider inert for exactly this reason.
 */
describe("end-to-end with the shipped decider", () => {
  const tuningInput = (observations: ReturnType<typeof toThresholdObservations>) => ({
    guardName: GUARD,
    thresholdKey: "MINSKY_SILENT_STRETCH_GAP_MINUTES",
    tuningOwnership: "preference" as const,
    shippedDefault: 10,
    direction: "raise-to-silence" as const,
    observations,
  });

  test("a corpus of repeated fires produces a bounded proposal", () => {
    // Eight consecutive fires: each is followed by another fire, so the first
    // seven label `dismissed` and the last `unknown`.
    const evaluations = Array.from({ length: 8 }, (_, i) =>
      evaluation({ timestamp: at(i * 5), observedValue: 12 + i })
    );

    const labeled = labelFires(evaluations);
    expect(summarizeLabels(labeled)).toEqual({ heeded: 0, dismissed: 7, unknown: 1 });

    const decision = proposeThresholdAdjustment(
      tuningInput(toThresholdObservations(labeled, GUARD))
    );

    expect(decision.kind).toBe("proposal");
    if (decision.kind !== "proposal") return;
    expect(decision.proposedValue).toBeGreaterThan(10);
    expect(decision.proposedValue).toBeLessThanOrEqual(100);
    expect(decision.basis.dismissedCount).toBe(7);
  });

  test("a corpus where the agent complied produces no proposal", () => {
    // Each fire is followed by a non-firing evaluation, so every label is
    // `heeded` and the dismissal rate sits at zero.
    const evaluations = Array.from({ length: 12 }, (_, i) =>
      evaluation({
        timestamp: at(i * 5),
        observedValue: i % 2 === 0 ? 12 : 3,
        fired: i % 2 === 0,
      })
    );

    const labeled = labelFires(evaluations);
    expect(summarizeLabels(labeled).heeded).toBe(6);
    expect(summarizeLabels(labeled).dismissed).toBe(0);

    const decision = proposeThresholdAdjustment(
      tuningInput(toThresholdObservations(labeled, GUARD))
    );

    expect(decision.kind).toBe("no-change");
    if (decision.kind !== "no-change") return;
    expect(decision.reasons[0]).toContain("dismissal-rate-within-budget");
  });

  test("an all-unknown corpus cannot move a threshold no matter how large", () => {
    // Every fire is the last in its own session — the shape a fire-only corpus
    // degenerates to, and the reason this module reads evaluations instead.
    const evaluations = Array.from({ length: 50 }, (_, i) =>
      evaluation({ timestamp: at(i), sessionId: `session-${i}`, observedValue: 40 })
    );

    const labeled = labelFires(evaluations);
    expect(summarizeLabels(labeled)).toEqual({ heeded: 0, dismissed: 0, unknown: 50 });

    const decision = proposeThresholdAdjustment(
      tuningInput(toThresholdObservations(labeled, GUARD))
    );

    expect(decision.kind).toBe("no-change");
    if (decision.kind !== "no-change") return;
    expect(decision.reasons[0]).toContain("insufficient-labeled-observations");
    expect(decision.reasons[0]).toContain(`0 < ${MIN_LABELED_OBSERVATIONS}`);
  });
});
