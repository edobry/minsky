/**
 * Unit tests for threshold-tuning.ts pure logic (mt#3577, ADR-032).
 *
 * All tests operate on in-memory data — no filesystem or DB I/O. This module
 * has no fs/DB seam at all (and reads no clock), so isolation is automatic.
 *
 * The two acceptance tests mt#3577's spec names are pinned directly:
 *   AT1 — a dismissal corpus against a `preference`-class guard produces a
 *         specific, bounded threshold change; the SAME corpus against an
 *         `invariant`-class guard produces none.
 */

import { describe, test, expect } from "bun:test";
import {
  proposeThresholdAdjustment,
  ATTRIBUTION_EPOCH_ISO,
  MIN_LABELED_OBSERVATIONS,
  PREFERENCE_OVERRIDE_MAX_MULTIPLE,
  type ThresholdObservation,
  type ThresholdTuningInput,
  type ThresholdTuningDecision,
  type ThresholdProposal,
} from "./threshold-tuning";

const AFTER_EPOCH = "2026-07-30T12:00:00.000Z";
const BEFORE_EPOCH = "2026-07-20T12:00:00.000Z";

function dismissed(observedValue: number, timestamp = AFTER_EPOCH): ThresholdObservation {
  return { timestamp, observedValue, response: "dismissed" };
}

function heeded(observedValue: number, timestamp = AFTER_EPOCH): ThresholdObservation {
  return { timestamp, observedValue, response: "heeded" };
}

function unlabeled(observedValue: number, timestamp = AFTER_EPOCH): ThresholdObservation {
  return { timestamp, observedValue, response: "unknown" };
}

/** A wall-of-text-shaped input: a ceiling guard whose shipped word budget is 200. */
function wallOfTextInput(overrides: Partial<ThresholdTuningInput> = {}): ThresholdTuningInput {
  return {
    guardName: "wall-of-text-detector",
    thresholdKey: "MINSKY_WALL_OF_TEXT_WORD_BUDGET",
    tuningOwnership: "preference",
    shippedDefault: 200,
    direction: "raise-to-silence",
    observations: [],
    ...overrides,
  };
}

/** Narrowing helper — keeps the assertions free of non-null assertions. */
function requireProposal(decision: ThresholdTuningDecision): ThresholdProposal {
  if (decision.kind !== "proposal") {
    throw new Error(`expected a proposal, got no-change: ${decision.reasons.join(", ")}`);
  }
  return decision;
}

describe("proposeThresholdAdjustment — ownership classes", () => {
  const dismissalCorpus = [
    dismissed(240),
    dismissed(255),
    dismissed(260),
    dismissed(275),
    dismissed(310),
    dismissed(330),
  ];

  test("AT1a: a dismissal corpus against a preference-class guard produces a bounded change", () => {
    const decision = proposeThresholdAdjustment(wallOfTextInput({ observations: dismissalCorpus }));
    const proposal = requireProposal(decision);

    expect(proposal.proposedValue).toBeGreaterThan(proposal.currentValue);
    expect(proposal.proposedValue).toBeLessThanOrEqual(200 * PREFERENCE_OVERRIDE_MAX_MULTIPLE);
    expect(proposal.basis.dismissedCount).toBe(6);
    expect(proposal.basis.dismissedRate).toBe(1);
    // p90 over six sorted values is the sixth (nearest-rank), i.e. the largest.
    expect(proposal.proposedValue).toBe(330);
    expect(proposal.requiresConsent).toBe(true);
  });

  test("AT1b: the SAME corpus against an invariant-class guard produces no change", () => {
    const decision = proposeThresholdAdjustment(
      wallOfTextInput({
        guardName: "require-review-before-merge",
        thresholdKey: "MINSKY_SOME_INVARIANT_THRESHOLD",
        tuningOwnership: "invariant",
        observations: dismissalCorpus,
      })
    );

    expect(decision.kind).toBe("no-change");
    if (decision.kind !== "no-change") return;
    expect(decision.reasons).toContain("invariant-class-is-vendor-fixed");
  });

  test("advisory-class moves apply without a consent question", () => {
    const proposal = requireProposal(
      proposeThresholdAdjustment(
        wallOfTextInput({ tuningOwnership: "advisory", observations: dismissalCorpus })
      )
    );
    expect(proposal.requiresConsent).toBe(false);
  });

  test("the invariant check precedes the corpus checks — an empty corpus still names the class", () => {
    const decision = proposeThresholdAdjustment(
      wallOfTextInput({ tuningOwnership: "invariant", observations: [] })
    );
    expect(decision.kind).toBe("no-change");
    if (decision.kind !== "no-change") return;
    expect(decision.reasons).toEqual(["invariant-class-is-vendor-fixed"]);
  });
});

