/**
 * mt#5000 SC3 — a suppression that means "could not check" is counted apart
 * from one that means "checked, and withheld".
 *
 * `isSuppressedRecord` asks only whether `suppressionReasons` is non-empty, so a
 * detector that never reached its dependencies and a detector that reached a
 * verdict and declined to inject are byte-identical to the sweep. That makes the
 * `all-suppressed` leg's own question — *"is the suppression gate too broad?"* —
 * unanswerable on a degraded population, without anything saying so: measured on
 * `stale-state-assertion` before this task's fix, 214 of 242 suppressions (88%)
 * were `nomination-deps-unavailable`, i.e. the embedding provider was never
 * reached at all.
 *
 * ADR-035 §Decision rule 3 ("'configured but failing' MUST be distinguishable
 * from 'not configured'") is the governing record; rule 5's third obligation —
 * data-plane honesty — is why the count has to reach the surface a caller reads
 * rather than only the domain result.
 *
 * Split into its own file rather than added to `calibration-sweep.test.ts`,
 * which is at the 1500-line `max-lines` ceiling — mirroring the existing
 * `.evaluation-only.test.ts` / `.review-due.test.ts` split. All in-memory, no
 * filesystem I/O.
 */

import { describe, test, expect } from "bun:test";
import {
  computeLogResult,
  isSuppressedRecord,
  isUndeterminedRecord,
  parseCalibrationRecord,
  COULD_NOT_CHECK_SUPPRESSION_PREFIXES,
  type CalibrationLogEntry,
} from "./calibration-sweep";

const STALE_STATE_KIND = "stale-state-assertion";

const STALE_STATE_ENTRY: CalibrationLogEntry = {
  path: ".minsky/stale-state-assertion-calibration.jsonl",
  name: STALE_STATE_KIND,
  kind: STALE_STATE_KIND,
};

/** One second after a base timestamp per index — cheap, always unique/valid ISO-8601. */
function isoAt(baseIso: string, i: number): string {
  return new Date(Date.parse(baseIso) + i * 1000).toISOString();
}

const BASE = "2026-09-09T00:00:00.000Z";

/**
 * The two reasons these tests pivot on, named rather than repeated.
 *
 * Both are verbatim from the production log — the point of each assertion is
 * that they land on OPPOSITE sides of the could-not-check line, so a typo in one
 * would quietly turn a discriminating test into a tautological one.
 */
/** Could-not-check: the nomination stage never reached its embedding provider. */
const REASON_COULD_NOT_CHECK = "nomination-deps-unavailable";
/** A substantive verdict: the detector checked, and the refs were genuinely open. */
const REASON_VERDICT = "all-claimed-refs-still-open";

/**
 * A record whose shape is taken from the production log verbatim, so the parse
 * path under test is the real one rather than a shape invented for the test.
 */
function makeRecord(i: number, suppressionReasons: string[], fired = false): string {
  return JSON.stringify({
    timestamp: isoAt(BASE, i),
    session_id: `session-${i}`,
    stop_hook_active: false,
    fired,
    rung: 2,
    claims: fired
      ? [{ ref: `mt#${5000 + i}`, kind: "task", assertionFamily: "past-tense-claim" }]
      : [],
    contradicted: [],
    resolvedCount: 0,
    suppressionReasons,
  });
}

function parse(line: string) {
  const record = parseCalibrationRecord(line, STALE_STATE_KIND);
  if (record === null) throw new Error("fixture failed to parse — the test would be vacuous");
  return record;
}

describe("mt#5000 — isUndeterminedRecord discriminates could-not-check from checked", () => {
  test("a could-not-check reason is BOTH suppressed and undetermined", () => {
    const record = parse(makeRecord(0, [REASON_COULD_NOT_CHECK]));
    // The subset relationship is the design: it stays counted as suppressed so
    // the routing gates cannot lose it (mt#4049 / mt#4970's cliff).
    expect(isSuppressedRecord(record)).toBe(true);
    expect(isUndeterminedRecord(record)).toBe(true);
  });

  test("a substantive verdict is suppressed but NOT undetermined", () => {
    const record = parse(makeRecord(1, [REASON_VERDICT]));
    expect(isSuppressedRecord(record)).toBe(true);
    expect(isUndeterminedRecord(record)).toBe(false);
  });

  test("a fired record is neither", () => {
    const record = parse(makeRecord(2, [], true));
    expect(isSuppressedRecord(record)).toBe(false);
    expect(isUndeterminedRecord(record)).toBe(false);
  });

  test("a prefix reason carrying its cause still matches", () => {
    // The reason mt#5000 itself introduces, which appends the bootstrap's error.
    const record = parse(
      makeRecord(3, ["domain-bootstrap-failed: Configuration not initialized."])
    );
    expect(isUndeterminedRecord(record)).toBe(true);
  });

  test("a MIXED record is not undetermined — it did conclude something", () => {
    // Counting this as undetermined would overstate the blindness, which is the
    // same error as understating it, pointed the other way.
    const record = parse(makeRecord(4, [REASON_COULD_NOT_CHECK, REASON_VERDICT]));
    expect(isSuppressedRecord(record)).toBe(true);
    expect(isUndeterminedRecord(record)).toBe(false);
  });

  test("an unrecognised reason is treated as a verdict, not as could-not-check", () => {
    // Fail toward "the detector worked": inventing blindness that was not
    // measured would send a reviewer to fix a detector that is fine.
    const record = parse(makeRecord(5, ["some-future-reason-nobody-listed"]));
    expect(isUndeterminedRecord(record)).toBe(false);
  });

  test("the prefix list is non-empty — a silently emptied list would pass everything", () => {
    // Guards the vacuous-pass mode: with an empty list `every()` returns true for
    // no reason at all, and every suppressed record would read as undetermined.
    expect(COULD_NOT_CHECK_SUPPRESSION_PREFIXES.length).toBeGreaterThan(0);
  });
});

describe("mt#5000 SC3 — the sweep reports the could-not-check share", () => {
  test("a degraded population is counted, and does NOT change the suppressed total", () => {
    // 8 could-not-check + 2 real verdicts: the shape of the production window
    // this task measured, scaled down.
    const lines = [
      ...Array.from({ length: 8 }, (_, i) => makeRecord(i, [REASON_COULD_NOT_CHECK])),
      makeRecord(8, [REASON_VERDICT]),
      makeRecord(9, ["no-claimed-ref-resolved"]),
    ].join("\n");

    const result = computeLogResult(STALE_STATE_ENTRY, lines, true, undefined);

    expect(result.suppressedSinceLastReview).toBe(10);
    expect(result.undeterminedSinceLastReview).toBe(8);
    // The routing gate is deliberately UNCHANGED by the new column — removing
    // these records from the union is what would open mt#4049's cliff.
    expect(result.injectedFiresSinceLastReview).toBe(0);
    expect(result.allSuppressed).toBe(true);
  });

  test("a healthy log reports zero undetermined, so the field cannot read as noise", () => {
    const lines = Array.from({ length: 6 }, (_, i) => makeRecord(i, [REASON_VERDICT])).join("\n");

    const result = computeLogResult(STALE_STATE_ENTRY, lines, true, undefined);

    expect(result.suppressedSinceLastReview).toBe(6);
    expect(result.undeterminedSinceLastReview).toBe(0);
  });
});
