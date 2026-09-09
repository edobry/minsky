/**
 * `stale-state-assertion` gets a per-kind parse branch (mt#5010).
 *
 * Before this branch, the log had no entry in the `kind` union, so
 * `deriveCalibrationLogEntries` synthesized it with `GENERIC_MATCHES_KIND` and
 * every record fell to the shared matches-shape fallback. That fallback looks
 * for a `matches` key the raw records do not have, synthesizes `matches: []`,
 * and demotes `claims` / `contradicted` / `fired` into `detectorFields` where no
 * counting predicate looks. All 381 records classified as evaluation-only and
 * the log's 7 distinct assertion phrases (in the current window) rendered as 0.
 *
 * **Fixtures are built from the VERBATIM key set of the production log**, read
 * 2026-09-09 — per mem#1020: a fixture invented from a field name can parse into
 * a shape the real writer never produces, then pass while production still
 * reports the gap.
 */

import { describe, expect, test } from "bun:test";
import {
  extractDistinctPhrases,
  isEvaluationOnlyRecord,
  isLogOnlyFamilyRecord,
  parseCalibrationRecord,
  type CalibrationRecord,
} from "./calibration-sweep";

const SESSION_ID = "f15c85f9-b245-433d-b7b0-e8019344415b";

/** A real `assertionPhrase` from the production log. */
const PHRASE_A = "Both caveats are on the spec.";
/** A second real one, from a different assertion family. */
const PHRASE_B = "mt#4649 is the only actionable one";

function parsed(line: string): CalibrationRecord {
  const record = parseCalibrationRecord(line, "stale-state-assertion");
  if (!record) throw new Error("fixture failed to parse");
  return record;
}

/** A real fired record's shape: claims + contradicted populated, no suppression. */
function firedLine(phrases: string[], family = "past-tense-claim"): string {
  return JSON.stringify({
    timestamp: "2026-09-08T14:02:11.201Z",
    session_id: SESSION_ID,
    source: "turn-end-stale-state-assertion-scan",
    channel: "stop",
    stop_hook_active: false,
    fired: true,
    claims: phrases.map((p, i) => ({
      ref: `mt#${4772 + i}`,
      kind: "task",
      assertionFamily: family,
      assertionPhrase: p,
    })),
    contradicted: phrases.map((_, i) => ({
      ref: `mt#${4772 + i}`,
      assertedPending: PHRASE_A,
      liveState: "peer-activity-on-ledger",
    })),
    resolvedCount: phrases.length,
    suppressionReasons: [],
    final_message_tail: "…the tail the detector judged.",
  });
}

/** A real suppressed non-fire: the dominant shape in this log (196 of 381). */
function suppressedLine(): string {
  return JSON.stringify({
    timestamp: "2026-09-08T14:05:03.884Z",
    session_id: SESSION_ID,
    source: "turn-end-stale-state-assertion-scan",
    channel: "stop",
    stop_hook_active: false,
    fired: false,
    claims: [],
    contradicted: [],
    resolvedCount: 0,
    suppressionReasons: ["nomination-deps-unavailable"],
    final_message_tail: "…the tail the detector judged.",
  });
}

describe("the parse branch (mt#5010 SC1)", () => {
  test("a fired record parses with a non-empty match set", () => {
    const rec = parsed(firedLine(["Both caveats are on the spec."]));

    expect("matches" in rec).toBe(true);
    expect((rec as { matches: unknown[] }).matches).toHaveLength(1);
  });

  test("a suppressed non-fire parses with an EMPTY match set", () => {
    // AT3. The change must not make every record look like a fire — guarding
    // the branch on `fired` instead of on `claims` would have dropped this
    // record entirely and lost its suppression from the counts.
    const rec = parsed(suppressedLine());

    expect("matches" in rec).toBe(true);
    expect((rec as { matches: unknown[] }).matches).toHaveLength(0);
  });

  test("a record with no `claims` key is rejected rather than mis-parsed", () => {
    expect(
      parseCalibrationRecord(JSON.stringify({ timestamp: "x" }), "stale-state-assertion")
    ).toBe(null);
  });
});

describe("classification moves to the right column (mt#5010 SC3)", () => {
  test("a fired record is NO LONGER evaluation-only", () => {
    // The defect in one assertion: this returned `true` for all 381 records.
    expect(isEvaluationOnlyRecord(parsed(firedLine(["a claim"])))).toBe(false);
  });

  test("a fired record IS log-only-family, because the detector cannot inject", () => {
    // `turn-end-stale-state-assertion-scan.ts`'s `run()`: "Record-only by
    // design — returns a `calibration` payload and never an `additionalContext`,
    // per ADR-024's Rung-1 posture." So a fire here reached NOBODY. Counting it
    // as an injected fire would rebuild mt#4970's defect on a second detector.
    expect(isLogOnlyFamilyRecord(parsed(firedLine(["a claim"])))).toBe(true);
  });

  test("a suppressed non-fire stays evaluation-only and is NOT log-only-family", () => {
    // `isLogOnlyFamilyRecord` returns false on empty matches rather than
    // vacuously true, so the two columns stay disjoint.
    const rec = parsed(suppressedLine());

    expect(isEvaluationOnlyRecord(rec)).toBe(true);
    expect(isLogOnlyFamilyRecord(rec)).toBe(false);
  });
});

describe("the diversity axis (mt#5010 SC2)", () => {
  test("distinct phrases come from assertionPhrase", () => {
    const phrases = extractDistinctPhrases([
      parsed(firedLine([PHRASE_A, PHRASE_B])),
      parsed(firedLine([PHRASE_A])),
    ]);

    // Three claims across two records, two distinct phrases — the axis counts
    // SHAPES, which is what the diversity bar exists to measure.
    expect(phrases.size).toBe(2);
    expect([...phrases]).toContain(PHRASE_A);
  });

  test("a suppressed non-fire contributes no phrase", () => {
    expect(extractDistinctPhrases([parsed(suppressedLine())]).size).toBe(0);
  });

  test("the axis is the PHRASE, not the ref — near-unique values would make the bar inert", () => {
    // Two records asserting the SAME phrase under DIFFERENT families are one
    // shape, not two. Keying on `ref` — which is near-unique — would satisfy the
    // distinct-phrase gate by construction, which is the mt#3781 inert-sweep
    // defect. The family differs via the fixture rather than by mutating a
    // parsed record, so the test exercises the real parse path both times.
    const a = parsed(firedLine([PHRASE_A], "past-tense-claim"));
    const b = parsed(firedLine([PHRASE_A], "recommend-start"));

    expect(extractDistinctPhrases([a, b]).size).toBe(1);
  });
});
