/**
 * mt#4970 — a record whose every match comes from a LOG-ONLY family is not an
 * operator-facing fire.
 *
 * `injectedFiresSinceLastReview` excluded what the operator never saw, and
 * derived that from `suppressionReasons` alone. Per-FAMILY log-only gating
 * inside a live detector is the other way a fire fails to arrive, and it leaves
 * no suppression reason — nothing suppressed it; it was never eligible. So
 * `untaken-action`'s 2026-09-04 window reported 120 injected fires where 23
 * reached the agent, and every FP rate computed over it was 5x off.
 *
 * Split into its own file rather than added to `calibration-sweep.test.ts`
 * because that file is at the 1500-line `max-lines` ceiling; mirrors the
 * `.evaluation-only.test.ts` / `.supersedes.test.ts` / `.review-due.test.ts`
 * split. All in-memory, no filesystem I/O.
 */

import { describe, test, expect } from "bun:test";
import {
  computeLogResult,
  computeReviewDueLogs,
  isLogOnlyFamilyRecord,
  parseCalibrationRecord,
  FIRES_THRESHOLD,
  type CalibrationLogEntry,
} from "./calibration-sweep";

const UNTAKEN_KIND = "untaken-action";

const UNTAKEN_ENTRY: CalibrationLogEntry = {
  path: ".minsky/untaken-action-calibration.jsonl",
  name: UNTAKEN_KIND,
  kind: UNTAKEN_KIND,
};

/** The two families `turn-end-untaken-action-scan.ts` declares LOG_ONLY. */
const STRANDED = "stranded-task-state";
const PRESENT_PROGRESSIVE = "present-progressive-assertion";
/** An injecting family from the same detector. */
const ILL_ACTION = "ill-action";
/** One of the detector's real suppression reasons. */
const SUPPRESSION_REASON = "armed-watcher-evidence";

/** One second after a base timestamp per index — cheap, always unique/valid ISO-8601. */
function isoAt(baseIso: string, i: number): string {
  return new Date(Date.parse(baseIso) + i * 1000).toISOString();
}

const BASE = "2026-09-04T12:00:00.000Z";

interface MatchSpec {
  family: string;
  logOnly?: true;
}

function makeRecord(i: number, matches: MatchSpec[], suppressionReasons: string[] = []): string {
  return JSON.stringify({
    timestamp: isoAt(BASE, i),
    session_id: `session-${i}`,
    matches: matches.map((m) => ({
      family: m.family,
      phrase: `phrase-${i}`,
      ...(m.logOnly === true ? { logOnly: true } : {}),
    })),
    suppressionReasons,
  });
}

function buildLog(specs: Array<{ matches: MatchSpec[]; suppressionReasons?: string[] }>): string {
  return specs.map((s, i) => makeRecord(i, s.matches, s.suppressionReasons ?? [])).join("\n");
}

const LOG_ONLY_MATCH: MatchSpec = { family: STRANDED, logOnly: true };
const INJECTING_MATCH: MatchSpec = { family: ILL_ACTION };

/**
 * Parse a fixture, failing loudly if it does not.
 *
 * A `null` here means the FIXTURE is malformed, not that the assertion below
 * is false — so it throws rather than being asserted away, which keeps a broken
 * fixture from reading as a passing test.
 */
function parseFixture(line: string) {
  const record = parseCalibrationRecord(line, UNTAKEN_KIND);
  if (record === null) throw new Error(`fixture did not parse: ${line}`);
  return record;
}