describe("proposeThresholdAdjustment — cold start", () => {
  test("an entirely unlabeled corpus produces no change (today's real state)", () => {
    const decision = proposeThresholdAdjustment(
      wallOfTextInput({
        observations: [240, 255, 260, 275, 310, 330, 350, 400].map((v) => unlabeled(v)),
      })
    );

    expect(decision.kind).toBe("no-change");
    if (decision.kind !== "no-change") return;
    expect(decision.reasons[0]).toContain("insufficient-labeled-observations");
    expect(decision.reasons[0]).toContain("0 <");
  });

  test("fewer than the minimum labeled observations produces no change", () => {
    const observations = Array.from({ length: MIN_LABELED_OBSERVATIONS - 1 }, (_, i) =>
      dismissed(300 + i)
    );
    const decision = proposeThresholdAdjustment(wallOfTextInput({ observations }));

    expect(decision.kind).toBe("no-change");
    if (decision.kind !== "no-change") return;
    expect(decision.reasons[0]).toContain(
      `${MIN_LABELED_OBSERVATIONS - 1} < ${MIN_LABELED_OBSERVATIONS}`
    );
  });

  test("exactly the minimum labeled observations is enough", () => {
    const observations = Array.from({ length: MIN_LABELED_OBSERVATIONS }, (_, i) =>
      dismissed(300 + i)
    );
    expect(proposeThresholdAdjustment(wallOfTextInput({ observations })).kind).toBe("proposal");
  });

  test("a dismissal rate within the override budget produces no change", () => {
    // 1 dismissed of 10 labeled = 0.1, at or under the 0.2 budget.
    const observations = [dismissed(400), ...Array.from({ length: 9 }, () => heeded(150))];
    const decision = proposeThresholdAdjustment(wallOfTextInput({ observations }));

    expect(decision.kind).toBe("no-change");
    if (decision.kind !== "no-change") return;
    expect(decision.reasons[0]).toContain("dismissal-rate-within-budget");
  });
});

describe("proposeThresholdAdjustment — provenance epoch", () => {
  test("observations older than the attribution epoch are discarded", () => {
    const decision = proposeThresholdAdjustment(
      wallOfTextInput({
        observations: [240, 255, 260, 275, 310, 330].map((v) => dismissed(v, BEFORE_EPOCH)),
      })
    );

    expect(decision.kind).toBe("no-change");
    if (decision.kind !== "no-change") return;
    expect(decision.reasons[0]).toContain("insufficient-labeled-observations");
    expect(decision.reasons).toContain("discarded-pre-attribution-epoch (6)");
  });

  test("an observation exactly at the epoch is kept", () => {
    const observations = Array.from({ length: MIN_LABELED_OBSERVATIONS }, (_, i) =>
      dismissed(300 + i, ATTRIBUTION_EPOCH_ISO)
    );
    expect(proposeThresholdAdjustment(wallOfTextInput({ observations })).kind).toBe("proposal");
  });

  test("an unparseable timestamp is discarded rather than treated as recent", () => {
    const observations = Array.from({ length: MIN_LABELED_OBSERVATIONS }, () =>
      dismissed(300, "not-a-timestamp")
    );
    const decision = proposeThresholdAdjustment(wallOfTextInput({ observations }));

    expect(decision.kind).toBe("no-change");
    if (decision.kind !== "no-change") return;
    expect(decision.reasons).toContain(
      `discarded-pre-attribution-epoch (${MIN_LABELED_OBSERVATIONS})`
    );
  });
});

