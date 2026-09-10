/**
 * The parser reads BOTH session-id spellings (mt#5048, PR #3709 R1).
 *
 * Nine per-kind record interfaces declare `session_id`, and most producers write
 * it — but not all. Measured over the live logs 2026-09-10:
 *
 * - **Zero** of the 15 outcome-convention logs write `session_id`. All 32,763 of
 *   their records use `sessionId` (camelCase).
 * - `duplicate-signature-scan`, which reaches the shared matches-shape fallback,
 *   writes `sessionId` on all 316 of its records and `session_id` on none.
 *
 * Reading only the snake_case name therefore dropped the conversation id for
 * 100% of the records those two paths handle. The cost is real but quiet:
 * `isRevisedAway` is scoped to `(session_id, timestamp)`, so a record with no
 * session id can never be retracted by a `supersedes` marker, and review
 * attribution loses the conversation the fire came from. Nothing errors — the
 * field is optional, so its absence looks exactly like a producer that genuinely
 * omitted it.
 *
 * The precedent for the fix is in the same function: the `nonexistent-search-path`
 * branch already maps `raw["sessionId"]`, with a note that its producer uses
 * camelCase. These tests pin that behavior for the outcome branch and the shared
 * fallback so the next camelCase producer does not silently lose its id again.
 */
import { describe, expect, test } from "bun:test";
import { parseCalibrationRecord } from "./calibration-sweep";

const GENERIC = "generic-matches" as Parameters<typeof parseCalibrationRecord>[1];

describe("the outcome branch reads both session-id spellings", () => {
  test("camelCase sessionId is carried onto the parsed record", () => {
    // Verbatim production shape from claim-provenance-scan-calibration.jsonl:
    // camelCase `sessionId`, no `session_id`, no `matches` key.
    const line = JSON.stringify({
      timestamp: "2026-09-10T07:00:00.000Z",
      sessionId: "conv-abc-123",
      outcome: "matched",
    });
    const record = parseCalibrationRecord(line, GENERIC);
    expect(record).not.toBeNull();
    expect(record?.session_id).toBe("conv-abc-123");
  });

  test("snake_case session_id still wins when both are present", () => {
    // Precedence matters rather than being arbitrary: `session_id` is the
    // declared field on the record interfaces, so a producer emitting both is
    // read at its declared name.
    const line = JSON.stringify({
      timestamp: "2026-09-10T07:00:00.000Z",
      session_id: "declared-name",
      sessionId: "camel-name",
      outcome: "clean",
    });
    expect(parseCalibrationRecord(line, GENERIC)?.session_id).toBe("declared-name");
  });

  test("a record with neither spelling parses with an undefined session id", () => {
    // The field is optional, and a genuinely id-less record must stay parseable
    // rather than being coerced to a placeholder that would then collide with
    // other id-less records inside `isRevisedAway`'s key set.
    const line = JSON.stringify({ timestamp: "2026-09-10T07:00:00.000Z", outcome: "clean" });
    const record = parseCalibrationRecord(line, GENERIC);
    expect(record).not.toBeNull();
    expect(record?.session_id).toBeUndefined();
  });

  test("the clean path carries the id too, not only the fire path", () => {
    // Both arms of the outcome branch build from the same `base`. Asserted
    // separately anyway: a future edit could easily fix one arm and not the
    // other, and an evaluation-only record still needs its attribution.
    const line = JSON.stringify({
      timestamp: "2026-09-10T07:00:00.000Z",
      sessionId: "conv-clean-1",
      outcome: "clean",
    });
    const record = parseCalibrationRecord(line, GENERIC);
    expect(record?.session_id).toBe("conv-clean-1");
    if (!record || !("matches" in record)) throw new Error("expected a matches-shape record");
    expect(record.matches).toEqual([]);
  });
});

describe("the shared matches-shape fallback reads both spellings", () => {
  test("camelCase sessionId survives the fallback path", () => {
    // duplicate-signature-scan's shape: a real `matches` array, so this never
    // reaches the outcome branch above and exercises the fallback instead.
    const line = JSON.stringify({
      timestamp: "2026-09-10T07:00:00.000Z",
      sessionId: "conv-fallback-9",
      matches: [{ family: "dup", phrase: "parseCalibrationRecordCore" }],
    });
    const record = parseCalibrationRecord(line, GENERIC);
    expect(record).not.toBeNull();
    expect(record?.session_id).toBe("conv-fallback-9");
    if (!record || !("matches" in record)) throw new Error("expected a matches-shape record");
    expect(record.matches).toHaveLength(1);
  });

  test("snake_case session_id still wins in the fallback too", () => {
    const line = JSON.stringify({
      timestamp: "2026-09-10T07:00:00.000Z",
      session_id: "declared-name",
      sessionId: "camel-name",
      matches: [{ family: "dup", phrase: "x" }],
    });
    expect(parseCalibrationRecord(line, GENERIC)?.session_id).toBe("declared-name");
  });
});
