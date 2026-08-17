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
  type EvaluationRecord,
  type RecoveredTurn,
} from "./measure-negative-existence-recall";

function turn(sessionId: string, proseChars: number, endedAt: string): RecoveredTurn {
  return { sessionId, proseChars, endedAt, claimPresent: false, prose: "" };
}

function record(sessionId: string, proseChars: number, timestamp: string): EvaluationRecord {
  return { session_id: sessionId, proseChars, timestamp, claimPresent: false };
}

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