describe("proposeThresholdAdjustment — bounds", () => {
  test("a runaway dismissal corpus is clamped to 10x the SHIPPED default", () => {
    const proposal = requireProposal(
      proposeThresholdAdjustment(
        wallOfTextInput({
          observations: [5000, 6000, 7000, 8000, 9000, 12000].map((v) => dismissed(v)),
        })
      )
    );

    expect(proposal.proposedValue).toBe(2000);
    expect(proposal.basis.clampedToBound).toBe(true);
  });

  test("the bound is computed from the shipped default, not from a raised current value", () => {
    const proposal = requireProposal(
      proposeThresholdAdjustment(
        wallOfTextInput({
          currentValue: 1900,
          observations: [5000, 6000, 7000, 8000, 9000, 12000].map((v) => dismissed(v)),
        })
      )
    );

    // 1900 * 10 would be 19000; the shipped default (200) is what bounds it.
    expect(proposal.proposedValue).toBe(2000);
  });

  test("a heeded observation holds the move back below it", () => {
    const proposal = requireProposal(
      proposeThresholdAdjustment(
        wallOfTextInput({
          observations: [
            dismissed(240),
            dismissed(255),
            dismissed(260),
            dismissed(275),
            dismissed(310),
            dismissed(330),
            heeded(300),
          ],
        })
      )
    );

    expect(proposal.proposedValue).toBe(299);
    expect(proposal.basis.clampedByHeeded).toBe(true);
  });

  test("a heeded observation at or below the current value blocks the move entirely", () => {
    const decision = proposeThresholdAdjustment(
      wallOfTextInput({
        observations: [
          dismissed(240),
          dismissed(255),
          dismissed(260),
          dismissed(275),
          dismissed(310),
          dismissed(330),
          heeded(150),
        ],
      })
    );

    expect(decision.kind).toBe("no-change");
    if (decision.kind !== "no-change") return;
    expect(decision.reasons).toContain("heeded-observations-block-the-move");
  });

  test("a corpus already below the current threshold implies no move", () => {
    const decision = proposeThresholdAdjustment(
      wallOfTextInput({
        currentValue: 400,
        observations: [240, 255, 260, 275, 310, 330].map((v) => dismissed(v)),
      })
    );

    expect(decision.kind).toBe("no-change");
    if (decision.kind !== "no-change") return;
    expect(decision.reasons).toContain("corpus-implies-no-move");
  });
});

describe("proposeThresholdAdjustment — floor guards", () => {
  const floorInput = (overrides: Partial<ThresholdTuningInput> = {}): ThresholdTuningInput => ({
    guardName: "hypothetical-coverage-floor",
    thresholdKey: "MINSKY_HYPOTHETICAL_COVERAGE_FLOOR",
    tuningOwnership: "preference",
    shippedDefault: 100,
    direction: "lower-to-silence",
    observations: [],
    ...overrides,
  });

  test("a floor guard is silenced by lowering, and clamps at default/10", () => {
    const proposal = requireProposal(
      proposeThresholdAdjustment(
        floorInput({ observations: [1, 2, 3, 4, 5, 6].map((v) => dismissed(v)) })
      )
    );

    expect(proposal.proposedValue).toBe(10);
    expect(proposal.basis.clampedToBound).toBe(true);
    expect(proposal.proposedValue).toBeLessThan(proposal.currentValue);
  });

  test("a heeded observation holds a floor guard's move above it", () => {
    const proposal = requireProposal(
      proposeThresholdAdjustment(
        floorInput({
          observations: [
            dismissed(60),
            dismissed(65),
            dismissed(70),
            dismissed(75),
            dismissed(80),
            dismissed(85),
            heeded(62),
          ],
        })
      )
    );

    expect(proposal.proposedValue).toBe(63);
    expect(proposal.basis.clampedByHeeded).toBe(true);
  });
});
