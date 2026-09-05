// Tests for calibration-review-cadence-detector.ts (mt#2619)
//
// Exercises the pure logic (computeReviewDueLogs, shouldReWarn,
// formatCadenceWarning) with in-memory fixtures — no filesystem I/O per
// `custom/no-real-fs-in-tests`.
//
// ONE exception, at the bottom of the file (mt#4748 R1): a real-fs
// write/read-parity block, scoped with its own eslint-disable. Every test
// above proves the PURE logic; none of them proves `run()`'s actual
// `readContent` closure agrees with the actual production writer
// (`logCalibrationRecord`) about WHERE a log lives — which is exactly the
// property that broke silently (this file's two `readContent` closures kept
// reading the pre-mt#4748 location after the writer moved) while every test
// in this file's ~1000-line suite, none of which touches real fs, stayed
// green.

import { describe, expect, test } from "bun:test";
import type {
  CalibrationLogEntry,
  CalibrationLogResult,
  ReviewDueLog,
} from "../../src/domain/calibration/calibration-sweep";
import {
  assessClassifiability,
  computeReviewDueLogs,
  FIRES_THRESHOLD,
  STALE_DAYS_MS,
} from "../../src/domain/calibration/calibration-sweep";
import {
  buildPendingAskRecord,
  formatCadenceWarning,
  formatPendingAskLines,
  parseAskStateCache,
  resolveAskStates,
  run,
  selectPendingAskLogs,
  shouldReWarn,
  ASK_STATE_STALENESS_MS,
  COOLDOWN_MS,
  type AskStateCacheRead,
  type LastWarnedRecord,
  type LastWarnedStore,
  type AskLookup,
} from "./calibration-review-cadence-detector";
import { GUARD_REGISTRY } from "./registry";
import { logCalibrationRecord } from "./dispatcher";
import { resolveCalibrationStatePath as cadenceResolveStatePath } from "./calibration-review-cadence-detector";
import { stubContext } from "./test-support/dispatcher-harness";
import type { ClaudeHookInput } from "./types";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const NOW = Date.parse("2026-07-06T00:00:00Z");
const NOW_ISO = new Date(NOW).toISOString();

// Shared string constants (extracted to satisfy no-magic-string-duplication).
const ASK_ROUTING_DEFERRAL = "ask-routing-deferral";
const ASK_ROUTING_DEFERRAL_PATH = ".minsky/ask-routing-deferral-calibration.jsonl";
const RETROSPECTIVE_TRIGGER = "retrospective-trigger";
const POLICY_COVERAGE = "policy-coverage";
const POLICY_COVERAGE_PATH = ".minsky/policy-coverage-calibration.jsonl";
const TEST_ASK_ID = "483dbcb0-788a-4159-9d8a-ba718ba1f2b0";
const TEST_NOT_A_DATE = "not-a-date";
/** `checkedAt` for ask-state snapshot fixtures (mt#3744); equals NOW so they read as fresh. */
const CHECKED_AT_FIXTURE = "2026-07-06T00:00:00.000Z";
const TEST_SESSION_A = "session-aaaa";
const TEST_SESSION_B = "session-bbbb";

function makeEntry(
  name: string,
  kind: CalibrationLogEntry["kind"] = "causal-premise"
): CalibrationLogEntry {
  return { path: `.minsky/${name}-calibration.jsonl`, name, kind };
}

function makeResult(
  entry: CalibrationLogEntry,
  overrides: Partial<CalibrationLogResult> = {}
): CalibrationLogResult {
  const merged = {
    entry,
    exists: true,
    totalFires: 0,
    firesSinceLastReview: 0,
    suppressedSinceLastReview: 0,
    injectedFiresSinceLastReview: 0,
    evaluatedOnlySinceLastReview: 0,
    distinctPhrases: 0,
    atCountThreshold: false,
    lowDiversity: false,
    pastThreshold: false,
    newRecords: [],
    watermarkCount: 0,
    // Required on CalibrationLogResult, so the fixture must supply it or the
    // spread of a Partial widens it to `| undefined` (mt#2900). Derived with the
    // production function rather than hardcoded, so a fixture that DOES pass
    // `newRecords` gets the verdict runSweep would have computed for them.
    classifiability: assessClassifiability(overrides.newRecords ?? []),
    ...overrides,
  };
  return {
    ...merged,
    // mt#3197: unless a test says otherwise, every fire is INJECTED — which is
    // the real-world default for every detector that records no suppression
    // outcome. Derived rather than defaulted to 0 so existing fixtures that
    // only set `firesSinceLastReview` keep meaning what they meant.
    injectedFiresSinceLastReview:
      overrides.injectedFiresSinceLastReview ??
      merged.firesSinceLastReview - merged.suppressedSinceLastReview,
    // mt#4904: DERIVED from the same comparison production uses, not defaulted
    // to false. A fixture that sets a watermark above its record count IS
    // stranded, and hardcoding false here would let such a fixture assert a
    // review-due reason the real sweep would never produce for it.
    watermarkStranded: overrides.watermarkStranded ?? merged.watermarkCount > merged.totalFires,
    // mt#4049: DERIVED, for the same reason the two above are — a fixture whose
    // records were all suppressed at volume IS all-suppressed, and hardcoding
    // false would let it assert an exclusion the real sweep no longer produces.
    // Derived from the same two columns production reads, in the same order.
    allSuppressed:
      overrides.allSuppressed ??
      ((overrides.injectedFiresSinceLastReview ??
        merged.firesSinceLastReview - merged.suppressedSinceLastReview) === 0 &&
        merged.suppressedSinceLastReview >= FIRES_THRESHOLD),
    // mt#4970: defaults to 0 — a fixture that names no log-only family has none.
    logOnlyFamilySinceLastReview: overrides.logOnlyFamilySinceLastReview ?? 0,
    // mt#4970: DERIVED, same reasoning as the three above. With the 0 default it
    // reduces to `allSuppressed` for every existing fixture, so no prior case
    // changes behavior.
    allWithheld:
      overrides.allWithheld ??
      ((overrides.injectedFiresSinceLastReview ??
        merged.firesSinceLastReview - merged.suppressedSinceLastReview) === 0 &&
        merged.suppressedSinceLastReview + (overrides.logOnlyFamilySinceLastReview ?? 0) >=
          FIRES_THRESHOLD),
  };
}

// ---------------------------------------------------------------------------
// computeReviewDueLogs
// ---------------------------------------------------------------------------

