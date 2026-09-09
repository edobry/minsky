/**
 * Judged-text recoverability, derived from the evidence a record ACTUALLY
 * carries rather than from the capture marker alone (mt#4465).
 *
 * Every record below is PARSED from a JSONL line via `parseCalibrationRecord`,
 * never hand-built. That is mem#888's rule 2 and it is load-bearing here: a key
 * no per-kind branch names rides into `detectorFields`, so a hand-built
 * top-level object skips the very placement this derivation has to handle. The
 * four fixtures are deliberately split across both levels —
 * `final_message_tail` and `claims` reach the passthrough, `excerpt` and
 * `transcript_excerpt` are consumed at the top level — so a one-level
 * implementation passes some of these and fails others.
 *
 * A separate file rather than an addition to `calibration-classifiability.test.ts`
 * for the reason that file's own header gives: `calibration-sweep.test.ts` sits
 * at the ESLint line ceiling and mt#3576 shipped a CI failure when two branches
 * each under the limit merged to over it.
 *
 * @see mt#4465 — this task
 * @see mem#888 — the two-level placement rule these fixtures exercise
 * @see mt#3607 — the capture marker, still reported as `capturedRecords`
 */

import { describe, test, expect } from "bun:test";
import { assessClassifiability, parseCalibrationRecord } from "./calibration-sweep";
import type { CalibrationRecord, CalibrationLogEntry } from "./calibration-sweep";

/** Parse one line the way the sweep does, failing loudly rather than returning null. */
function parsed(line: string, kind: CalibrationLogEntry["kind"]): CalibrationRecord {
  const record = parseCalibrationRecord(line, kind);
  if (!record) throw new Error(`fixture failed to parse for kind ${kind}`);
  return record;
}

const SESSION_ID = "f15c85f9-b245-433d-b7b0-e8019344415b";

/** A detector name deliberately absent from `JUDGED_TEXT_FIELDS`. */
const UNMAPPED = "some-new-detector";

/**
 * `untaken-action`, verbatim key set from the production log (2026-08-29).
 * `final_message_tail` is named by NO per-kind branch, so it reaches
 * `detectorFields` — the passthrough half of the two-level split.
 */
function untakenActionLine(tail: string): string {
  return JSON.stringify({
    timestamp: "2026-08-28T22:14:03.101Z",
    session_id: SESSION_ID,
    channel: "stop",
    source: "turn-end-untaken-action-scan",
    stop_hook_active: false,
    matches: [{ family: "ill-action", phrase: "I'll implement it" }],
    final_message_tail: tail,
  });
}

/** `wall-of-text`, whose `excerpt` IS consumed at the top level. */
function wallOfTextLine(excerpt: string): string {
  return JSON.stringify({
    timestamp: "2026-08-28T22:14:03.101Z",
    session_id: SESSION_ID,
    wordCount: 444,
    lineCount: 30,
    trigger: "over-budget",
    leadLabelHits: [],
    deeplinkCount: 1,
    namedRefCount: 23,
    excerpt,
  });
}

/** `negative-existence-claim`, whose judged text sits inside `claims[].excerpt`. */
function negativeExistenceLine(excerpts: string[]): string {
  return JSON.stringify({
    timestamp: "2026-08-28T22:14:03.101Z",
    session_id: SESSION_ID,
    doneTaskIds: ["mt#4197"],
    doneLookupUnavailable: false,
    thinSearches: 1,
    claims: excerpts.map((excerpt) => ({ pattern: "no such", excerpt })),
  });
}

const REAL_TAIL =
  "I'll implement the fix in a follow-up once the current PR merges, so nothing is blocked here.";

describe("judged-text recoverability derives from the evidence present (mt#4465)", () => {
  test("AT1: final_message_tail with no captureSchema is RECOVERABLE, not unrecoverable", () => {
    const records = [parsed(untakenActionLine(REAL_TAIL), "untaken-action")];

    const { judgedText } = assessClassifiability(records, "untaken-action");

    expect(judgedText.recoverability).toBe("recoverable");
    expect(judgedText.recoverableRecords).toBe(1);
    // The adoption signal is untouched and still reports non-adoption.
    expect(judgedText.capturedRecords).toBe(0);
    expect(judgedText.unmappedDetector).toBeUndefined();
  });

  test("a top-level field (wall-of-text's `excerpt`) is found too — both levels are read", () => {
    const records = [parsed(wallOfTextLine("A long report the detector judged."), "wall-of-text")];

    const { judgedText } = assessClassifiability(records, "wall-of-text");

    expect(judgedText.recoverability).toBe("recoverable");
    expect(judgedText.capturedRecords).toBe(0);
  });

  test("judged text nested in an array of objects (`claims[].excerpt`) counts", () => {
    const records = [
      parsed(negativeExistenceLine(["nothing in the corpus covers this"]), "generic-matches"),
    ];

    const { judgedText } = assessClassifiability(records, "negative-existence-claim");

    expect(judgedText.recoverability).toBe("recoverable");
    expect(judgedText.recoverableRecords).toBe(1);
  });

  test("a mixed log reports PARTIAL, bounded to the recoverable records", () => {
    const records = [
      parsed(untakenActionLine(REAL_TAIL), "untaken-action"),
      parsed(untakenActionLine(""), "untaken-action"),
    ];

    const { judgedText } = assessClassifiability(records, "untaken-action");

    expect(judgedText.recoverability).toBe("partial");
    expect(judgedText.recoverableRecords).toBe(1);
    expect(judgedText.recordsAssessed).toBe(2);
  });
});

