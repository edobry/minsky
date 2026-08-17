// Tests for mt#4162's recall-miss harness.
//
// Scoped to `joinRecords`, deliberately. The rest of the script is IO over the
// transcript store, but the JOIN is where a silent defect would be invisible:
// a mis-join still produces a rate, and the rate is the deliverable. The
// `--validate` mode catches this in production by comparing against the stored
// `claimPresent` on both strata — these tests pin the join's tie-break rules so
// a regression breaks a test rather than shifting a percentage.
import { describe, test, expect } from "bun:test";
import {
  joinRecords,
  isCandidateMiss,
  RECURRENCE_A,
  RECURRENCE_B,
  type EvaluationRecord,
  type RecoveredTurn,
} from "./measure-negative-existence-recall";
import { extractNegativeExistenceClaims } from "../packages/domain/src/detectors/negative-existence-claim";

function turn(sessionId: string, proseChars: number, endedAt: string): RecoveredTurn {
  return { sessionId, proseChars, endedAt, claimPresent: false, prose: "" };
}

function record(sessionId: string, proseChars: number, timestamp: string): EvaluationRecord {
  return { session_id: sessionId, proseChars, timestamp, claimPresent: false };
}

describe("SC3 — mt#4121's recurrences, pinned and VERIFIED against the labeling pass", () => {
  // "A fixture asserted to match is not evidence it matches" (mt#4114) — so each
  // of these runs both the shipped matcher and the labeling predicate rather
  // than declaring the outcome in prose.

  describe("recurrence A — a past-tense negative-existence claim", () => {
    test("the shipped corpus MISSES it", () => {
      expect(extractNegativeExistenceClaims(RECURRENCE_A)).toHaveLength(0);
    });

    test("its present-tense twin is CAUGHT — so the gap is tense, not the claim", () => {
      // The discriminating half: without it, the miss above is consistent with
      // the detector simply not covering this claim at all.
      expect(
        extractNegativeExistenceClaims("the handler's own catch never runs").length
      ).toBeGreaterThan(0);
    });

    test("the labeling pass proposes it — this is what makes it classify as (b)", () => {
      expect(isCandidateMiss(`In the spec: ${RECURRENCE_A}, so the branch is dead.`)).toBe(true);
    });
  });

  describe("recurrence B — NOT a negative-existence claim, pinned as the negative fixture", () => {
    test("the shipped corpus misses it, as it must", () => {
      expect(extractNegativeExistenceClaims(RECURRENCE_B)).toHaveLength(0);
    });

    test("the labeling pass ALSO does not propose it", () => {
      // Recorded as a property rather than an omission: B asserts a mechanism is
      // PRESENT, so no negation-keyed corpus reaches it and no widening of this
      // detector ever will. SC3 cannot be satisfied for B, and this test is why.
      expect(isCandidateMiss(`In the spec: ${RECURRENCE_B}, which is the wrong cause.`)).toBe(
        false
      );
    });
  });
});

describe("joinRecords", () => {
  test("joins on (session_id, proseChars)", () => {
    const joined = joinRecords(
      [record("s1", 100, "2026-08-16T00:00:10Z")],
      [turn("s1", 100, "2026-08-16T00:00:09Z")]
    );
    expect(joined[0]?.turn?.proseChars).toBe(100);
  });

  test("a length that matches in a DIFFERENT session does not join", () => {
    // The whole point of keying on the pair: prose lengths collide across
    // sessions constantly, and a cross-session join would silently label one
    // conversation's turn with another's verdict.
    const joined = joinRecords(
      [record("s1", 100, "2026-08-16T00:00:10Z")],
      [turn("s2", 100, "2026-08-16T00:00:09Z")]
    );
    expect(joined[0]?.turn).toBeUndefined();
  });

  test("no length match leaves the record unjoined rather than guessing", () => {
    const joined = joinRecords(
      [record("s1", 100, "2026-08-16T00:00:10Z")],
      [turn("s1", 999, "2026-08-16T00:00:09Z")]
    );
    expect(joined[0]?.turn).toBeUndefined();
  });

  test("ties on length break to the turn ending NEAREST the record timestamp", () => {
    const joined = joinRecords(
      [record("s1", 100, "2026-08-16T00:00:10Z")],
      [
        turn("s1", 100, "2026-08-16T00:00:00Z"),
        turn("s1", 100, "2026-08-16T00:00:09Z"),
        turn("s1", 100, "2026-08-16T00:05:00Z"),
      ]
    );
    expect(joined[0]?.turn?.endedAt).toBe("2026-08-16T00:00:09Z");
  });

  describe("PR #3053 R1 — the join refuses rather than guesses", () => {
    test("a record with NO timestamp is left unjoined, not resolved arbitrarily", () => {
      // `Math.abs(x - NaN)` is NaN and every `NaN < best` is false, so the old
      // loop silently kept the first same-length turn — a guess that entered the
      // rate looking like a join.
      const joined = joinRecords(
        [{ session_id: "s1", proseChars: 100, claimPresent: false }],
        [turn("s1", 100, "2026-08-16T00:00:00Z"), turn("s1", 100, "2026-08-16T00:00:05Z")]
      );
      expect(joined[0]?.turn).toBeUndefined();
    });

    test("a record with an UNPARSEABLE timestamp is left unjoined", () => {
      const joined = joinRecords(
        [{ session_id: "s1", proseChars: 100, timestamp: "not-a-date", claimPresent: false }],
        [turn("s1", 100, "2026-08-16T00:00:00Z")]
      );
      expect(joined[0]?.turn).toBeUndefined();
    });

    test("a same-length turn beyond the gap bound does not join, even when unique", () => {
      // The coincidence the review flagged: unbounded, this corpus joined records
      // to same-length turns up to 2.8 days away.
      const joined = joinRecords(
        [record("s1", 100, "2026-08-16T00:00:00Z")],
        [turn("s1", 100, "2026-08-17T00:00:00Z")]
      );
      expect(joined[0]?.turn).toBeUndefined();
    });

    test("a turn inside the bound still joins, and reports its gap", () => {
      const joined = joinRecords(
        [record("s1", 100, "2026-08-16T00:00:30Z")],
        [turn("s1", 100, "2026-08-16T00:00:00Z")]
      );
      expect(joined[0]?.turn).toBeDefined();
      expect(joined[0]?.gapMs).toBe(30_000);
    });
  });

  test("every record appears in the output, joined or not", () => {
    // The unjoined count is reported rather than dropped, so a shrinking
    // denominator can never masquerade as agreement.
    const joined = joinRecords(
      [record("s1", 100, "2026-08-16T00:00:10Z"), record("s9", 42, "2026-08-16T00:00:11Z")],
      [turn("s1", 100, "2026-08-16T00:00:09Z")]
    );
    expect(joined).toHaveLength(2);
    expect(joined.filter((j) => j.turn === undefined)).toHaveLength(1);
  });
});
