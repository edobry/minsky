/**
 * mt#4984 — a record is dated under EITHER timestamp spelling.
 *
 * ADR-028 §D4's shared schema names the field `timestamp`; 17 of the 52 live
 * logs write `ts`. Reading one spelling left every record of those seventeen
 * undated: `firstRecordTimestamp` was `""`, so the three time-anchored
 * review-due legs never fired for them and `past-threshold` was the only way
 * in — one `duplicate-signature-scan`, at 355 injected fires carrying a single
 * phrase, could never take. mt#5048 taught ONE parse branch (the outcome
 * convention) to read `ts`; `readRecordTimestamp` now does it at every site,
 * so a `matches`-bearing fire in the shared fallback is dated the same as the
 * clean record beside it. `timestamp` wins when both are present.
 *
 * Split into its own file rather than added to `calibration-sweep.test.ts`
 * because that file is at the 1500-line `max-lines` ceiling; mirrors the
 * `.log-only.test.ts` / `.evaluation-only.test.ts` / `.supersedes.test.ts`
 * split. All in-memory, no filesystem I/O.
 */

import { describe, test, expect } from "bun:test";
import { parseCalibrationRecord, readRecordTimestamp } from "./calibration-sweep";
import type { CalibrationLogEntry } from "./calibration-sweep";

const ISO = "2026-09-14T12:00:00.000Z";
const OLDER = "1999-01-01T00:00:00.000Z";

describe("readRecordTimestamp (mt#4984)", () => {
  test("reads `timestamp`, falls back to `ts`, and `timestamp` wins when both are present", () => {
    expect(readRecordTimestamp({ timestamp: ISO })).toBe(ISO);
    expect(readRecordTimestamp({ ts: ISO })).toBe(ISO);
    expect(readRecordTimestamp({ timestamp: ISO, ts: OLDER })).toBe(ISO);
    expect(readRecordTimestamp({})).toBe("");
  });

  test("PR #3757 R1: a non-string under either key is undated, never stringified", () => {
    // The sites this helper replaced wrote `String(raw["timestamp"] ?? "")`,
    // which dated a record off `1694712345678` or `"[object Object]"` while
    // the receipt check dropped the same record — the cross-reader split this
    // task closes. Both readers now agree: strings only.
    expect(readRecordTimestamp({ timestamp: 1694712345678 })).toBe("");
    expect(readRecordTimestamp({ ts: { iso: ISO } })).toBe("");
    expect(readRecordTimestamp({ timestamp: null, ts: ISO })).toBe(ISO);
    expect(readRecordTimestamp({ timestamp: 42, ts: ISO })).toBe(ISO);
  });
});

describe("parseCalibrationRecord dates a `ts`-stamped record in every branch (mt#4984 SC1)", () => {
  // One case per branch shape a `ts` writer actually reaches: the per-kind
  // `agent-dispatch-record` branch (118 of 118 records undated before this),
  // the outcome-convention branch (mt#5048 taught this one first), the
  // `matches`-array fallback that `duplicate-signature-scan`'s fires take (355
  // of 398 undated before this), and a per-kind branch that never sees `ts`
  // today, so the helper is proven uniform rather than patched per writer.
  const cases: Array<{ kind: CalibrationLogEntry["kind"]; body: Record<string, unknown> }> = [
    { kind: "agent-dispatch-record", body: { sessionId: "s", outcome: "inserted" } },
    { kind: "generic-matches", body: { sessionId: "s", outcome: "clean" } },
    {
      kind: "duplicate-signature-scan",
      body: { sessionId: "s", outcome: "matched", matches: [{ taskId: "mt#1", token: "x" }] },
    },
    { kind: "causal-premise", body: { session_id: "s", matchedPhrases: ["because"] } },
  ];

  for (const { kind, body } of cases) {
    test(`${kind}: \`ts\` parses to the same non-empty date as \`timestamp\``, () => {
      const viaTimestamp = parseCalibrationRecord(
        JSON.stringify({ ...body, timestamp: ISO }),
        kind
      );
      const viaTs = parseCalibrationRecord(JSON.stringify({ ...body, ts: ISO }), kind);
      const viaBoth = parseCalibrationRecord(
        JSON.stringify({ ...body, timestamp: ISO, ts: OLDER }),
        kind
      );
      expect(viaTimestamp?.timestamp).toBe(ISO);
      expect(viaTs?.timestamp).toBe(ISO);
      expect(viaTs?.timestamp).not.toBe("");
      expect(viaBoth?.timestamp).toBe(ISO);
    });
  }
});
