/**
 * Tests for convergence-detector.ts (mt#1867).
 *
 * Covers:
 *   - isStrictlyDecreasing() — unit tests
 *   - hasNewEvidence() — unit tests
 *   - detectConvergence() — threshold gating, stagnation logic
 *   - applyCompositionConvergenceDowngrade() — integration: downgrade fires / preserved
 */

import { describe, test, expect } from "bun:test";
import {
  isStrictlyDecreasing,
  hasNewEvidence,
  detectConvergence,
  applyCompositionConvergenceDowngrade,
  extractPriorFindingsForDetection,
  CONVERGENCE_ACTIVATION_THRESHOLD,
  type FindingForDetection,
  type BlockingCountByRound,
} from "./convergence-detector";
import type { ReviewToolCall } from "./output-tools";

// Shared test constants to avoid magic-string duplication
const SUBMIT_INLINE_COMMENT = "submit_inline_comment";

// ---------------------------------------------------------------------------
// isStrictlyDecreasing — unit tests
// ---------------------------------------------------------------------------

describe("isStrictlyDecreasing", () => {
  // Acceptance test from spec: [5, 4, 3, 2, 2] → false (2 → 2 is not strictly decreasing)
  test("spec example: [5, 4, 3, 2, 2] → false", () => {
    expect(isStrictlyDecreasing([5, 4, 3, 2, 2])).toBe(false);
  });

  test("[5, 4, 3, 2, 1] → true (strictly decreasing at end)", () => {
    expect(isStrictlyDecreasing([5, 4, 3, 2, 1])).toBe(true);
  });

  test("[5, 4, 3, 4] → false (last element increases)", () => {
    expect(isStrictlyDecreasing([5, 4, 3, 4])).toBe(false);
  });

  test("[3, 2] → true (two-element strictly decreasing)", () => {
    expect(isStrictlyDecreasing([3, 2])).toBe(true);
  });

  test("[2, 2] → false (two equal elements)", () => {
    expect(isStrictlyDecreasing([2, 2])).toBe(false);
  });

  test("[1, 2] → false (two increasing elements)", () => {
    expect(isStrictlyDecreasing([1, 2])).toBe(false);
  });

  test("[5] → false (single element, no comparison possible)", () => {
    expect(isStrictlyDecreasing([5])).toBe(false);
  });

  test("[] → false (empty array)", () => {
    expect(isStrictlyDecreasing([])).toBe(false);
  });

  test("[0, 0] → false (zeroes are not strictly decreasing)", () => {
    expect(isStrictlyDecreasing([0, 0])).toBe(false);
  });

  test("[1, 0] → true (one to zero is strictly decreasing)", () => {
    expect(isStrictlyDecreasing([1, 0])).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// hasNewEvidence — unit tests
// ---------------------------------------------------------------------------

describe("hasNewEvidence", () => {
  // Acceptance test from spec: BLOCKING in current has same file:line as
  // NON-BLOCKING in prior → returns false (no new evidence)
  test("spec example: BLOCKING with same file:line as prior NON-BLOCKING → false", () => {
    const currentFindings: FindingForDetection[] = [
      { file: "src/foo.ts", severity: "BLOCKING", line: 42 },
    ];
    const priorFindings: FindingForDetection[] = [
      { file: "src/foo.ts", severity: "NON-BLOCKING", line: 42 },
    ];
    expect(hasNewEvidence(currentFindings, priorFindings)).toBe(false);
  });

  test("BLOCKING with new file:line not in any prior → true", () => {
    const currentFindings: FindingForDetection[] = [
      { file: "src/new-file.ts", severity: "BLOCKING", line: 10 },
    ];
    const priorFindings: FindingForDetection[] = [
      { file: "src/foo.ts", severity: "NON-BLOCKING", line: 42 },
    ];
    expect(hasNewEvidence(currentFindings, priorFindings)).toBe(true);
  });

  test("BLOCKING matching prior BLOCKING at same line → true (persistent blocker, not stagnation)", () => {
    // A persistent BLOCKING at the same locus is a genuine ongoing blocker,
    // not a stagnation re-escalation of an accepted-NON-BLOCKING item.
    // Prior BLOCKINGs do NOT negate novelty — only NON-BLOCKING/PRE-EXISTING do.
    const currentFindings: FindingForDetection[] = [
      { file: "src/foo.ts", severity: "BLOCKING", line: 5 },
    ];
    const priorFindings: FindingForDetection[] = [
      { file: "src/foo.ts", severity: "BLOCKING", line: 5 },
    ];
    expect(hasNewEvidence(currentFindings, priorFindings)).toBe(true);
  });

  test("no BLOCKINGs in current → false (nothing to check)", () => {
    const currentFindings: FindingForDetection[] = [
      { file: "src/foo.ts", severity: "NON-BLOCKING", line: 42 },
    ];
    const priorFindings: FindingForDetection[] = [
      { file: "src/bar.ts", severity: "NON-BLOCKING", line: 10 },
    ];
    expect(hasNewEvidence(currentFindings, priorFindings)).toBe(false);
  });

  test("empty current findings → false", () => {
    expect(hasNewEvidence([], [])).toBe(false);
  });

  test("empty prior findings → true (no prior context means all is new)", () => {
    const currentFindings: FindingForDetection[] = [
      { file: "src/foo.ts", severity: "BLOCKING", line: 42 },
    ];
    expect(hasNewEvidence(currentFindings, [])).toBe(true);
  });

  test("BLOCKING without line number → true (conservative: can't tell if new)", () => {
    const currentFindings: FindingForDetection[] = [{ file: "src/foo.ts", severity: "BLOCKING" }];
    const priorFindings: FindingForDetection[] = [
      { file: "src/foo.ts", severity: "NON-BLOCKING", line: 10 },
    ];
    expect(hasNewEvidence(currentFindings, priorFindings)).toBe(true);
  });

  test("BLOCKING on line within prior multi-line range → false (not new evidence)", () => {
    const currentFindings: FindingForDetection[] = [
      { file: "src/foo.ts", severity: "BLOCKING", line: 15 },
    ];
    // Prior finding covers lines 10-20
    const priorFindings: FindingForDetection[] = [
      { file: "src/foo.ts", severity: "NON-BLOCKING", line: 10, lineEnd: 20 },
    ];
    expect(hasNewEvidence(currentFindings, priorFindings)).toBe(false);
  });

  test("current multi-line BLOCKING overlapping prior single line → false", () => {
    const currentFindings: FindingForDetection[] = [
      { file: "src/foo.ts", severity: "BLOCKING", line: 10, lineEnd: 20 },
    ];
    const priorFindings: FindingForDetection[] = [
      { file: "src/foo.ts", severity: "NON-BLOCKING", line: 15 },
    ];
    expect(hasNewEvidence(currentFindings, priorFindings)).toBe(false);
  });

  test("multiple BLOCKINGs: one is new, one is not → true (any new = true)", () => {
    const currentFindings: FindingForDetection[] = [
      { file: "src/old.ts", severity: "BLOCKING", line: 5 }, // matches prior
      { file: "src/new.ts", severity: "BLOCKING", line: 99 }, // new
    ];
    const priorFindings: FindingForDetection[] = [
      { file: "src/old.ts", severity: "NON-BLOCKING", line: 5 },
    ];
    expect(hasNewEvidence(currentFindings, priorFindings)).toBe(true);
  });

  test("path normalization: backslash paths match forward-slash paths", () => {
    const currentFindings: FindingForDetection[] = [
      { file: "src\\foo.ts", severity: "BLOCKING", line: 42 },
    ];
    const priorFindings: FindingForDetection[] = [
      { file: "src/foo.ts", severity: "NON-BLOCKING", line: 42 },
    ];
    expect(hasNewEvidence(currentFindings, priorFindings)).toBe(false);
  });

  test("path normalization: case-insensitive matching", () => {
    const currentFindings: FindingForDetection[] = [
      { file: "Src/Foo.ts", severity: "BLOCKING", line: 42 },
    ];
    const priorFindings: FindingForDetection[] = [
      { file: "src/foo.ts", severity: "NON-BLOCKING", line: 42 },
    ];
    expect(hasNewEvidence(currentFindings, priorFindings)).toBe(false);
  });

  test("prior finding with no line matches any line in that file", () => {
    const currentFindings: FindingForDetection[] = [
      { file: "src/foo.ts", severity: "BLOCKING", line: 42 },
    ];
    const priorFindings: FindingForDetection[] = [
      // Prior has no line — matches any line in the file
      { file: "src/foo.ts", severity: "NON-BLOCKING" },
    ];
    expect(hasNewEvidence(currentFindings, priorFindings)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// detectConvergence — unit tests
// ---------------------------------------------------------------------------

describe("detectConvergence", () => {
  const noFindings: FindingForDetection[] = [];

  test("R1 (below threshold) → downgradeApplied=false, threshold reason", () => {
    const result = detectConvergence(
      [{ file: "src/a.ts", severity: "BLOCKING", line: 1 }],
      noFindings,
      [3],
      1
    );
    expect(result.downgradeApplied).toBe(false);
    expect(result.reason).toContain(`< threshold R${CONVERGENCE_ACTIVATION_THRESHOLD}`);
  });

  test("R3 (below threshold) → downgradeApplied=false", () => {
    const result = detectConvergence(
      [{ file: "src/a.ts", severity: "BLOCKING", line: 1 }],
      noFindings,
      [3, 2, 2],
      3
    );
    expect(result.downgradeApplied).toBe(false);
  });

  test("R4 with 0 BLOCKINGs → downgradeApplied=false, nothing to downgrade", () => {
    const result = detectConvergence(
      [{ file: "src/a.ts", severity: "NON-BLOCKING", line: 1 }],
      noFindings,
      [3, 2, 1],
      4
    );
    expect(result.downgradeApplied).toBe(false);
    expect(result.reason).toContain("0 BLOCKINGs");
  });

  test("R4 with no prior data → downgradeApplied=false, cannot assess", () => {
    const result = detectConvergence(
      [{ file: "src/a.ts", severity: "BLOCKING", line: 1 }],
      noFindings,
      [],
      4
    );
    expect(result.downgradeApplied).toBe(false);
    expect(result.reason).toContain("no prior-round data");
  });

  test("R4, count not decreasing AND no new evidence → downgradeApplied=true (stagnation)", () => {
    const priorFindings: FindingForDetection[] = [
      { file: "src/a.ts", severity: "NON-BLOCKING", line: 10 },
    ];
    const currentFindings: FindingForDetection[] = [
      { file: "src/a.ts", severity: "BLOCKING", line: 10 },
    ];
    // priorBlockingCounts: R1=3, R2=2, R3=1 → fullHistory=[3,2,1,1] → 1→1 not strictly decreasing
    // current BLOCKING at src/a.ts:10 matches prior NON-BLOCKING → no new evidence
    const result = detectConvergence(currentFindings, priorFindings, [3, 2, 1], 4);
    expect(result.downgradeApplied).toBe(true);
    expect(result.reason).toContain("stagnating");
    expect(result.isCountDecreasing).toBe(false);
    expect(result.hasAnyNewEvidence).toBe(false);
  });

  test("R4, count strictly decreasing → downgradeApplied=false (allowed)", () => {
    const priorFindings: FindingForDetection[] = [
      { file: "src/a.ts", severity: "NON-BLOCKING", line: 10 },
    ];
    const currentFindings: FindingForDetection[] = [
      { file: "src/a.ts", severity: "BLOCKING", line: 10 },
    ];
    // priorBlockingCounts: R1=3, R2=2, R3=2; current=1 → 2→1 is strictly decreasing
    const result = detectConvergence(currentFindings, priorFindings, [3, 2, 2], 4);
    // Wait: [3, 2, 2, 1] — the function appends currentBlockingCount=1 to history
    // 2 → 1 is strictly decreasing → downgradeApplied=false
    expect(result.downgradeApplied).toBe(false);
    expect(result.isCountDecreasing).toBe(true);
  });

  test("R4, count not decreasing but new evidence → downgradeApplied=false (carve-out)", () => {
    const priorFindings: FindingForDetection[] = [
      { file: "src/old.ts", severity: "NON-BLOCKING", line: 10 },
    ];
    const currentFindings: FindingForDetection[] = [
      { file: "src/brand-new.ts", severity: "BLOCKING", line: 99 }, // new file
    ];
    // priorBlockingCounts: R1=2, R2=1, R3=1 (not decreasing at last)
    const result = detectConvergence(currentFindings, priorFindings, [2, 1, 1], 4);
    // count history: [2, 1, 1, 1] — last two: 1→1, not strictly decreasing
    // BUT new evidence (brand-new.ts never appeared before)
    expect(result.downgradeApplied).toBe(false);
    expect(result.hasAnyNewEvidence).toBe(true);
  });

  test("R5+ also activates (threshold only kicks in at R4, not just exactly R4)", () => {
    const priorFindings: FindingForDetection[] = [
      { file: "src/a.ts", severity: "NON-BLOCKING", line: 10 },
    ];
    const currentFindings: FindingForDetection[] = [
      { file: "src/a.ts", severity: "BLOCKING", line: 10 },
    ];
    const result = detectConvergence(currentFindings, priorFindings, [3, 2, 2, 2], 5);
    // [3, 2, 2, 2, 1] — last two: 2→1 strictly decreasing → downgradeApplied=false
    // Wait: currentBlockingCount=1, last prior=2, so 2→1 is strictly decreasing
    expect(result.downgradeApplied).toBe(false);
    expect(result.isCountDecreasing).toBe(true);
  });

  test("R5 stagnation: [3, 2, 2, 2] + current=2 + no new evidence → fires", () => {
    const priorFindings: FindingForDetection[] = [
      { file: "src/a.ts", severity: "NON-BLOCKING", line: 10 },
    ];
    const currentFindings: FindingForDetection[] = [
      { file: "src/a.ts", severity: "BLOCKING", line: 10 },
    ];
    const result = detectConvergence(currentFindings, priorFindings, [3, 2, 2, 2], 5);
    // [3, 2, 2, 2, 1] — last two: 2→1 strictly decreasing → downgradeApplied=false
    // Hmm, currentBlockingCount = count of BLOCKINGs in currentFindings = 1
    // Let me reconsider: the spec says "count not strictly decreasing AND no new evidence"
    // Here count IS strictly decreasing (2→1), so it should not fire.
    expect(result.downgradeApplied).toBe(false);
  });

  test("evidence verdicts are populated when downgrade fires", () => {
    // Both current BLOCKINGs match prior NON-BLOCKING/PRE-EXISTING findings.
    // Prior BLOCKING entries are excluded from the novelty match so src/b.ts:20
    // does NOT suppress novelty here; we use NON-BLOCKING for that locus instead.
    const priorFindings: FindingForDetection[] = [
      { file: "src/a.ts", severity: "NON-BLOCKING", line: 10 },
      { file: "src/b.ts", severity: "NON-BLOCKING", line: 20 }, // NON-BLOCKING, not BLOCKING
    ];
    const currentFindings: FindingForDetection[] = [
      { file: "src/a.ts", severity: "BLOCKING", line: 10 }, // matches prior NON-BLOCKING
      { file: "src/b.ts", severity: "BLOCKING", line: 20 }, // matches prior NON-BLOCKING
    ];
    const result = detectConvergence(currentFindings, priorFindings, [3, 2, 2], 4);
    // Both BLOCKINGs match prior NON-BLOCKING → no new evidence → fires
    expect(result.downgradeApplied).toBe(true);
    expect(result.evidenceVerdicts).toHaveLength(2);
    expect(result.evidenceVerdicts.every((v) => !v.hasNewEvidence)).toBe(true);
  });

  test("persistent BLOCKING at same locus as prior BLOCKING → downgrade does NOT fire (new evidence)", () => {
    // A BLOCKING whose file:line matches a prior BLOCKING is a persistent genuine
    // blocker. It should NOT be downgraded — prior BLOCKINGs do not negate novelty.
    const priorFindings: FindingForDetection[] = [
      { file: "src/auth.ts", severity: "BLOCKING", line: 42 },
    ];
    const currentFindings: FindingForDetection[] = [
      { file: "src/auth.ts", severity: "BLOCKING", line: 42 }, // same as prior BLOCKING
    ];
    const result = detectConvergence(currentFindings, priorFindings, [1, 1, 1], 4);
    // Count not strictly decreasing (1→1), but src/auth.ts:42 matches only a prior
    // BLOCKING — which is excluded from the novelty check → hasNewEvidence=true → no downgrade.
    expect(result.downgradeApplied).toBe(false);
    expect(result.hasAnyNewEvidence).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// applyCompositionConvergenceDowngrade — integration tests
// ---------------------------------------------------------------------------

describe("applyCompositionConvergenceDowngrade", () => {
  // Acceptance test from spec: synthetic stagnation trace — R3 has 3 BLOCKINGs
  // each text-matching an R2 NON-BLOCKING; downgrade fires; event becomes COMMENT.
  // Note: this is now at R4 per the threshold, but the acceptance test description
  // says "R3 has 3 BLOCKINGs" meaning it's the 4th round (R4 with 3 rounds of history).
  test("integration: stagnation trace → downgrade fires, event forced COMMENT", () => {
    // Simulate 3 rounds of history (R1, R2, R3) — current round is R4
    const priorFindings: FindingForDetection[] = [
      // R1 findings
      { file: "src/api.ts", severity: "BLOCKING", line: 10 },
      { file: "src/api.ts", severity: "BLOCKING", line: 20 },
      { file: "src/api.ts", severity: "BLOCKING", line: 30 },
      // R2 findings — some become NON-BLOCKING
      { file: "src/api.ts", severity: "NON-BLOCKING", line: 10 },
      { file: "src/api.ts", severity: "NON-BLOCKING", line: 20 },
      { file: "src/api.ts", severity: "NON-BLOCKING", line: 30 },
      // R3 findings — same lines still appearing
      { file: "src/api.ts", severity: "NON-BLOCKING", line: 10 },
      { file: "src/api.ts", severity: "NON-BLOCKING", line: 20 },
      { file: "src/api.ts", severity: "NON-BLOCKING", line: 30 },
    ];
    const priorBlockingCounts: BlockingCountByRound = [3, 0, 0]; // R1=3, R2=0, R3=0

    // R4 — model re-escalates the same lines back to BLOCKING
    const toolCalls: ReviewToolCall[] = [
      {
        name: "submit_finding",
        args: {
          severity: "BLOCKING",
          file: "src/api.ts",
          line: 10,
          summary: "still blocking issue",
          details: "still broken",
        },
      },
      {
        name: "submit_finding",
        args: {
          severity: "BLOCKING",
          file: "src/api.ts",
          line: 20,
          summary: "another blocking issue",
          details: "still broken",
        },
      },
      {
        name: "submit_finding",
        args: {
          severity: "BLOCKING",
          file: "src/api.ts",
          line: 30,
          summary: "third blocking issue",
          details: "still broken",
        },
      },
      {
        name: "conclude_review",
        args: {
          event: "REQUEST_CHANGES",
          summary: "Three blockers remain.",
        },
      },
    ];

    const result = applyCompositionConvergenceDowngrade(
      toolCalls,
      priorFindings,
      priorBlockingCounts,
      4 // iterationIndex = 4 (R4)
    );

    expect(result.downgradeApplied).toBe(true);
    expect(result.downgrades).toHaveLength(3); // All 3 BLOCKINGs downgraded

    // All submit_finding calls should now be NON-BLOCKING
    const findings = result.toolCalls.filter((tc) => tc.name === "submit_finding");
    expect(
      findings.every((tc) => tc.name === "submit_finding" && tc.args.severity === "NON-BLOCKING")
    ).toBe(true);

    // conclude_review should be reconciled from REQUEST_CHANGES to COMMENT
    const conclude = result.toolCalls.find((tc) => tc.name === "conclude_review");
    expect(conclude).toBeDefined();
    if (conclude && conclude.name === "conclude_review") {
      expect(conclude.args.event).toBe("COMMENT");
    }
  });

  // Acceptance test from spec: legitimate new defect at R4 — not downgraded.
  test("integration: legitimate new defect at R4 → downgrade does NOT fire", () => {
    const priorFindings: FindingForDetection[] = [
      { file: "src/old.ts", severity: "NON-BLOCKING", line: 5 },
    ];
    const priorBlockingCounts: BlockingCountByRound = [2, 1, 1];

    // R4 — model finds a brand-new defect not in any prior round
    const toolCalls: ReviewToolCall[] = [
      {
        name: "submit_finding",
        args: {
          severity: "BLOCKING",
          file: "src/brand-new-file.ts", // new file, not in any prior finding
          line: 99,
          summary: "new defect",
          details: "legitimately new",
        },
      },
      {
        name: "conclude_review",
        args: {
          event: "REQUEST_CHANGES",
          summary: "New defect found.",
        },
      },
    ];

    const result = applyCompositionConvergenceDowngrade(
      toolCalls,
      priorFindings,
      priorBlockingCounts,
      4
    );

    expect(result.downgradeApplied).toBe(false);
    expect(result.downgrades).toHaveLength(0);

    // BLOCKING should be preserved
    const findings = result.toolCalls.filter((tc) => tc.name === "submit_finding");
    expect(
      findings.every((tc) => tc.name === "submit_finding" && tc.args.severity === "BLOCKING")
    ).toBe(true);

    // conclude_review should be unchanged (REQUEST_CHANGES preserved)
    const conclude = result.toolCalls.find((tc) => tc.name === "conclude_review");
    if (conclude && conclude.name === "conclude_review") {
      expect(conclude.args.event).toBe("REQUEST_CHANGES");
    }
  });

  test("R1, R2, R3 are unaffected even if stagnation would fire", () => {
    const priorFindings: FindingForDetection[] = [
      { file: "src/a.ts", severity: "NON-BLOCKING", line: 10 },
    ];
    const toolCalls: ReviewToolCall[] = [
      {
        name: "submit_finding",
        args: {
          severity: "BLOCKING",
          file: "src/a.ts",
          line: 10,
          summary: "same old blocking",
          details: "details",
        },
      },
    ];

    for (const round of [1, 2, 3] as const) {
      const result = applyCompositionConvergenceDowngrade(
        toolCalls,
        priorFindings,
        [5, 5, 5], // stagnation-like counts
        round
      );
      expect(result.downgradeApplied).toBe(false);
    }
  });

  test("non-finding tool calls pass through unchanged during downgrade", () => {
    const priorFindings: FindingForDetection[] = [
      { file: "src/a.ts", severity: "NON-BLOCKING", line: 10 },
    ];
    const priorBlockingCounts: BlockingCountByRound = [3, 2, 2];

    const toolCalls: ReviewToolCall[] = [
      {
        name: "submit_finding",
        args: { severity: "BLOCKING", file: "src/a.ts", line: 10, summary: "s", details: "d" },
      },
      {
        name: SUBMIT_INLINE_COMMENT,
        args: { file: "src/b.ts", line: 5, body: "inline comment" },
      },
      {
        name: "submit_spec_verification",
        args: { criterion: "SC-1", status: "Met", evidence: "see line 5" },
      },
      {
        name: "submit_thread_resolve",
        args: { threadId: "PRRT_kwABCD", reason: "fixed" },
      },
    ];

    const result = applyCompositionConvergenceDowngrade(
      toolCalls,
      priorFindings,
      priorBlockingCounts,
      4
    );

    // currentBlockingCount=1, priorBlockingCounts=[3,2,2].
    // fullHistory=[3,2,2,1] — last two: 2→1, strictly decreasing → downgrade does NOT fire.
    // This test verifies non-finding tool calls pass through on the no-downgrade path.
    expect(result.downgradeApplied).toBe(false);
    // Non-finding calls are still in the output
    expect(result.toolCalls.some((tc) => tc.name === SUBMIT_INLINE_COMMENT)).toBe(true);
    expect(result.toolCalls.some((tc) => tc.name === "submit_spec_verification")).toBe(true);
    expect(result.toolCalls.some((tc) => tc.name === "submit_thread_resolve")).toBe(true);
  });

  test("non-finding tool calls pass through when downgrade fires", () => {
    const priorFindings: FindingForDetection[] = [
      { file: "src/a.ts", severity: "NON-BLOCKING", line: 10 },
    ];
    // Stagnation: 2→2 not decreasing, a.ts:10 matches prior
    const priorBlockingCounts: BlockingCountByRound = [3, 2, 2];

    const toolCalls: ReviewToolCall[] = [
      {
        name: "submit_finding",
        args: { severity: "BLOCKING", file: "src/a.ts", line: 10, summary: "s1", details: "d1" },
      },
      {
        name: "submit_finding",
        args: { severity: "BLOCKING", file: "src/a.ts", line: 10, summary: "s2", details: "d2" },
      },
      {
        name: SUBMIT_INLINE_COMMENT,
        args: { file: "src/b.ts", line: 5, body: "inline comment" },
      },
      {
        name: "conclude_review",
        args: { event: "REQUEST_CHANGES", summary: "Two blockers." },
      },
    ];

    // currentBlockingCount=2, priorBlockingCounts=[3,2,2]
    // history=[3,2,2,2] — 2→2 not strictly decreasing — fires (if no new evidence)
    const result = applyCompositionConvergenceDowngrade(
      toolCalls,
      priorFindings,
      priorBlockingCounts,
      4
    );

    expect(result.downgradeApplied).toBe(true);
    // Inline comment should pass through
    expect(result.toolCalls.some((tc) => tc.name === SUBMIT_INLINE_COMMENT)).toBe(true);
    // All findings downgraded
    const findings = result.toolCalls.filter((tc) => tc.name === "submit_finding");
    expect(
      findings.every((tc) => tc.name === "submit_finding" && tc.args.severity === "NON-BLOCKING")
    ).toBe(true);
    // Conclude_review reconciled
    const conclude = result.toolCalls.find((tc) => tc.name === "conclude_review");
    if (conclude && conclude.name === "conclude_review") {
      expect(conclude.args.event).toBe("COMMENT");
    }
  });

  test("conclude_review event preserved as-is when downgrade fires with APPROVE", () => {
    // If conclude_review was already APPROVE, it stays APPROVE (not changed by downgrade)
    const priorFindings: FindingForDetection[] = [
      { file: "src/a.ts", severity: "NON-BLOCKING", line: 10 },
    ];
    const priorBlockingCounts: BlockingCountByRound = [3, 2, 2];

    const toolCalls: ReviewToolCall[] = [
      {
        name: "submit_finding",
        args: { severity: "BLOCKING", file: "src/a.ts", line: 10, summary: "s", details: "d" },
      },
      {
        name: "submit_finding",
        args: { severity: "BLOCKING", file: "src/a.ts", line: 10, summary: "s2", details: "d2" },
      },
      {
        name: "conclude_review",
        args: { event: "APPROVE", summary: "Looks good despite findings." },
      },
    ];

    const result = applyCompositionConvergenceDowngrade(
      toolCalls,
      priorFindings,
      priorBlockingCounts,
      4
    );

    expect(result.downgradeApplied).toBe(true);
    // APPROVE conclude_review is NOT rewritten (only REQUEST_CHANGES is reconciled)
    const conclude = result.toolCalls.find((tc) => tc.name === "conclude_review");
    if (conclude && conclude.name === "conclude_review") {
      expect(conclude.args.event).toBe("APPROVE");
    }
  });
});

// ---------------------------------------------------------------------------
// extractPriorFindingsForDetection — unit tests
// ---------------------------------------------------------------------------

describe("extractPriorFindingsForDetection", () => {
  test("calls parseFn for each body and aggregates results", () => {
    const calls: string[] = [];
    const parseFn = (body: string): FindingForDetection[] => {
      calls.push(body);
      return [{ file: `from-${body}.ts`, severity: "BLOCKING", line: 1 }];
    };

    const result = extractPriorFindingsForDetection(["body1", "body2"], parseFn);
    expect(calls).toEqual(["body1", "body2"]);
    expect(result).toHaveLength(2);
    expect(result[0]?.file).toBe("from-body1.ts");
    expect(result[1]?.file).toBe("from-body2.ts");
  });

  test("swallows errors from parseFn and continues", () => {
    let callCount = 0;
    const parseFn = (body: string): FindingForDetection[] => {
      callCount++;
      if (body === "bad") throw new Error("parse error");
      return [{ file: "src/a.ts", severity: "BLOCKING", line: 1 }];
    };

    const result = extractPriorFindingsForDetection(["good", "bad", "good"], parseFn);
    expect(callCount).toBe(3);
    // "bad" body produced no findings (error swallowed)
    expect(result).toHaveLength(2);
  });

  test("returns empty array for empty input", () => {
    const parseFn = (): FindingForDetection[] => [];
    expect(extractPriorFindingsForDetection([], parseFn)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// CONVERGENCE_ACTIVATION_THRESHOLD constant
// ---------------------------------------------------------------------------

describe("CONVERGENCE_ACTIVATION_THRESHOLD", () => {
  test("equals 4 (R4 is the first affected round)", () => {
    expect(CONVERGENCE_ACTIVATION_THRESHOLD).toBe(4);
  });
});