describe("computeReviewDueLogs", () => {
  test("flags a pastThreshold log regardless of watermark state", () => {
    const entry = makeEntry(ASK_ROUTING_DEFERRAL);
    const results = [
      makeResult(entry, {
        pastThreshold: true,
        firesSinceLastReview: 43,
        totalFires: 43,
        distinctPhrases: 31,
      }),
    ];
    const due = computeReviewDueLogs(results, {}, NOW);
    expect(due).toHaveLength(1);
    expect(due[0]?.reason).toBe("past-threshold");
    expect(due[0]?.name).toBe(ASK_ROUTING_DEFERRAL);
  });

  test("does not flag a log with 0 fires and no watermark", () => {
    const entry = makeEntry("causal-premise");
    const results = [makeResult(entry)];
    const due = computeReviewDueLogs(results, {}, NOW);
    expect(due).toHaveLength(0);
  });

  test("does not flag a below-threshold log with a FRESH watermark", () => {
    const entry = makeEntry(RETROSPECTIVE_TRIGGER);
    const results = [makeResult(entry, { firesSinceLastReview: 8, totalFires: 20 })];
    const watermarks = {
      [entry.path]: {
        lastReviewedCount: 12,
        lastReviewedAt: new Date(NOW - 2 * 24 * 60 * 60 * 1000).toISOString(),
      },
    };
    const due = computeReviewDueLogs(results, watermarks, NOW);
    expect(due).toHaveLength(0);
  });

  test("flags a below-threshold log whose watermark is >= STALE_DAYS_MS old (the retrospective-trigger gap)", () => {
    const entry = makeEntry(RETROSPECTIVE_TRIGGER);
    const results = [
      makeResult(entry, { firesSinceLastReview: 8, totalFires: 20, distinctPhrases: 3 }),
    ];
    const watermarks = {
      [entry.path]: {
        lastReviewedCount: 12,
        lastReviewedAt: new Date(NOW - (STALE_DAYS_MS + 24 * 60 * 60 * 1000)).toISOString(),
      },
    };
    const due = computeReviewDueLogs(results, watermarks, NOW);
    expect(due).toHaveLength(1);
    expect(due[0]?.reason).toBe("time-stale");
  });

  test("does not flag a time-stale watermark with zero new fires since review", () => {
    const entry = makeEntry("causal-premise");
    const results = [makeResult(entry, { firesSinceLastReview: 0, totalFires: 12 })];
    const watermarks = {
      [entry.path]: {
        lastReviewedCount: 12,
        lastReviewedAt: new Date(NOW - (STALE_DAYS_MS + 24 * 60 * 60 * 1000)).toISOString(),
      },
    };
    const due = computeReviewDueLogs(results, watermarks, NOW);
    expect(due).toHaveLength(0);
  });

  test("ignores a malformed lastReviewedAt rather than crashing", () => {
    const entry = makeEntry("causal-premise");
    const results = [makeResult(entry, { firesSinceLastReview: 5, totalFires: 5 })];
    const watermarks = { [entry.path]: { lastReviewedCount: 0, lastReviewedAt: TEST_NOT_A_DATE } };
    const due = computeReviewDueLogs(results, watermarks, NOW);
    expect(due).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// shouldReWarn
// ---------------------------------------------------------------------------

describe("shouldReWarn", () => {
  const due: ReviewDueLog = {
    name: ASK_ROUTING_DEFERRAL,
    path: ASK_ROUTING_DEFERRAL_PATH,
    kind: ASK_ROUTING_DEFERRAL,
    firesSinceLastReview: 43,
    injectedFiresSinceLastReview: 43,
    suppressedSinceLastReview: 0,
    logOnlyFamilySinceLastReview: 0,
    totalFires: 43,
    distinctPhrases: 31,
    reason: "past-threshold",
    watermarkCount: 0,
  };

  test("warns when never warned before", () => {
    expect(shouldReWarn(due, {}, NOW)).toBe(true);
  });

  test("does not re-warn within the cooldown when fire count is unchanged", () => {
    const lastWarned: LastWarnedStore = {
      [due.path]: { lastWarnedAt: new Date(NOW - 60_000).toISOString(), lastWarnedFireCount: 43 },
    };
    expect(shouldReWarn(due, lastWarned, NOW)).toBe(false);
  });

  test("re-warns when the fire count has grown since last warned", () => {
    const lastWarned: LastWarnedStore = {
      [due.path]: { lastWarnedAt: new Date(NOW - 60_000).toISOString(), lastWarnedFireCount: 30 },
    };
    expect(shouldReWarn(due, lastWarned, NOW)).toBe(true);
  });

  test("re-warns once the cooldown has elapsed even with an unchanged fire count", () => {
    const lastWarned: LastWarnedStore = {
      [due.path]: {
        lastWarnedAt: new Date(NOW - (COOLDOWN_MS + 60_000)).toISOString(),
        lastWarnedFireCount: 43,
      },
    };
    expect(shouldReWarn(due, lastWarned, NOW)).toBe(true);
  });

  test("re-warns on a malformed lastWarnedAt rather than staying silent forever", () => {
    const lastWarned: LastWarnedStore = {
      [due.path]: { lastWarnedAt: TEST_NOT_A_DATE, lastWarnedFireCount: 43 },
    };
    expect(shouldReWarn(due, lastWarned, NOW)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// shouldReWarn — policy-coverage kind (mt#2659, per-tool-call-volume logs)
// ---------------------------------------------------------------------------

describe("shouldReWarn — policy-coverage kind (mt#2659)", () => {
  const due: ReviewDueLog = {
    name: POLICY_COVERAGE,
    path: POLICY_COVERAGE_PATH,
    kind: POLICY_COVERAGE,
    firesSinceLastReview: 1457,
    injectedFiresSinceLastReview: 1457,
    suppressedSinceLastReview: 0,
    logOnlyFamilySinceLastReview: 0,
    totalFires: 1457,
    distinctPhrases: 5,
    reason: "past-threshold",
    watermarkCount: 0,
  };

  test("warns when never warned before", () => {
    expect(shouldReWarn(due, {}, NOW)).toBe(true);
  });

  test("does NOT re-warn on fire-count growth alone within the cooldown (the bug this fixes)", () => {
    // Fires grew from 1000 -> 1457 (a single active session's own tool calls)
    // but the cooldown window hasn't elapsed — for policy-coverage this must
    // NOT re-trigger, unlike an ordinary detector-log kind.
    const lastWarned: LastWarnedStore = {
      [due.path]: { lastWarnedAt: new Date(NOW - 60_000).toISOString(), lastWarnedFireCount: 1000 },
    };
    expect(shouldReWarn(due, lastWarned, NOW)).toBe(false);
  });

  test("re-warns once the cooldown has elapsed, regardless of fire-count growth", () => {
    const lastWarned: LastWarnedStore = {
      [due.path]: {
        lastWarnedAt: new Date(NOW - (COOLDOWN_MS + 60_000)).toISOString(),
        lastWarnedFireCount: 1000,
      },
    };
    expect(shouldReWarn(due, lastWarned, NOW)).toBe(true);
  });

  test("re-warns on a malformed lastWarnedAt rather than staying silent forever", () => {
    const lastWarned: LastWarnedStore = {
      [due.path]: { lastWarnedAt: TEST_NOT_A_DATE, lastWarnedFireCount: 1457 },
    };
    expect(shouldReWarn(due, lastWarned, NOW)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// formatCadenceWarning
// ---------------------------------------------------------------------------

describe("suppression-aware review-due legs (mt#3197, PR #2300 R1)", () => {
  const ALL_SUPPRESSED = { firesSinceLastReview: 12, suppressedSinceLastReview: 12 };
  /** Comfortably older than both the stale window and the never-reviewed window. */
  const LONG_AGO = new Date(NOW - (STALE_DAYS_MS + 30 * 24 * 60 * 60 * 1000)).toISOString();

  // mt#4049 amended this test's ASSERTION, not its subject. It pinned
  // "time-stale declines an all-suppressed log", and that is still true and
  // still what matters for mt#3197 — but such a log is no longer excluded
  // ENTIRELY, so `toHaveLength(0)` would now assert the routing gap mt#4049
  // closed rather than the count-inflation mt#3197 prevented. The reason check
  // is the stronger form of the original claim: the injected count did not
  // re-inflate, so the count-bearing leg still declines.
  test("time-stale does not fire when every new record was suppressed", () => {
    const entry = makeEntry(ASK_ROUTING_DEFERRAL);
    const results = [makeResult(entry, { ...ALL_SUPPRESSED, totalFires: 40 })];
    const watermarks = {
      [entry.path]: { lastReviewedCount: 28, lastReviewedAt: LONG_AGO },
    };
    const due = computeReviewDueLogs(results, watermarks, NOW);
    expect(due.map((d) => d.reason)).not.toContain("time-stale");
    expect(due[0]?.injectedFiresSinceLastReview).toBe(0);
  });

  test("time-stale still fires when at least one new record was injected", () => {
    const entry = makeEntry(ASK_ROUTING_DEFERRAL);
    const results = [
      makeResult(entry, {
        firesSinceLastReview: 12,
        suppressedSinceLastReview: 11,
        logOnlyFamilySinceLastReview: 0,
        totalFires: 40,
      }),
    ];
    const watermarks = {
      [entry.path]: { lastReviewedCount: 28, lastReviewedAt: LONG_AGO },
    };
    const due = computeReviewDueLogs(results, watermarks, NOW);
    expect(due).toHaveLength(1);
    expect(due[0]?.reason).toBe("time-stale");
    expect(due[0]?.injectedFiresSinceLastReview).toBe(1);
  });

  test("never-reviewed does not fire when every record was suppressed", () => {
    const entry = makeEntry(ASK_ROUTING_DEFERRAL);
    const results = [
      makeResult(entry, {
        ...ALL_SUPPRESSED,
        totalFires: 12,
        firstRecordTimestamp: LONG_AGO,
      }),
    ];
    const due = computeReviewDueLogs(results, {}, NOW);
    // Amended by mt#4049 for the same reason as the time-stale sibling above:
    // the count-bearing leg still declines, which is mt#3197's property; the
    // log is now routed by its own leg instead of vanishing.
    expect(due.map((d) => d.reason)).not.toContain("never-reviewed");
    expect(due[0]?.injectedFiresSinceLastReview).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// mt#4049 — the all-suppressed leg
// ---------------------------------------------------------------------------

/**
 * The time-stale leg's rendering, asserted by three tests that each check a
 * DIFFERENT leg does not inherit it — `watermark-stranded` (mt#4904) and
 * `all-suppressed` (mt#4049) both silently wore this wording at some point,
 * which is why the assertion is worth sharing rather than repeating.
 */
const TIME_STALE_WORDING = "unreviewed for >=";

describe("all-suppressed review-due leg (mt#4049)", () => {
  const LONG_AGO = new Date(NOW - (STALE_DAYS_MS + 30 * 24 * 60 * 60 * 1000)).toISOString();

  // AT1: N records, ALL suppressed, N above the count bar -> due, new reason.
  test("routes an all-suppressed log above the count bar", () => {
    const entry = makeEntry(ASK_ROUTING_DEFERRAL);
    const results = [
      makeResult(entry, {
        firesSinceLastReview: 12,
        suppressedSinceLastReview: 12,
        logOnlyFamilySinceLastReview: 0,
        totalFires: 12,
      }),
    ];

    const due = computeReviewDueLogs(results, {}, NOW);

    expect(due).toHaveLength(1);
    expect(due[0]?.reason).toBe("all-suppressed");
    expect(due[0]?.suppressedSinceLastReview).toBe(12);
    expect(due[0]?.injectedFiresSinceLastReview).toBe(0);
  });

  test("routes it whether or not it has ever been reviewed", () => {
    // The watermarked case: `never-reviewed` cannot reach a log with a
    // watermark, so without the leg's ungated placement this one would fall
    // through to `time-stale` and be declined there.
    const entry = makeEntry(ASK_ROUTING_DEFERRAL);
    const results = [
      makeResult(entry, {
        firesSinceLastReview: 12,
        suppressedSinceLastReview: 12,
        logOnlyFamilySinceLastReview: 0,
        totalFires: 40,
      }),
    ];
    const watermarks = {
      [entry.path]: { lastReviewedCount: 28, lastReviewedAt: LONG_AGO },
    };

    const due = computeReviewDueLogs(results, watermarks, NOW);

    expect(due).toHaveLength(1);
    expect(due[0]?.reason).toBe("all-suppressed");
  });

  // AT2 (negative control on mt#3197): the fix must not be bought by counting
  // suppressed records toward the threshold again. Same volume, one injected.
  test("does NOT fire when the log is only PARTIALLY suppressed", () => {
    const entry = makeEntry(ASK_ROUTING_DEFERRAL);
    const results = [
      makeResult(entry, {
        firesSinceLastReview: 12,
        suppressedSinceLastReview: 11,
        logOnlyFamilySinceLastReview: 0,
        totalFires: 12,
      }),
    ];

    const due = computeReviewDueLogs(results, {}, NOW);

    // One injected fire, below the count bar of 10 — the mt#3197 case, which
    // must stay exactly as quiet as it was.
    expect(due.map((d) => d.reason)).not.toContain("all-suppressed");
    expect(due).toHaveLength(0);
  });

  // AT3 (negative control on volume): an all-suppressed log BELOW the count bar
  // must not fire either, or every quiet detector becomes permanently due.
  test("does NOT fire on an all-suppressed log below the count bar", () => {
    const entry = makeEntry(ASK_ROUTING_DEFERRAL);
    const results = [
      makeResult(entry, {
        firesSinceLastReview: FIRES_THRESHOLD - 1,
        suppressedSinceLastReview: FIRES_THRESHOLD - 1,
        totalFires: FIRES_THRESHOLD - 1,
      }),
    ];

    const due = computeReviewDueLogs(results, {}, NOW);

    expect(due).toHaveLength(0);
  });

  test("fires exactly AT the count bar, not one above it", () => {
    // Pins the boundary so a later `>` / `>=` slip is caught: the suppressed
    // count uses the same bar the injected count would have had to clear.
    const entry = makeEntry(ASK_ROUTING_DEFERRAL);
    const atBar = [
      makeResult(entry, {
        firesSinceLastReview: FIRES_THRESHOLD,
        suppressedSinceLastReview: FIRES_THRESHOLD,
        totalFires: FIRES_THRESHOLD,
      }),
    ];

    expect(computeReviewDueLogs(atBar, {}, NOW)[0]?.reason).toBe("all-suppressed");
  });

  test("is not diversity-gated — one repeated shape still routes", () => {
    // Deliberate: the question is "is this gate too broad", which a single
    // repeated shape answers. A diversity gate here would reproduce mt#3789's
    // permanently-unreachable conjunct on a second axis.
    const entry = makeEntry(ASK_ROUTING_DEFERRAL);
    const results = [
      makeResult(entry, {
        firesSinceLastReview: 12,
        suppressedSinceLastReview: 12,
        logOnlyFamilySinceLastReview: 0,
        totalFires: 12,
        distinctPhrases: 1,
      }),
    ];

    expect(computeReviewDueLogs(results, {}, NOW)[0]?.reason).toBe("all-suppressed");
  });

  test("watermark-stranded still wins — it is checked first and invalidates these counts", () => {
    const entry = makeEntry(ASK_ROUTING_DEFERRAL);
    const results = [
      makeResult(entry, {
        firesSinceLastReview: 12,
        suppressedSinceLastReview: 12,
        logOnlyFamilySinceLastReview: 0,
        totalFires: 12,
        watermarkCount: 99,
      }),
    ];

    expect(computeReviewDueLogs(results, {}, NOW)[0]?.reason).toBe("watermark-stranded");
  });
});

describe("formatCadenceWarning — the all-suppressed line (mt#4049)", () => {
  test("asks whether the gate is too broad, and never reports '0 new fire(s)'", () => {
    const due: ReviewDueLog[] = [
      {
        name: "knowledge-acquisition",
        path: ".minsky/knowledge-acquisition-calibration.jsonl",
        kind: "knowledge-acquisition",
        firesSinceLastReview: 15,
        injectedFiresSinceLastReview: 0,
        suppressedSinceLastReview: 13,
        logOnlyFamilySinceLastReview: 0,
        totalFires: 15,
        distinctPhrases: 13,
        reason: "all-suppressed",
        watermarkCount: 0,
      },
    ];

    const warning = formatCadenceWarning(due);

    expect(warning).toContain("suppressed 13 of 15 detection(s)");
    expect(warning).toContain("Is this gate too broad?");
    // The failure mt#3197's deferral note predicted, and the reason this leg
    // needed its own text rather than another label on the shared ternary.
    expect(warning).not.toContain("0 new fire(s)");
    // And it must not inherit the time-stale wording, as watermark-stranded
    // silently did before mt#4904 caught it.
    expect(warning).not.toContain(TIME_STALE_WORDING);
  });
});

describe("formatCadenceWarning", () => {
  test("names each due log with its fire count and reason", () => {
    const due: ReviewDueLog[] = [
      {
        name: ASK_ROUTING_DEFERRAL,
        path: ASK_ROUTING_DEFERRAL_PATH,
        kind: ASK_ROUTING_DEFERRAL,
        firesSinceLastReview: 43,
        // mt#3197: no suppression outcome recorded -> every fire is injected.
        injectedFiresSinceLastReview: 43,
        suppressedSinceLastReview: 0,
        logOnlyFamilySinceLastReview: 0,
        totalFires: 43,
        distinctPhrases: 31,
        reason: "past-threshold",
        watermarkCount: 0,
      },
      {
        name: RETROSPECTIVE_TRIGGER,
        path: ".minsky/retrospective-trigger-calibration.jsonl",
        kind: "retrospective-trigger",
        firesSinceLastReview: 8,
        injectedFiresSinceLastReview: 8,
        suppressedSinceLastReview: 0,
        logOnlyFamilySinceLastReview: 0,
        totalFires: 20,
        distinctPhrases: 3,
        reason: "time-stale",
        watermarkCount: 0,
      },
    ];
    const msg = formatCadenceWarning(due);
    expect(msg).toContain(ASK_ROUTING_DEFERRAL);
    expect(msg).toContain("43 new fire(s)");
    expect(msg).toContain(RETROSPECTIVE_TRIGGER);
    expect(msg).toContain(TIME_STALE_WORDING);
    expect(msg).toContain("/calibration-review");
    // The override env var is deliberately NOT named here (mt#3479): advisory
    // text is read by the agent, and the override is the operator's escape
    // hatch, catalogued in `CLAUDE.md §Hook Files`. Asserted as an absence so a
    // re-added advertisement fails here as well as in guard-feedback-shape.
    expect(msg).not.toContain("MINSKY_SKIP_CALIBRATION_CADENCE");
  });

  test("names the watermark-stranded reason, and never the time-stale text (mt#4904)", () => {
    // PR #3572 R1. The leg had fallen into the reason ternary's final `else`,
    // so it rendered as "unreviewed for >= N days" — the time-stale wording,
    // about a log that is not stale but incomparable. The shared line's count
    // is equally wrong here: it quotes the injected count, which the stranding
    // clamps to 0, so the warning read "0 new fire(s)" on a log it was
    // simultaneously reporting as needing review.
    const due: ReviewDueLog[] = [
      {
        name: "untaken-action",
        path: ".minsky/untaken-action-calibration.jsonl",
        kind: "untaken-action",
        firesSinceLastReview: 0,
        injectedFiresSinceLastReview: 0,
        suppressedSinceLastReview: 0,
        logOnlyFamilySinceLastReview: 0,
        totalFires: 121,
        distinctPhrases: 0,
        reason: "watermark-stranded",
        watermarkCount: 424,
      },
    ];
    const msg = formatCadenceWarning(due);
    expect(msg).toContain("untaken-action");
    // Both operands, so the reader can see the comparison that failed.
    expect(msg).toContain("424");
    expect(msg).toContain("121");
    // The mislabel this test exists for.
    expect(msg).not.toContain(TIME_STALE_WORDING);
    // The fabricated zero — the clamp's output, presented as a measurement.
    expect(msg).not.toContain("0 new fire(s)");
    // The shared action line is asserted by the past-threshold/time-stale test
    // above; not repeated here, both because it is not this test's subject and
    // because a third literal trips custom/no-magic-string-duplication.
  });

  test("names the never-reviewed reason (mt#2896)", () => {
    const due: ReviewDueLog[] = [
      {
        name: "causal-premise",
        path: ".minsky/causal-premise-calibration.jsonl",
        kind: "causal-premise",
        firesSinceLastReview: 1,
        injectedFiresSinceLastReview: 1,
        suppressedSinceLastReview: 0,
        logOnlyFamilySinceLastReview: 0,
        totalFires: 1,
        distinctPhrases: 1,
        reason: "never-reviewed",
        watermarkCount: 0,
        reviewByDays: 7,
      },
    ];
    const msg = formatCadenceWarning(due);
    expect(msg).toContain("causal-premise");
    expect(msg).toContain("never reviewed");
    expect(msg).toContain("7 days ago");
  });

  // mt#3824: the guard used to render one line per due log with no cap, so its
  // size scaled 1:1 with how many calibration logs were review-due — a count
  // driven by real repo activity AND by wall-clock time alone (every
  // registered log ages toward "never-fired" as its `liveSinceDate +
  // reviewByDays` window closes, independent of any file content). These
  // tests are pure functions of a synthetic `due` array — no filesystem, no
  // watermark state, no wall clock — so they demonstrate the state-
  // independence claim in BOTH directions success criterion 2 asks for: a
  // small due set and a large one render through the identical code path and
  // must both stay under the declared ceiling.
  describe("size ceiling holds independent of due-log count (mt#3824)", () => {
    /** Longest registry name + longest reason clause — the true worst case. */
    const WORST_CASE_NAME = "constructed-identifier-batch";
    // `name` is free text (the callers below generate distinct ones to simulate
    // several registry entries); `kind` is a closed union, so the two cannot be
    // the same value — conflating them is what mt#2900 surfaced here.
    function worstCaseDue(name: string = WORST_CASE_NAME): ReviewDueLog {
      return {
        name,
        path: `.minsky/${name}-calibration.jsonl`,
        kind: WORST_CASE_NAME,
        firesSinceLastReview: 999,
        injectedFiresSinceLastReview: 999,
        suppressedSinceLastReview: 999,
        logOnlyFamilySinceLastReview: 0,
        totalFires: 9999,
        distinctPhrases: 999,
        reason: "never-fired",
        watermarkCount: 0,
        reviewByDays: 30,
      };
    }

    // Read from the registry itself (PR #2701 R1 BLOCKING) rather than a
    // duplicated literal: a hand-copied number drifts silently the next time
    // `denialMessageSizeChars` is re-tuned, which is exactly the failure mode
    // this task exists to fix on the OTHER side of this same file. Importing
    // `GUARD_REGISTRY` here is the same pattern `guard-feedback-shape.test.ts`
    // already uses — it is metadata-only at import time (no canary runs
    // unless explicitly invoked), so it does not compromise this file's
    // filesystem-free pure-logic tests.
    const DECLARED_CEILING = (() => {
      const reg = GUARD_REGISTRY.find((r) => r.name === "calibration-review-cadence-detector");
      const declared = reg?.attentionCost?.denialMessageSizeChars;
      if (declared === undefined) {
        throw new Error(
          "calibration-review-cadence-detector is missing an attentionCost.denialMessageSizeChars declaration in registry.ts"
        );
      }
      return declared;
    })();

    test("a single due log renders under the declared ceiling", () => {
      const msg = formatCadenceWarning([worstCaseDue()]);
      expect(msg.length).toBeLessThanOrEqual(DECLARED_CEILING);
    });

    test("many due logs (simulating several registry entries aging past their review-by window at once) still render under the declared ceiling", () => {
      const many = Array.from({ length: 8 }, (_, i) => worstCaseDue(`${WORST_CASE_NAME}-${i}`));
      const msg = formatCadenceWarning(many);
      expect(msg.length).toBeLessThanOrEqual(DECLARED_CEILING);
    });

    test("size stays bounded no matter how large the due set gets — 100 worst-case logs still fit under the declared ceiling", () => {
      // The real teeth: not merely \"still under budget\" for a moderate count,
      // but that the byte-budget fit (`formatCadenceWarning`'s greedy loop
      // against ADVISORY_BUDGET_CHARS) holds for an arbitrarily large due set.
      // A count-based cap needs its declared ceiling hand-verified against the
      // longest plausible name/reason; this design is self-enforcing instead —
      // it recomputes the fit against the actual rendered length every time,
      // so it cannot silently drift the way the count-based predecessor of
      // this test once did (PR #2701 R2).
      const many = Array.from({ length: 100 }, (_, i) => worstCaseDue(`${WORST_CASE_NAME}-${i}`));
      const msg = formatCadenceWarning(many);
      expect(msg.length).toBeLessThanOrEqual(DECLARED_CEILING);
    });

    test("beyond what fits, the overflow collapses to an accurate count rather than growing without bound", () => {
      const many = Array.from({ length: 5 }, (_, i) => worstCaseDue(`${WORST_CASE_NAME}-${i}`));
      const msg = formatCadenceWarning(many);
      const listedCount = (msg.match(/^ {2}- /gm) ?? []).length;
      // Fewer than the full set was listed — the budget is doing real work,
      // not just passing through everything.
      expect(listedCount).toBeGreaterThan(0);
      expect(listedCount).toBeLessThan(many.length);
      // And the omitted-count line's number matches what was actually left out.
      const omitted = many.length - listedCount;
      expect(msg).toContain(`…and ${omitted} more review-due log(s)`);
    });
  });
});

// ---------------------------------------------------------------------------
// computeReviewDueLogs — openAskId forwarding (mt#2659)
// ---------------------------------------------------------------------------

describe("computeReviewDueLogs — openAskId forwarding (mt#2659)", () => {
  test("forwards openAskId from the watermark on a past-threshold log", () => {
    const entry = makeEntry(POLICY_COVERAGE, POLICY_COVERAGE);
    const results = [
      makeResult(entry, { pastThreshold: true, firesSinceLastReview: 20, totalFires: 1457 }),
    ];
    const watermarks = {
      [entry.path]: {
        lastReviewedCount: 1437,
        lastReviewedAt: NOW_ISO,
        openAskId: TEST_ASK_ID,
      },
    };
    const due = computeReviewDueLogs(results, watermarks, NOW);
    expect(due).toHaveLength(1);
    expect(due[0]?.openAskId).toBe(TEST_ASK_ID);
    expect(due[0]?.kind).toBe(POLICY_COVERAGE);
  });

  test("forwards openAskId from the watermark on a time-stale log", () => {
    const entry = makeEntry(RETROSPECTIVE_TRIGGER);
    const results = [
      makeResult(entry, { firesSinceLastReview: 8, totalFires: 20, distinctPhrases: 3 }),
    ];
    const watermarks = {
      [entry.path]: {
        lastReviewedCount: 12,
        lastReviewedAt: new Date(NOW - (STALE_DAYS_MS + 24 * 60 * 60 * 1000)).toISOString(),
        openAskId: TEST_ASK_ID,
      },
    };
    const due = computeReviewDueLogs(results, watermarks, NOW);
    expect(due).toHaveLength(1);
    expect(due[0]?.openAskId).toBe(TEST_ASK_ID);
  });

  test("openAskId is undefined when the watermark carries none", () => {
    const entry = makeEntry(ASK_ROUTING_DEFERRAL);
    const results = [
      makeResult(entry, { pastThreshold: true, firesSinceLastReview: 43, totalFires: 43 }),
    ];
    const due = computeReviewDueLogs(results, {}, NOW);
    expect(due[0]?.openAskId).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// selectPendingAskLogs (mt#2659)
// ---------------------------------------------------------------------------

describe("selectPendingAskLogs", () => {
  const pendingDue: ReviewDueLog = {
    name: POLICY_COVERAGE,
    path: POLICY_COVERAGE_PATH,
    kind: POLICY_COVERAGE,
    firesSinceLastReview: 20,
    injectedFiresSinceLastReview: 20,
    suppressedSinceLastReview: 0,
    logOnlyFamilySinceLastReview: 0,
    totalFires: 1477,
    distinctPhrases: 5,
    reason: "past-threshold",
    watermarkCount: 0,
    openAskId: TEST_ASK_ID,
  };
  const noAskDue: ReviewDueLog = {
    ...pendingDue,
    name: ASK_ROUTING_DEFERRAL,
    path: ASK_ROUTING_DEFERRAL_PATH,
    openAskId: undefined,
  };

  test("selects a log with openAskId that hasn't been shown this session", () => {
    const result = selectPendingAskLogs([pendingDue], {}, TEST_SESSION_A);
    expect(result).toHaveLength(1);
  });

  test("excludes a log without openAskId even if otherwise due", () => {
    const result = selectPendingAskLogs([noAskDue], {}, TEST_SESSION_A);
    expect(result).toHaveLength(0);
  });

  test("suppresses a log already shown the pending line THIS session (no per-turn warning)", () => {
    const lastWarned: LastWarnedStore = {
      [pendingDue.path]: {
        lastWarnedAt: NOW_ISO,
        lastWarnedFireCount: 1457,
        pendingAskWarnedSessionId: TEST_SESSION_A,
      },
    };
    const result = selectPendingAskLogs([pendingDue], lastWarned, TEST_SESSION_A);
    expect(result).toHaveLength(0);
  });

  test("shows the pending line again in a NEW session even if fires grew", () => {
    const lastWarned: LastWarnedStore = {
      [pendingDue.path]: {
        lastWarnedAt: NOW_ISO,
        lastWarnedFireCount: 1000, // fires grew since — irrelevant while ask is open
        pendingAskWarnedSessionId: TEST_SESSION_A,
      },
    };
    const result = selectPendingAskLogs([pendingDue], lastWarned, TEST_SESSION_B);
    expect(result).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// formatPendingAskLines (mt#2659)
// ---------------------------------------------------------------------------

describe("formatPendingAskLines", () => {
  const pendingLog = (askId: string = TEST_ASK_ID): ReviewDueLog => ({
    name: POLICY_COVERAGE,
    path: POLICY_COVERAGE_PATH,
    kind: POLICY_COVERAGE,
    firesSinceLastReview: 20,
    injectedFiresSinceLastReview: 20,
    suppressedSinceLastReview: 0,
    logOnlyFamilySinceLastReview: 0,
    totalFires: 1477,
    distinctPhrases: 5,
    reason: "past-threshold",
    watermarkCount: 0,
    openAskId: askId,
  });

  const lookups = (lookup: AskLookup, askId: string = TEST_ASK_ID): Map<string, AskLookup> =>
    new Map([[askId, lookup]]);

  // Extracted so a wording change can never leave an assertion silently checking prose the
  // formatter no longer emits.
  const AWAITING = "awaiting operator response";
  const NO_ACTION_NEEDED = "no action needed";
  const NEEDS_DISPOSITION = "still needs a disposition";
  const UNKNOWN_STATE = "disposition state unknown";
  // mt#3744 retired "ask store unreachable": the hook no longer reaches a store, so the only
  // honest remaining `unavailable` is a snapshot that exists and cannot be parsed.
  const SNAPSHOT_UNREADABLE = "snapshot could not be read";

  test("an OPEN ask still renders the pending line, without demanding action", () => {
    // mt#3270: the fixture states the ask state LITERALLY. Binding this to a live ask id
    // is what made the original spec's example go stale within a day of being written.
    const msg = formatPendingAskLines(
      [pendingLog()],
      lookups({ kind: "open", state: "suspended", shortId: "ask#6136" })
    );
    expect(msg).toContain(POLICY_COVERAGE);
    expect(msg).toContain("disposition pending");
    expect(msg).toContain(AWAITING);
    expect(msg).toContain(NO_ACTION_NEEDED);
    expect(msg).not.toContain("/calibration-review");
  });

  test("a CLOSED, answered ask does NOT claim the operator owes a response", () => {
    // The 109807e1 incident: closed+responded 2026-07-23, still reported as pending a day
    // later, and the principal tried to action an ask that could no longer be opened.
    const msg = formatPendingAskLines(
      [pendingLog()],
      lookups({ kind: "settled", state: "closed", shortId: "ask#5425" })
    );
    expect(msg).not.toContain(AWAITING);
    expect(msg).not.toContain(NO_ACTION_NEEDED);
    expect(msg).toContain("is closed");
    expect(msg).toContain(NEEDS_DISPOSITION);
  });

  test("an unresolvable ask renders a neutral line rather than asserting operator state", () => {
    const msg = formatPendingAskLines([pendingLog()], lookups({ kind: "not-found" }));
    expect(msg).not.toContain(AWAITING);
    expect(msg).toContain("could not be found");
    expect(msg).toContain(UNKNOWN_STATE);
  });

  test("an UNREADABLE snapshot is distinguishable from a not-found ask", () => {
    // Without this distinction a dead lookup renders exactly like a healthy one that found
    // nothing — the mt#3019 / mt#3046 shape, and the same shape as this detector's own bug.
    const notFound = formatPendingAskLines([pendingLog()], lookups({ kind: "not-found" }));
    const unreadable = formatPendingAskLines(
      [pendingLog()],
      lookups({ kind: "unavailable", reason: "unexpected token in JSON" })
    );
    expect(unreadable).not.toBe(notFound);
    expect(unreadable).toContain(SNAPSHOT_UNREADABLE);
    expect(unreadable).toContain("unexpected token in JSON");
    expect(unreadable).not.toContain(AWAITING);
  });

  test("a missing lookup never silently reads as an open ask", () => {
    const msg = formatPendingAskLines([pendingLog()], new Map());
    expect(msg).not.toContain(AWAITING);
    expect(msg).toContain(SNAPSHOT_UNREADABLE);
  });

  // mt#3744 — the four snapshot-fault branches. Each names a DIFFERENT thing to fix, so the
  // load-bearing assertion in each is that its line is distinguishable from the others'.
  test("a STALE snapshot names its age and asserts no disposition state", () => {
    const msg = formatPendingAskLines(
      [pendingLog()],
      lookups({ kind: "stale", checkedAt: "2026-08-11T09:00:00.000Z", ageMs: 90 * 60 * 1000 })
    );
    expect(msg).not.toContain(AWAITING);
    expect(msg).not.toContain(NO_ACTION_NEEDED);
    expect(msg).toContain("snapshot is 1h old");
    expect(msg).toContain("2026-08-11T09:00:00.000Z");
    expect(msg).toContain("no disposition state is asserted");
  });

  test("an ABSENT snapshot says no snapshot exists — not that a lookup failed", () => {
    const msg = formatPendingAskLines([pendingLog()], lookups({ kind: "absent" }));
    expect(msg).not.toContain(AWAITING);
    expect(msg).toContain("no ask-state snapshot exists");
    expect(msg).toContain(UNKNOWN_STATE);
    // The distinction SC3 asks for: never read as a failed read.
    expect(msg).not.toContain(SNAPSHOT_UNREADABLE);
  });

  test("an id the producer never asked about is distinct from an absent snapshot", () => {
    const notInSnapshot = formatPendingAskLines(
      [pendingLog()],
      lookups({
        kind: "not-in-snapshot",
        checkedAt: "2026-08-11T12:00:00.000Z",
        ageMs: 4 * 60 * 1000,
      })
    );
    const absent = formatPendingAskLines([pendingLog()], lookups({ kind: "absent" }));
    expect(notInSnapshot).not.toBe(absent);
    expect(notInSnapshot).toContain("not covered by the current");
    expect(notInSnapshot).toContain("4m old");
    expect(notInSnapshot).not.toContain(AWAITING);
  });

  test("all four snapshot-fault renderings are mutually distinguishable", () => {
    // A regression guard on the SC4 requirement itself: collapsing any two of these back into
    // one message is the defect this task exists to remove, and a per-branch test would not
    // catch two branches that quietly converge on the same wording.
    const rendered = [
      lookups({ kind: "absent" }),
      lookups({ kind: "unavailable", reason: "bad json" }),
      lookups({ kind: "stale", checkedAt: "2026-08-11T09:00:00.000Z", ageMs: 3600000 }),
      lookups({ kind: "not-in-snapshot", checkedAt: "2026-08-11T12:00:00.000Z", ageMs: 60000 }),
    ].map((l) => formatPendingAskLines([pendingLog()], l));
    expect(new Set(rendered).size).toBe(rendered.length);
  });

  test("the ask id renders as a clickable minsky://ask deeplink", () => {
    const msg = formatPendingAskLines(
      [pendingLog()],
      lookups({ kind: "open", state: "routed", shortId: "ask#6136" })
    );
    expect(msg).toContain(`[ask#6136](minsky://ask/${TEST_ASK_ID})`);
  });

  test("the header drops 'no action needed' when any referenced ask is settled", () => {
    const other = "9f1d2c33-0000-4000-8000-abcdefabcdef";
    const msg = formatPendingAskLines(
      [pendingLog(), { ...pendingLog(other), name: ASK_ROUTING_DEFERRAL }],
      new Map<string, AskLookup>([
        [TEST_ASK_ID, { kind: "open", state: "suspended" }],
        [other, { kind: "settled", state: "closed" }],
      ])
    );
    expect(msg).not.toContain(NO_ACTION_NEEDED);
    expect(msg).toContain("Calibration disposition status");
    expect(msg).toContain(AWAITING);
    expect(msg).toContain(NEEDS_DISPOSITION);
  });
});

// ---------------------------------------------------------------------------
// buildPendingAskRecord (mt#2659 review fix, non-blocking b)
// ---------------------------------------------------------------------------

describe("buildPendingAskRecord", () => {
  test("preserves the PRIOR lastWarnedFireCount rather than bumping to the current total", () => {
    const priorRecord: LastWarnedRecord = {
      lastWarnedAt: new Date(NOW - 5 * 24 * 60 * 60 * 1000).toISOString(),
      lastWarnedFireCount: 1000,
    };
    const record = buildPendingAskRecord(priorRecord, TEST_SESSION_A, NOW_ISO);
    expect(record.lastWarnedFireCount).toBe(1000);
    expect(record.lastWarnedAt).toBe(NOW_ISO);
    expect(record.pendingAskWarnedSessionId).toBe(TEST_SESSION_A);
  });

  test("defaults lastWarnedFireCount to 0 when the log has never been warned about before", () => {
    const record = buildPendingAskRecord(undefined, TEST_SESSION_A, NOW_ISO);
    expect(record.lastWarnedFireCount).toBe(0);
  });

  test("stamps the given session id, enabling the once-per-session gate", () => {
    const record = buildPendingAskRecord(undefined, TEST_SESSION_B, NOW_ISO);
    expect(record.pendingAskWarnedSessionId).toBe(TEST_SESSION_B);
  });
});

// ---------------------------------------------------------------------------
// Acceptance scenario (mt#2659 spec): watermark with openAskId + growing
// fire count -> no per-turn warning, one pending-line per session; ask
// closed -> normal cadence behavior resumes.
// ---------------------------------------------------------------------------

describe("acceptance: ask-aware suppression end-to-end (mt#2659)", () => {
  test("while openAskId is set: first turn shows the pending line once, second turn (same session) is silent", () => {
    const entry = makeEntry(POLICY_COVERAGE, POLICY_COVERAGE);
    const watermarks = {
      [entry.path]: { lastReviewedCount: 0, lastReviewedAt: NOW_ISO, openAskId: TEST_ASK_ID },
    };

    // Turn 1: fires have grown past threshold while the ask is still open.
    const resultsTurn1 = [
      makeResult(entry, { pastThreshold: true, firesSinceLastReview: 20, totalFires: 1457 }),
    ];
    const dueTurn1 = computeReviewDueLogs(resultsTurn1, watermarks, NOW);
    const pendingTurn1 = selectPendingAskLogs(dueTurn1, {}, TEST_SESSION_A);
    expect(pendingTurn1).toHaveLength(1);

    // Simulate the hook persisting pendingAskWarnedSessionId after showing it.
    const lastWarnedAfterTurn1: LastWarnedStore = {
      [entry.path]: {
        lastWarnedAt: NOW_ISO,
        lastWarnedFireCount: 1457,
        pendingAskWarnedSessionId: TEST_SESSION_A,
      },
    };

    // Turn 2: same session, fires grew even further — still fully suppressed
    // (no per-turn warning), because the ask is still open and already shown.
    const resultsTurn2 = [
      makeResult(entry, { pastThreshold: true, firesSinceLastReview: 40, totalFires: 1497 }),
    ];
    const dueTurn2 = computeReviewDueLogs(resultsTurn2, watermarks, NOW);
    const pendingTurn2 = selectPendingAskLogs(dueTurn2, lastWarnedAfterTurn1, TEST_SESSION_A);
    expect(pendingTurn2).toHaveLength(0);

    // The normal (non-pending) path must never see this log while openAskId
    // is set — main() routes it to selectPendingAskLogs, not shouldReWarn.
    expect(dueTurn2[0]?.openAskId).toBe(TEST_ASK_ID);
  });

  test("once the ask is closed (openAskId cleared): normal cadence behavior resumes", () => {
    const entry = makeEntry(POLICY_COVERAGE, POLICY_COVERAGE);
    // openAskId cleared — simulates clearResolvedAskIds() having run.
    const watermarks = {
      [entry.path]: { lastReviewedCount: 0, lastReviewedAt: NOW_ISO },
    };
    const results = [
      makeResult(entry, { pastThreshold: true, firesSinceLastReview: 40, totalFires: 1497 }),
    ];
    const due = computeReviewDueLogs(results, watermarks, NOW);
    expect(due[0]?.openAskId).toBeUndefined();

    // No longer routed through selectPendingAskLogs...
    const pending = selectPendingAskLogs(due, {}, TEST_SESSION_A);
    expect(pending).toHaveLength(0);

    // ...instead normal shouldReWarn cadence applies (policy-coverage kind:
    // time-only re-warn, so a never-warned log still warns).
    expect(shouldReWarn(due[0] as ReviewDueLog, {}, NOW)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// resolveAskStates — the cached-snapshot consumer (mt#3744)
// ---------------------------------------------------------------------------

describe("resolveAskStates (mt#3744)", () => {
  const OTHER_ASK_ID = "9f1d2c33-0000-4000-8000-abcdefabcdef";

  const okRead = (
    asks: Record<string, { found: true; state: string; open: boolean } | { found: false }>,
    checkedAt: string = CHECKED_AT_FIXTURE
  ): AskStateCacheRead => ({ kind: "ok", record: { checkedAt, asks } });

  test("FRESH: an open ask resolves to `open`, carrying the producer's state", () => {
    const out = resolveAskStates(
      okRead({ [TEST_ASK_ID]: { found: true, state: "suspended", open: true } }),
      [TEST_ASK_ID],
      NOW
    );
    expect(out.get(TEST_ASK_ID)).toEqual({ kind: "open", state: "suspended" });
  });

  test("FRESH: a settled ask resolves to `settled` — never to unavailable", () => {
    // The mt#3270 regression in its post-mt#3744 form: this is the case the whole mechanism
    // exists to deliver, and the one that read "ask store unreachable" for weeks.
    const out = resolveAskStates(
      okRead({ [TEST_ASK_ID]: { found: true, state: "closed", open: false } }),
      [TEST_ASK_ID],
      NOW
    );
    expect(out.get(TEST_ASK_ID)).toEqual({ kind: "settled", state: "closed" });
  });

  test("`open` is read from the snapshot, not recomputed from the state string", () => {
    // The producer owns OPEN_ASK_STATES. If the consumer re-derived it, the two would drift
    // silently the first time a state is added — so an entry whose `open` disagrees with what
    // the consumer would have guessed must still follow the record.
    const out = resolveAskStates(
      okRead({ [TEST_ASK_ID]: { found: true, state: "suspended", open: false } }),
      [TEST_ASK_ID],
      NOW
    );
    expect(out.get(TEST_ASK_ID)?.kind).toBe("settled");
  });

  test("FRESH: an id the producer looked up and did not find resolves to `not-found`", () => {
    const out = resolveAskStates(okRead({ [TEST_ASK_ID]: { found: false } }), [TEST_ASK_ID], NOW);
    expect(out.get(TEST_ASK_ID)).toEqual({ kind: "not-found" });
  });

  test("STALE: a snapshot past the threshold asserts no state for ANY id", () => {
    const staleAt = new Date(NOW - ASK_STATE_STALENESS_MS - 60_000).toISOString();
    const out = resolveAskStates(
      okRead({ [TEST_ASK_ID]: { found: true, state: "suspended", open: true } }, staleAt),
      [TEST_ASK_ID],
      NOW
    );
    const lookup = out.get(TEST_ASK_ID);
    expect(lookup?.kind).toBe("stale");
    // Load-bearing: a stale snapshot that still said "open" would be the exact defect
    // mt#3270 fixed, re-introduced through the cache.
    expect(lookup?.kind).not.toBe("open");
  });

  test("a snapshot just INSIDE the threshold is still fresh", () => {
    const freshAt = new Date(NOW - ASK_STATE_STALENESS_MS + 60_000).toISOString();
    const out = resolveAskStates(
      okRead({ [TEST_ASK_ID]: { found: true, state: "suspended", open: true } }, freshAt),
      [TEST_ASK_ID],
      NOW
    );
    expect(out.get(TEST_ASK_ID)?.kind).toBe("open");
  });

  test("an unparseable checkedAt is treated as infinitely old, never as fresh", () => {
    const out = resolveAskStates(
      okRead({ [TEST_ASK_ID]: { found: true, state: "suspended", open: true } }, TEST_NOT_A_DATE),
      [TEST_ASK_ID],
      NOW
    );
    expect(out.get(TEST_ASK_ID)?.kind).toBe("stale");
  });

  test("ABSENT: no snapshot file resolves every id to `absent`", () => {
    const out = resolveAskStates({ kind: "absent" }, [TEST_ASK_ID, OTHER_ASK_ID], NOW);
    expect(out.get(TEST_ASK_ID)).toEqual({ kind: "absent" });
    expect(out.get(OTHER_ASK_ID)).toEqual({ kind: "absent" });
  });

  test("NOT-IN-SNAPSHOT applies per id — a covered sibling still resolves normally", () => {
    // The distinction that makes this kind worth having: one uncovered id must not degrade
    // the whole render, which a snapshot-wide fallback would do.
    const out = resolveAskStates(
      okRead({ [TEST_ASK_ID]: { found: true, state: "routed", open: true } }),
      [TEST_ASK_ID, OTHER_ASK_ID],
      NOW
    );
    expect(out.get(TEST_ASK_ID)?.kind).toBe("open");
    expect(out.get(OTHER_ASK_ID)?.kind).toBe("not-in-snapshot");
  });

  test("UNREADABLE: a corrupt snapshot resolves to `unavailable`, carrying the reason", () => {
    const out = resolveAskStates({ kind: "unreadable", reason: "bad json" }, [TEST_ASK_ID], NOW);
    expect(out.get(TEST_ASK_ID)).toEqual({ kind: "unavailable", reason: "bad json" });
  });

  test("an empty id list resolves nothing and reads no snapshot", () => {
    expect(resolveAskStates({ kind: "absent" }, [], NOW).size).toBe(0);
  });
});

describe("parseAskStateCache (mt#3744)", () => {
  test("rejects a record with no checkedAt rather than treating it as fresh", () => {
    expect(parseAskStateCache(JSON.stringify({ asks: {} }))).toBeNull();
  });

  test("rejects malformed JSON", () => {
    expect(parseAskStateCache("{not json")).toBeNull();
  });

  test("accepts a well-formed record, including an empty ask set", () => {
    // An empty snapshot is a SUCCESSFUL refresh that covered no pending asks — it must parse,
    // or a producer that correctly found nothing to do would read as a corrupt file.
    const parsed = parseAskStateCache(JSON.stringify({ checkedAt: CHECKED_AT_FIXTURE, asks: {} }));
    expect(parsed).toEqual({ checkedAt: CHECKED_AT_FIXTURE, asks: {} });
  });

  test("drops entries that are malformed without discarding their well-formed siblings", () => {
    const parsed = parseAskStateCache(
      JSON.stringify({
        checkedAt: CHECKED_AT_FIXTURE,
        asks: {
          good: { found: true, state: "closed", open: false, shortId: "ask#5425" },
          missingState: { found: true, open: false },
          notFound: { found: false },
          garbage: "nope",
        },
      })
    );
    expect(Object.keys(parsed?.asks ?? {}).sort()).toEqual(["good", "notFound"]);
    expect(parsed?.asks.good).toEqual({
      found: true,
      state: "closed",
      open: false,
      shortId: "ask#5425",
    });
  });
});

// ---------------------------------------------------------------------------
// Structural regression (mt#3744): the per-turn ask-state path cannot perform a
// live database read.
//
// Asserted on CONSTRUCTION, not latency — the spec's own note is that a timing
// assertion cannot distinguish a cache hit from a fast database.
//
// The construction asserted here is SYNCHRONY, and it is decisive rather than
// indicative: every step of the removed path is unavoidably async in this
// codebase (`ensureHookDomainBootstrap`, `resolvePersistenceProvider`,
// `getDatabaseConnection` and `DrizzleAskRepository.getById` all return
// promises), so a synchronous function provably cannot await any of them. The
// old `resolveAskStates` was `async` for exactly that reason.
//
// The complementary source-level scan — "the module names no persistence
// symbol at all" — lives in `scripts/verify-calibration-cadence-ask-lookup.ts`
// rather than here, because `custom/no-real-fs-in-tests` forbids a test file
// from reading source off disk. That script runs the scan unconditionally,
// including on its no-database SKIP path.
// ---------------------------------------------------------------------------

describe("per-turn path cannot perform a live database read (mt#3744)", () => {
  test("resolveAskStates is synchronous, so it can await no connection", () => {
    expect(resolveAskStates.constructor.name).toBe("Function");
    expect(resolveAskStates.constructor.name).not.toBe("AsyncFunction");
  });

  test("resolveAskStates returns a resolved Map, not a promise", () => {
    const out = resolveAskStates({ kind: "absent" }, [TEST_ASK_ID], NOW);
    expect(out).toBeInstanceOf(Map);
    expect(out).not.toBeInstanceOf(Promise);
  });

  test("parseAskStateCache is synchronous too — the whole path is", () => {
    // The only other half of the per-turn lookup. `readAskStateCache` is deliberately not
    // called here: invoking it would read the real cache path off disk, which is the very
    // thing the rule above forbids a test from doing.
    expect(parseAskStateCache.constructor.name).toBe("Function");
  });

  test("the guard is still registered, so this is a removed read and not a removed guard", () => {
    // Without this, deleting the whole detector would satisfy every assertion above.
    const entry = GUARD_REGISTRY.find((g) => g.name === "calibration-review-cadence-detector");
    expect(entry).toBeDefined();
    expect(entry?.event).toBe("UserPromptSubmit");
  });
});

// ---------------------------------------------------------------------------
// mt#4748 R1 — end-to-end write/read parity (real fs; see file header)
// ---------------------------------------------------------------------------
/* eslint-disable custom/no-real-fs-in-tests -- this block specifically proves
   that a record written through the REAL production write path
   (`logCalibrationRecord`, `.minsky/hooks/dispatcher.ts`) is found by this
   detector's REAL read path (`run()`'s `readContent` closure). A mock or an
   injected reader would assert the mock, which is exactly the gap that let
   one of this file's two `readContent` closures go unmigrated while every
   OTHER test here — none of which touches real fs — stayed green. A
   throwaway mkdtempSync directory (removed in `finally`) keeps this isolated
   from any real `.minsky/` or state dir. */
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("mt#4748 R1 — write/read parity (dispatcher write, cadence-detector read)", () => {
  test("a never-reviewed causal-premise record written via logCalibrationRecord is surfaced as review-due by run()", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "mt4748-parity-cadence-"));
    const statePath = cadenceResolveStatePath(repoRoot, ".minsky/causal-premise-calibration.jsonl");
    try {
      mkdirSync(join(repoRoot, ".git"));

      // 60 days old + no watermark -> "never-reviewed" leg fires regardless
      // of the FIRES_THRESHOLD/DIVERSITY_THRESHOLD count bar (see
      // `computeReviewDueLogs`'s never-reviewed-aging branch) — one record
      // is enough, which keeps this test about the READ PATH, not about
      // reproducing the sweep's threshold arithmetic.
      const oldTimestamp = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
      logCalibrationRecord(
        "causal-premise",
        {
          timestamp: oldTimestamp,
          session_id: "mt4748-parity",
          matchedPhrases: ["because"],
          hadSameTurnVerification: false,
        },
        { projectDir: repoRoot }
      );

      const input: ClaudeHookInput = {
        session_id: "mt4748-parity-session",
        cwd: repoRoot,
        hook_event_name: "UserPromptSubmit",
      };
      const outcome = await run(input, stubContext() as unknown as Parameters<typeof run>[1]);

      // Not a can't-fail probe: a wrong read path makes `readContent` return
      // null for this log, `totalFires` stays 0, the never-reviewed branch's
      // `r.totalFires <= 0` guard takes the `never-fired` path instead (which
      // needs a `liveSinceDate` this synthetic entry has none of), and `due`
      // never includes "causal-premise" — `outcome` would be `null`. This
      // assertion is the one the reviewer-caught omission would have failed.
      expect(outcome).not.toBeNull();
      expect(outcome?.additionalContext ?? "").toContain("causal-premise");
    } finally {
      rmSync(statePath, { force: true });
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});
/* eslint-enable custom/no-real-fs-in-tests */
