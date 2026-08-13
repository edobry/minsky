/**
 * mt#3863 — evaluation-only records (no match, no injection) do not count as
 * fires.
 *
 * The sweep's `injectedFiresSinceLastReview` used to count every RECORD
 * appended to a log, not just the ones carrying a match. A detector that
 * writes an evaluation record on every turn regardless of outcome
 * (retrospective-trigger's Rung-2 nomination path; bare-entity-ref's
 * record-only classes) inflated the count by an order of magnitude — 193
 * counted vs 8 actual for retrospective-trigger's 2026-08-08 review window —
 * which kept the log permanently `pastThreshold` on evaluation volume alone.
 *
 * Split into its own file rather than added to `calibration-sweep.test.ts`
 * because that file is at the 1500-line `max-lines` ceiling; mirrors the
 * existing `calibration-sweep.supersedes.test.ts` / `.review-due.test.ts`
 * split. All in-memory, no filesystem I/O.
 */

import { describe, test, expect } from "bun:test";
import {
  computeLogResult,
  isEvaluationOnlyRecord,
  parseCalibrationRecord,
  FIRES_THRESHOLD,
  type CalibrationLogEntry,
} from "./calibration-sweep";

const RETRO_KIND = "retrospective-trigger";

const RETRO_ENTRY: CalibrationLogEntry = {
  path: ".minsky/retrospective-trigger-calibration.jsonl",
  name: RETRO_KIND,
  kind: RETRO_KIND,
};

const BARE_ENTITY_REF_ENTRY: CalibrationLogEntry = {
  path: ".minsky/bare-entity-ref-calibration.jsonl",
  name: "bare-entity-ref",
  kind: "bare-entity-ref",
};

function buildLines(count: number, makeLine: (i: number) => string): string {
  return Array.from({ length: count }, (_, i) => makeLine(i)).join("\n");
}

/** One second after a base timestamp per index — cheap, always unique/valid ISO-8601. */
function isoAt(baseIso: string, i: number): string {
  return new Date(Date.parse(baseIso) + i * 1000).toISOString();
}

// ---------------------------------------------------------------------------
// retrospective-trigger fixtures
// ---------------------------------------------------------------------------

/** A retrospective-trigger record carrying a real match. */
function makeRetroMatchedRecord(base: string, i: number): string {
  return JSON.stringify({
    timestamp: isoAt(base, i),
    session_id: `session-matched-${i}`,
    matches: [{ family: "R1", phrase: `phrase-${i}` }],
  });
}

/**
 * A retrospective-trigger record from a Rung-2 nomination that never reached
 * a verdict — `nomination_degraded: "timeout"` (mt#3862) or simply
 * unconfirmed. Either way `matches: []`: the discriminator this task's fix
 * reads.
 */
function makeRetroNoMatchRecord(base: string, i: number): string {
  return JSON.stringify({
    timestamp: isoAt(base, i),
    session_id: `session-no-match-${i}`,
    matches: [],
    nomination_degraded: "timeout",
  });
}

// ---------------------------------------------------------------------------
// bare-entity-ref fixtures
// ---------------------------------------------------------------------------

/** A bare-entity-ref record — a real fire: flagged and the advisory emitted. */
function makeBareRefFlaggedRecord(base: string, i: number): string {
  return JSON.stringify({
    timestamp: isoAt(base, i),
    session_id: `session-flagged-${i}`,
    stop_hook_active: false,
    matches: [{ family: "bare-short-id", phrase: `mem#${900 + i}` }],
    logged_only: [],
    flagged_count: 1,
    logged_only_count: 0,
    advisory_chain_capped: false,
    advisory_emitted: true,
  });
}

/**
 * A bare-entity-ref record carrying ONLY record-only findings (the
 * `bare-ref` / `linkable-short-id` classes, mt#3897/mt#3960) — `matches: []`,
 * nothing injected.
 */
function makeBareRefLoggedOnlyRecord(base: string, i: number): string {
  return JSON.stringify({
    timestamp: isoAt(base, i),
    session_id: `session-logged-only-${i}`,
    stop_hook_active: false,
    matches: [],
    logged_only: [{ family: "bare-ref", phrase: `mt#${3000 + i}` }],
    flagged_count: 0,
    logged_only_count: 1,
    advisory_chain_capped: false,
    advisory_emitted: false,
  });
}

// ---------------------------------------------------------------------------
// isEvaluationOnlyRecord
// ---------------------------------------------------------------------------