describe("isLogOnlyFamilyRecord", () => {
  test("true when every match is declared log-only", () => {
    const record = parseFixture(
      makeRecord(0, [LOG_ONLY_MATCH, { family: PRESENT_PROGRESSIVE, logOnly: true }])
    );
    expect(isLogOnlyFamilyRecord(record)).toBe(true);
  });

  test("AT2: false when ANY match is injecting — the record DID reach the agent", () => {
    // 8 of the 23 injected records in the live 2026-09-04 window are this shape.
    // A `some` test instead of `every` would swing the count wrong the other way.
    const record = parseFixture(makeRecord(0, [LOG_ONLY_MATCH, INJECTING_MATCH]));
    expect(isLogOnlyFamilyRecord(record)).toBe(false);
  });

  test("AT4: false when the marker is ABSENT — absent means not declared, not log-only", () => {
    // Every record written before the writer adopted the field is in this
    // position. Treating absent as log-only would retroactively reclassify
    // history and shift FP rates under a reader.
    const record = parseFixture(makeRecord(0, [{ family: STRANDED }]));
    expect(isLogOnlyFamilyRecord(record)).toBe(false);
  });

  test("false for an evaluation-only record — empty matches is not vacuously log-only", () => {
    const record = parseFixture(makeRecord(0, []));
    expect(isLogOnlyFamilyRecord(record)).toBe(false);
  });

  test("the marker is parsed onto the match, not left in detectorFields", () => {
    // mem#827: a field the COUNTING path reads must not ride in the nested
    // passthrough, which reviewers have repeatedly read as if it were the record.
    const record = parseFixture(makeRecord(0, [LOG_ONLY_MATCH]));
    const [match] = (record as { matches: Array<Record<string, unknown>> }).matches;
    expect(match?.["logOnly"]).toBe(true);
    expect(match?.["detectorFields"]).toBeUndefined();
  });
});

describe("computeLogResult — log-only families are excluded from the injected count", () => {
  test("AT1: log-only records are counted under their own name, not as injected", () => {
    // The live window's shape in miniature: mostly log-only, a few injecting.
    const content = buildLog([
      ...Array.from({ length: 9 }, () => ({ matches: [LOG_ONLY_MATCH] })),
      ...Array.from({ length: 3 }, () => ({ matches: [INJECTING_MATCH] })),
    ]);
    const result = computeLogResult(UNTAKEN_ENTRY, content, true, undefined);

    expect(result.firesSinceLastReview).toBe(12);
    expect(result.injectedFiresSinceLastReview).toBe(3);
    expect(result.logOnlyFamilySinceLastReview).toBe(9);
    // Not double-counted into the evaluation-only column.
    expect(result.evaluatedOnlySinceLastReview).toBe(0);
  });

  test("AT2 end-to-end: a mixed record counts as injected, not log-only", () => {
    const content = buildLog([
      { matches: [LOG_ONLY_MATCH] },
      { matches: [LOG_ONLY_MATCH, INJECTING_MATCH] },
    ]);
    const result = computeLogResult(UNTAKEN_ENTRY, content, true, undefined);

    expect(result.injectedFiresSinceLastReview).toBe(1);
    expect(result.logOnlyFamilySinceLastReview).toBe(1);
  });

  test("a SUPPRESSED log-only record counts as suppressed, not log-only", () => {
    // Suppression is checked first, so the two columns never double-count the
    // same record — `firesSinceLastReview` stays the sum of the parts.
    const content = buildLog([
      { matches: [LOG_ONLY_MATCH], suppressionReasons: [SUPPRESSION_REASON] },
      { matches: [LOG_ONLY_MATCH] },
    ]);
    const result = computeLogResult(UNTAKEN_ENTRY, content, true, undefined);

    expect(result.suppressedSinceLastReview).toBe(1);
    expect(result.logOnlyFamilySinceLastReview).toBe(1);
    expect(result.injectedFiresSinceLastReview).toBe(0);
  });

  test("AT3: a detector with no log-only families reports an unchanged count", () => {
    const content = buildLog(Array.from({ length: 5 }, () => ({ matches: [INJECTING_MATCH] })));
    const result = computeLogResult(UNTAKEN_ENTRY, content, true, undefined);

    expect(result.injectedFiresSinceLastReview).toBe(5);
    expect(result.logOnlyFamilySinceLastReview).toBe(0);
    // The additive claim: with no log-only volume, the new gate reduces to the old one.
    expect(result.allWithheld).toBe(result.allSuppressed);
  });
});

