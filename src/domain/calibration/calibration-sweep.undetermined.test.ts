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

/**
 * PR #3700 R1 (BLOCKING) — the classifier's prefixes reach beyond this PR's own
 * emitters, so an over-broad one would silently reclassify ANOTHER detector's
 * verdicts as "the detector was blind." Nothing guarded that.
 *
 * The fixture is not invented: it is every distinct `suppressionReasons` value
 * this repo has ever written, enumerated across all 23 calibration logs' full
 * history on 2026-09-09, with per-record detail after a colon collapsed. Pinning
 * the REAL corpus is what makes this a guard rather than a restatement of the
 * list — a prefix that starts matching a neighbouring detector's verdict fails
 * here, on a row whose expected value a reader can check against the log.
 *
 * Two entries (`nomination-deps-timeout`, `domain-bootstrap-failed`) have NEVER
 * appeared in a log and are marked as such: the first is an existing exit that
 * has not fired, the second is introduced by this PR. They are pinned anyway,
 * because a reason that has not fired yet is exactly the one nobody would notice
 * being misclassified.
 */
/**
 * The logs each corpus row was observed in, named once.
 *
 * The provenance is worth keeping per row — it is what lets a reader re-derive
 * any line against the actual log — but repeating the names inline trips
 * `custom/no-magic-string-duplication`, and it is right to: a typo'd detector
 * name in a fixture is invisible, since nothing resolves it.
 */
const LOG = {
  staleState: STALE_STATE_KIND,
  preNarration: "pre-narration",
  codeMechanism: "code-mechanism-assertion",
  untakenAction: "untaken-action",
  wallOfText: "wall-of-text",
  knowledgeAcquisition: "knowledge-acquisition",
  askRoutingDeferral: "ask-routing-deferral",
} as const;

const OBSERVED_CORPUS: ReadonlyArray<{
  detector: string;
  reason: string;
  undetermined: boolean;
  note?: string;
}> = [
  // ── could-not-check: the detector never completed its check ───────────────
  { detector: LOG.staleState, reason: "nomination-deps-unavailable", undetermined: true },
  { detector: LOG.staleState, reason: "nomination-degraded: timeout", undetermined: true },
  {
    detector: LOG.staleState,
    reason: "nomination-deps-timeout",
    undetermined: true,
    note: "existing exit, never observed firing",
  },
  {
    detector: LOG.staleState,
    reason: "nomination-deps-threw: db down",
    undetermined: true,
    note: "existing exit, never observed firing",
  },
  {
    detector: LOG.staleState,
    reason: "domain-bootstrap-failed: Configuration not initialized.",
    undetermined: true,
    note: "introduced by this PR",
  },
  {
    detector: LOG.staleState,
    reason: "transcript-unreadable: past-tense claims not checked",
    undetermined: true,
  },
  {
    detector: LOG.staleState,
    reason: "lookup-unavailable: persistence provider unavailable",
    undetermined: true,
  },
  {
    detector: LOG.staleState,
    reason: "peer-read-failed mt#4555: boom",
    undetermined: true,
  },
  {
    detector: LOG.staleState,
    reason: "peer-read-unavailable mt#4555: ledger read returned null",
    undetermined: true,
  },

  // ── verdicts: the detector checked and declined to inject ─────────────────
  // Every one of these is a row the classifier must NOT claim. They are the
  // reason the list is prefixes-with-citations rather than a substring rule:
  // "armed-watcher-evidence" and "peer-read-unavailable" both contain words a
  // looser matcher would have taken.
  { detector: LOG.staleState, reason: "all-claimed-refs-still-open", undetermined: false },
  { detector: LOG.staleState, reason: "no-claimed-ref-resolved", undetermined: false },
  {
    detector: LOG.staleState,
    reason: "nominated-but-substrate-agrees",
    undetermined: false,
  },
  { detector: LOG.preNarration, reason: "same-turn-tool-call", undetermined: false },
  { detector: LOG.preNarration, reason: "window-tool-call", undetermined: false },
  { detector: LOG.preNarration, reason: "identity-scoped-tool-call", undetermined: false },
  { detector: LOG.codeMechanism, reason: "artifact-surface-only", undetermined: false },
  { detector: LOG.codeMechanism, reason: "same-turn-read", undetermined: false },
  { detector: LOG.codeMechanism, reason: "deduped", undetermined: false },
  { detector: LOG.codeMechanism, reason: "comment-surface-only", undetermined: false },
  { detector: LOG.codeMechanism, reason: "write-echo-backed", undetermined: false },
  { detector: LOG.codeMechanism, reason: "symbol-free-cohort-only", undetermined: false },
  { detector: LOG.untakenAction, reason: "armed-watcher-evidence", undetermined: false },
  { detector: LOG.untakenAction, reason: "reserved-category-halt", undetermined: false },
  { detector: LOG.untakenAction, reason: "principal-instruction-halt", undetermined: false },
  { detector: LOG.untakenAction, reason: "destructive-action-halt", undetermined: false },
  { detector: LOG.wallOfText, reason: "question-answer-override", undetermined: false },
  { detector: LOG.wallOfText, reason: "depth-request-override", undetermined: false },
  { detector: LOG.knowledgeAcquisition, reason: "propagation-in-window", undetermined: false },
  {
    detector: LOG.askRoutingDeferral,
    reason: "deduped-by-untaken-action-stop",
    undetermined: false,
  },
  { detector: LOG.askRoutingDeferral, reason: "asks-create-this-turn", undetermined: false },
  { detector: LOG.askRoutingDeferral, reason: "cites-filed-ask", undetermined: false },
];

describe("mt#5000 PR #3700 R1 — the classifier is pinned against the real observed corpus", () => {
  for (const { detector, reason, undetermined, note } of OBSERVED_CORPUS) {
    const label = note === undefined ? "" : ` (${note})`;
    test(`${detector}: "${reason}" → ${undetermined ? "could-not-check" : "verdict"}${label}`, () => {
      const record = parse(makeRecord(0, [reason]));
      expect(isUndeterminedRecord(record)).toBe(undetermined);
    });
  }

  test("the corpus covers BOTH classifications — a one-sided fixture proves nothing", () => {
    // Without this, deleting every `undetermined: false` row would leave a suite
    // that passes for a classifier returning `true` unconditionally.
    expect(OBSERVED_CORPUS.some((c) => c.undetermined)).toBe(true);
    expect(OBSERVED_CORPUS.some((c) => !c.undetermined)).toBe(true);
  });

  test("every prefix in the list is exercised by at least one corpus row", () => {
    // Guards the inverse drift: a prefix added without a corpus row is a rule
    // nothing checks, which is how `provider-unconfigured` survived review.
    const unexercised = COULD_NOT_CHECK_SUPPRESSION_PREFIXES.filter(
      (prefix) => !OBSERVED_CORPUS.some((c) => c.reason.startsWith(prefix))
    );
    expect(unexercised).toEqual([]);
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