describe("isEvaluationOnlyRecord (mt#3863)", () => {
  test("a record with an empty matches array is evaluation-only", () => {
    const parsed = parseCalibrationRecord(
      makeRetroNoMatchRecord("2026-08-08T00:00:00Z", 0),
      RETRO_KIND
    );
    expect(parsed).not.toBeNull();
    if (parsed === null) return;
    expect(isEvaluationOnlyRecord(parsed)).toBe(true);
  });

  test("a record with a non-empty matches array is not evaluation-only", () => {
    const parsed = parseCalibrationRecord(
      makeRetroMatchedRecord("2026-08-08T00:00:00Z", 0),
      RETRO_KIND
    );
    expect(parsed).not.toBeNull();
    if (parsed === null) return;
    expect(isEvaluationOnlyRecord(parsed)).toBe(false);
  });

  test("a bare-entity-ref record-only fire (matches empty, logged_only populated) is evaluation-only", () => {
    const parsed = parseCalibrationRecord(
      makeBareRefLoggedOnlyRecord("2026-08-11T00:00:00Z", 0),
      "bare-entity-ref"
    );
    expect(parsed).not.toBeNull();
    if (parsed === null) return;
    expect(isEvaluationOnlyRecord(parsed)).toBe(true);
  });

  test("a bare-entity-ref flagged fire (matches non-empty, advisory emitted) is not evaluation-only", () => {
    const parsed = parseCalibrationRecord(
      makeBareRefFlaggedRecord("2026-08-11T00:00:00Z", 0),
      "bare-entity-ref"
    );
    expect(parsed).not.toBeNull();
    if (parsed === null) return;
    expect(isEvaluationOnlyRecord(parsed)).toBe(false);
  });

  test("a record kind with no matches field at all is never evaluation-only", () => {
    // causal-premise gates the calibration WRITE itself on a match
    // (`if (!result.matched) return null`), so `matchedPhrases` is never
    // empty in the log — there is no no-match population to exclude, and
    // this predicate must not invent one.
    const parsed = parseCalibrationRecord(
      JSON.stringify({
        timestamp: "2026-08-08T00:00:00Z",
        session_id: "s",
        matchedPhrases: [],
        hadSameTurnVerification: false,
      }),
      "causal-premise"
    );
    expect(parsed).not.toBeNull();
    if (parsed === null) return;
    expect(isEvaluationOnlyRecord(parsed)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AT1 — a log dominated by empty-match evaluations counts only the matched
// records, and the evaluation count is reported separately.
// ---------------------------------------------------------------------------

describe("AT1 — 90% empty-match evaluations, 10% matched", () => {
  test("fire count reflects only the matched records; evaluated count is separate", () => {
    const matched = buildLines(2, (i) => makeRetroMatchedRecord("2026-08-08T00:00:00Z", i));
    const noMatch = buildLines(18, (i) => makeRetroNoMatchRecord("2026-08-08T01:00:00Z", i));
    const result = computeLogResult(RETRO_ENTRY, `${matched}\n${noMatch}`, true, undefined);

    expect(result.firesSinceLastReview).toBe(20);
    expect(result.injectedFiresSinceLastReview).toBe(2);
    expect(result.evaluatedOnlySinceLastReview).toBe(18);
  });
});

// ---------------------------------------------------------------------------
// AT2 — a log of exclusively evaluation records with zero matches does not
// reach pastThreshold on count, at any volume.
// ---------------------------------------------------------------------------

describe("AT2 — an all-evaluation log never reaches pastThreshold on count", () => {
  test(`${FIRES_THRESHOLD * 5} no-match evaluation records still report zero fires`, () => {
    const content = buildLines(FIRES_THRESHOLD * 5, (i) =>
      makeRetroNoMatchRecord("2026-08-08T00:00:00Z", i)
    );
    const result = computeLogResult(RETRO_ENTRY, content, true, undefined);

    expect(result.firesSinceLastReview).toBe(FIRES_THRESHOLD * 5);
    expect(result.injectedFiresSinceLastReview).toBe(0);
    expect(result.evaluatedOnlySinceLastReview).toBe(FIRES_THRESHOLD * 5);
    expect(result.atCountThreshold).toBe(false);
    expect(result.pastThreshold).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AT3 — regression: a log whose records ALL carry a non-empty matches array
// reports the same count before and after the change. bare-entity-ref is NOT
// such a log (see the fresh-instance sections in the spec) — use a
// retrospective-trigger fixture where every record matched.
// ---------------------------------------------------------------------------

describe("AT3 — regression: an all-matched log is unaffected", () => {
  test(`${FIRES_THRESHOLD} matched records report the same count before and after`, () => {
    const content = buildLines(FIRES_THRESHOLD, (i) =>
      makeRetroMatchedRecord("2026-08-08T00:00:00Z", i)
    );
    const result = computeLogResult(RETRO_ENTRY, content, true, undefined);

    expect(result.firesSinceLastReview).toBe(FIRES_THRESHOLD);
    expect(result.injectedFiresSinceLastReview).toBe(FIRES_THRESHOLD);
    expect(result.evaluatedOnlySinceLastReview).toBe(0);
    expect(result.pastThreshold).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AT4 — replaying retrospective-trigger-calibration.jsonl through the new
// counting. The spec's window figures (2026-08-08: 193 counted / 8 matched)
// are reproduced directly; the lifetime figure is window-specific by the
// spec's own instruction and is re-derived at implementation time
// (2026-08-11 planning-audit replay: 893 records / 71 matched lifetime).
// ---------------------------------------------------------------------------

describe("AT4 — retrospective-trigger replay", () => {
  test("the 2026-08-08 review window: 193 records, 8 matched", () => {
    const matched = buildLines(8, (i) => makeRetroMatchedRecord("2026-08-08T00:00:00Z", i));
    const noMatch = buildLines(185, (i) => makeRetroNoMatchRecord("2026-08-08T02:00:00Z", i));
    const result = computeLogResult(RETRO_ENTRY, `${matched}\n${noMatch}`, true, undefined);

    expect(result.firesSinceLastReview).toBe(193);
    expect(result.injectedFiresSinceLastReview).toBe(8);
    expect(result.evaluatedOnlySinceLastReview).toBe(185);
  });

  test("lifetime (re-derived 2026-08-11): 893 records, 71 matched", () => {
    const matched = buildLines(71, (i) => makeRetroMatchedRecord("2026-01-01T00:00:00Z", i));
    const noMatch = buildLines(822, (i) => makeRetroNoMatchRecord("2026-02-01T00:00:00Z", i));
    const result = computeLogResult(RETRO_ENTRY, `${matched}\n${noMatch}`, true, undefined);

    expect(result.totalFires).toBe(893);
    // watermark undefined -> newRecords covers the whole (lifetime) log.
    expect(result.injectedFiresSinceLastReview).toBe(71);
    expect(result.evaluatedOnlySinceLastReview).toBe(822);
  });
});

// ---------------------------------------------------------------------------
// AT5 — replaying bare-entity-ref-calibration.jsonl through the new
// counting. The 2026-08-10 09:57 window figure (6 of 11) is reproduced
// directly; the lifetime figure is re-derived at implementation time
// (2026-08-11 planning-audit replay: 332 records / 103 matched lifetime).
// ---------------------------------------------------------------------------

describe("AT5 — bare-entity-ref replay", () => {
  test("the 2026-08-10 09:57 window: 11 records, 6 injected an advisory", () => {
    const flagged = buildLines(6, (i) => makeBareRefFlaggedRecord("2026-08-10T09:00:00Z", i));
    const loggedOnly = buildLines(5, (i) => makeBareRefLoggedOnlyRecord("2026-08-10T09:30:00Z", i));
    const result = computeLogResult(
      BARE_ENTITY_REF_ENTRY,
      `${flagged}\n${loggedOnly}`,
      true,
      undefined
    );

    expect(result.firesSinceLastReview).toBe(11);
    expect(result.injectedFiresSinceLastReview).toBe(6);
    expect(result.evaluatedOnlySinceLastReview).toBe(5);
  });

  test("lifetime (re-derived 2026-08-11): 332 records, 103 matched", () => {
    const flagged = buildLines(103, (i) => makeBareRefFlaggedRecord("2026-01-01T00:00:00Z", i));
    const loggedOnly = buildLines(229, (i) =>
      makeBareRefLoggedOnlyRecord("2026-02-01T00:00:00Z", i)
    );
    const result = computeLogResult(
      BARE_ENTITY_REF_ENTRY,
      `${flagged}\n${loggedOnly}`,
      true,
      undefined
    );

    expect(result.totalFires).toBe(332);
    expect(result.injectedFiresSinceLastReview).toBe(103);
    expect(result.evaluatedOnlySinceLastReview).toBe(229);
  });
});

// ---------------------------------------------------------------------------
// SC4 — no calibration data is discarded: the evaluation records stay in the
// log and remain visible once the count bar IS cleared by real fires.
// ---------------------------------------------------------------------------

describe("SC4 — evaluation-only records are not dropped from the log", () => {
  test("newRecords still carries every record, including evaluation-only ones, once past threshold", () => {
    const matched = buildLines(FIRES_THRESHOLD, (i) =>
      makeRetroMatchedRecord("2026-08-08T00:00:00Z", i)
    );
    const noMatch = buildLines(5, (i) => makeRetroNoMatchRecord("2026-08-08T02:00:00Z", i));
    const result = computeLogResult(RETRO_ENTRY, `${matched}\n${noMatch}`, true, undefined);

    expect(result.pastThreshold).toBe(true);
    // Count bar cleared -> newRecords is populated, and it holds ALL records,
    // not just the injected ones — the false-negative-rate input mt#3743 and
    // mt#3615 depend on.
    expect(result.newRecords).toHaveLength(FIRES_THRESHOLD + 5);
    expect(result.newRecords.filter(isEvaluationOnlyRecord)).toHaveLength(5);
  });
});