describe("the mt#3607 bar is not weakened (mt#4465 SC3)", () => {
  test("AT2 negative control: neither a marker nor mapped judged text is still UNRECOVERABLE", () => {
    // Same detector, same mapping — only the evidence is absent. If this passed,
    // the derivation would be reporting recoverable for text nobody can read,
    // which is the permissive direction the whole mechanism exists to prevent.
    const records = [parsed(untakenActionLine(""), "untaken-action")];

    const { judgedText } = assessClassifiability(records, "untaken-action");

    expect(judgedText.recoverability).toBe("unrecoverable");
    expect(judgedText.recoverableRecords).toBe(0);
    // Mapped, so this is a real "the text is gone" — not a missing-map gap.
    expect(judgedText.unmappedDetector).toBeUndefined();
  });

  test("an array of objects whose strings are all empty does NOT count as judged text", () => {
    const records = [parsed(negativeExistenceLine(["", ""]), "generic-matches")];

    const { judgedText } = assessClassifiability(records, "negative-existence-claim");

    expect(judgedText.recoverability).toBe("unrecoverable");
    expect(judgedText.recoverableRecords).toBe(0);
  });
});

describe("an unmapped detector is NAMED, not silently zero (mt#4465 SC4)", () => {
  test("AT3: an unmapped log reports unrecoverable AND names itself", () => {
    const records = [parsed(untakenActionLine(REAL_TAIL), "untaken-action")];

    const { judgedText } = assessClassifiability(records, UNMAPPED);

    expect(judgedText.recoverability).toBe("unrecoverable");
    expect(judgedText.unmappedDetector).toBe(UNMAPPED);
  });

  test("a marker-carrying log needs no mapping, so it is not reported as a gap", () => {
    // `captureSchema` is named by no per-kind branch, so it reaches
    // `detectorFields` — which is exactly where `hasCaptureMarker` reads it.
    const withMarker = JSON.stringify({
      timestamp: "2026-08-28T22:14:03.101Z",
      session_id: SESSION_ID,
      matches: [{ family: "x", phrase: "y" }],
      captureSchema: 1,
    });
    const records = [parsed(withMarker, "generic-matches")];

    const { judgedText } = assessClassifiability(records, UNMAPPED);

    expect(judgedText.recoverability).toBe("recoverable");
    expect(judgedText.capturedRecords).toBe(1);
    expect(judgedText.unmappedDetector).toBeUndefined();
  });

  test("no records is still `no-records`, never an unmapped-detector gap", () => {
    const { judgedText } = assessClassifiability([], UNMAPPED);

    expect(judgedText.recoverability).toBe("no-records");
    expect(judgedText.unmappedDetector).toBeUndefined();
  });
});

/**
 * The four detectors mt#5001 added to `JUDGED_TEXT_FIELDS`.
 *
 * Every fixture below uses the VERBATIM top-level key set from that detector's
 * production log (read 2026-09-09), for the reason mem#1020 gives: a fixture
 * invented from the field name alone can parse into a shape the real writer
 * never produces, and then passes while production still reports the gap.
 *
 * These assert the OUTCOME (`recoverability`) rather than which level the field
 * lands on. That is deliberate — `hasMappedJudgedText` reads both levels, so
 * pinning placement here would test the fixture rather than the derivation.
 *
 * @see mt#5001 — this change
 * @see mt#4465 — the map and the `unmappedDetector` gap report these complete
 */