describe("computeLogResult — the review-due cliff the exclusion would otherwise open", () => {
  test("AT5: an all-log-only log at volume stays routable and keeps its records", () => {
    // Without `allWithheld` this log has injected 0 AND suppressed 0, so
    // `atCountThreshold` is false and `allSuppressed` is false — it falls
    // through both gates and becomes invisible to review, which is exactly the
    // failure mt#4049 shipped `allSuppressed` to prevent for the other column.
    const content = buildLog(
      Array.from({ length: FIRES_THRESHOLD }, () => ({ matches: [LOG_ONLY_MATCH] }))
    );
    const result = computeLogResult(UNTAKEN_ENTRY, content, true, undefined);

    expect(result.injectedFiresSinceLastReview).toBe(0);
    expect(result.suppressedSinceLastReview).toBe(0);
    expect(result.atCountThreshold).toBe(false);
    expect(result.allSuppressed).toBe(false);

    expect(result.allWithheld).toBe(true);
    // The compounding trap mt#4049 names: routed for review AND handed the
    // records that answer "is this arm too broad?".
    expect(result.newRecords.length).toBe(FIRES_THRESHOLD);

    // ROUTING, not the flag. PR #3644 R1 was BLOCKING because the assertions
    // above all passed while `computeReviewDueLogs` still keyed its leg on
    // `allSuppressed` — the log computed as withheld and was never surfaced.
    // `allWithheld` is a proxy for the outcome; this is the outcome.
    const due = computeReviewDueLogs([result], {}, Date.parse(BASE));
    expect(due.map((d) => d.name)).toEqual([UNTAKEN_KIND]);
    expect(due[0]?.reason).toBe("all-withheld");
    expect(due[0]?.logOnlyFamilySinceLastReview).toBe(FIRES_THRESHOLD);
  });

  test("the reason stays `all-suppressed` when suppression is what carried it", () => {
    // The two legs must remain distinguishable: telling a reviewer every
    // detection was suppressed on a log that suppressed nothing is false, and
    // the cadence hook renders a different sentence for each.
    const content = buildLog(
      Array.from({ length: FIRES_THRESHOLD }, () => ({
        matches: [INJECTING_MATCH],
        suppressionReasons: [SUPPRESSION_REASON],
      }))
    );
    const result = computeLogResult(UNTAKEN_ENTRY, content, true, undefined);
    const due = computeReviewDueLogs([result], {}, Date.parse(BASE));

    expect(result.allSuppressed).toBe(true);
    expect(due[0]?.reason).toBe("all-suppressed");
  });

  test("a log-only log BELOW the bar is not routed — the volume question is unchanged", () => {
    const content = buildLog(
      Array.from({ length: FIRES_THRESHOLD - 1 }, () => ({ matches: [LOG_ONLY_MATCH] }))
    );
    const result = computeLogResult(UNTAKEN_ENTRY, content, true, undefined);

    expect(result.allWithheld).toBe(false);
    expect(result.newRecords).toEqual([]);
  });

  test("suppressed and log-only volume COMBINE to clear the bar", () => {
    // Both columns answer one question — the record matched and the operator
    // never saw it — so neither alone needs to reach the threshold.
    const half = Math.floor(FIRES_THRESHOLD / 2);
    const content = buildLog([
      ...Array.from({ length: half }, () => ({
        matches: [LOG_ONLY_MATCH],
        suppressionReasons: [SUPPRESSION_REASON],
      })),
      ...Array.from({ length: FIRES_THRESHOLD - half }, () => ({ matches: [LOG_ONLY_MATCH] })),
    ]);
    const result = computeLogResult(UNTAKEN_ENTRY, content, true, undefined);

    expect(result.injectedFiresSinceLastReview).toBe(0);
    expect(result.allSuppressed).toBe(false);
    expect(result.allWithheld).toBe(true);
  });

  test("an all-EVALUATION-ONLY log stays unroutable — those records never matched", () => {
    // The deliberate non-symmetry. An evaluation-only record has nothing to
    // classify, so its absence from review is correct rather than a cliff;
    // folding it into the union would route every no-match log for review.
    const content = buildLog(Array.from({ length: FIRES_THRESHOLD * 2 }, () => ({ matches: [] })));
    const result = computeLogResult(UNTAKEN_ENTRY, content, true, undefined);

    expect(result.evaluatedOnlySinceLastReview).toBe(FIRES_THRESHOLD * 2);
    expect(result.injectedFiresSinceLastReview).toBe(0);
    expect(result.allWithheld).toBe(false);
  });
});