describe("the mt#5001 mappings: four detectors that carried text the map could not see", () => {
  /** `stale-state-assertion` — 368 of 368 records carry `final_message_tail`. */
  function staleStateLine(tail: string): string {
    return JSON.stringify({
      timestamp: "2026-09-05T15:33:52.979Z",
      session_id: SESSION_ID,
      source: "turn-end-stale-state-assertion-scan",
      channel: "stop",
      stop_hook_active: false,
      fired: false,
      claims: [],
      contradicted: [],
      resolvedCount: 0,
      suppressionReasons: ["nomination-deps-unavailable"],
      final_message_tail: tail,
    });
  }

  /** `knowledge-acquisition` — 19 of 19 carry `matchedTextExcerpt`. */
  function knowledgeAcquisitionLine(excerpt: string): string {
    return JSON.stringify({
      timestamp: "2026-09-06T00:52:29.767Z",
      session_id: SESSION_ID,
      dedupeKey: "k1",
      detectionRung: 1,
      hadPropagation: false,
      keywordHits: ["skill"],
      loadedSkills: [],
      matchedKeyword: "skill",
      matchedSkill: "plan-task",
      researchTools: [],
      suppressionReasons: [],
      matchedTextExcerpt: excerpt,
    });
  }

  /** `causal-premise` — 1 of 1 carries `transcript_excerpt`. */
  function causalPremiseLine(excerpt: string): string {
    return JSON.stringify({
      timestamp: "2026-08-30T19:47:10.988Z",
      session_id: SESSION_ID,
      hadSameTurnVerification: false,
      matchedPhrases: ["because the parser"],
      transcript_excerpt: excerpt,
    });
  }

  /** `unwalked-task` — 149 of 150 carry `final_message_tail`. */
  function unwalkedTaskLine(tail: string): string {
    return JSON.stringify({
      timestamp: "2026-09-06T00:52:29.762Z",
      session_id: SESSION_ID,
      source: "turn-end-unwalked-task-scan",
      channel: "stop",
      stop_hook_active: false,
      unwalkedTaskIds: ["mt#5020"],
      primaryThreadIds: ["mt#5019"],
      suppressionReasons: [],
      final_message_tail: tail,
    });
  }

  const EXCERPT = "The detector was looking at this sentence when it fired.";

  test("stale-state-assertion: final_message_tail is now RECOVERABLE, and no gap is reported", () => {
    const records = [parsed(staleStateLine(EXCERPT), "generic-matches")];

    const { judgedText } = assessClassifiability(records, "stale-state-assertion");

    expect(judgedText.recoverability).toBe("recoverable");
    expect(judgedText.recoverableRecords).toBe(1);
    // The whole point: before mt#5001 this named itself as an unmapped gap.
    expect(judgedText.unmappedDetector).toBeUndefined();
    // Adoption is unchanged — this writer still does not emit the marker.
    expect(judgedText.capturedRecords).toBe(0);
  });

  test("knowledge-acquisition: matchedTextExcerpt is now RECOVERABLE", () => {
    const records = [parsed(knowledgeAcquisitionLine(EXCERPT), "knowledge-acquisition")];

    const { judgedText } = assessClassifiability(records, "knowledge-acquisition");

    expect(judgedText.recoverability).toBe("recoverable");
    expect(judgedText.unmappedDetector).toBeUndefined();
  });

  test("causal-premise: transcript_excerpt maps per DETECTOR, not per field name", () => {
    // `transcript_excerpt` was already mapped — for `retrospective-trigger`.
    // The map is keyed by detector, so that entry did nothing for this one.
    const records = [parsed(causalPremiseLine(EXCERPT), "causal-premise")];

    const { judgedText } = assessClassifiability(records, "causal-premise");

    expect(judgedText.recoverability).toBe("recoverable");
    expect(judgedText.unmappedDetector).toBeUndefined();
  });

  test("unwalked-task: a log that is 149-of-150 populated reports PARTIAL, not recoverable", () => {
    // Mirrors the real population: one record genuinely lacks the field, so the
    // honest verdict is `partial` with the count bounded to what can be re-read.
    const records = [
      parsed(unwalkedTaskLine(EXCERPT), "unwalked-task"),
      parsed(unwalkedTaskLine(""), "unwalked-task"),
    ];

    const { judgedText } = assessClassifiability(records, "unwalked-task");

    expect(judgedText.recoverability).toBe("partial");
    expect(judgedText.recoverableRecords).toBe(1);
    expect(judgedText.recordsAssessed).toBe(2);
    expect(judgedText.unmappedDetector).toBeUndefined();
  });

  test("negative control: a newly-mapped detector with the field EMPTY is still unrecoverable", () => {
    // Adding an entry must not make a log unconditionally optimistic — the
    // mt#3607 bar applies to the new mappings exactly as to the original four.
    const records = [parsed(staleStateLine(""), "generic-matches")];

    const { judgedText } = assessClassifiability(records, "stale-state-assertion");

    expect(judgedText.recoverability).toBe("unrecoverable");
    expect(judgedText.recoverableRecords).toBe(0);
    // Mapped now, so this is a real "the text is gone" rather than a map gap.
    expect(judgedText.unmappedDetector).toBeUndefined();
  });

  test("stop-at-decision stays UNMAPPED deliberately, and still names itself", () => {
    // Its records DO carry `final_message_tail` (10 of 10), but the detector was
    // retired by mt#4978 and will never write another. Left unmapped on purpose;
    // this pins that decision so a future reader does not "fix" it silently.
    const records = [parsed(staleStateLine(EXCERPT), "generic-matches")];

    const { judgedText } = assessClassifiability(records, "stop-at-decision");

    expect(judgedText.recoverability).toBe("unrecoverable");
    expect(judgedText.unmappedDetector).toBe("stop-at-decision");
  });
});
