// Tests for calibration-review-cadence-detector.ts (mt#2619)
//
// Exercises the pure logic (computeReviewDueLogs, shouldReWarn,
// formatCadenceWarning) with in-memory fixtures — no filesystem I/O per
// `custom/no-real-fs-in-tests`.

import { describe, expect, test } from "bun:test";
import type {
  CalibrationLogEntry,
  CalibrationLogResult,
  ReviewDueLog,
} from "../../src/domain/calibration/calibration-sweep";
import {
  computeReviewDueLogs,
  STALE_DAYS_MS,
} from "../../src/domain/calibration/calibration-sweep";
import {
  buildPendingAskRecord,
  formatCadenceWarning,
  formatPendingAskLines,
  selectPendingAskLogs,
  shouldReWarn,
  COOLDOWN_MS,
  type LastWarnedRecord,
  type LastWarnedStore,
  type AskLookup,
} from "./calibration-review-cadence-detector";
import { GUARD_REGISTRY } from "./registry";

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
    distinctPhrases: 0,
    atCountThreshold: false,
    lowDiversity: false,
    pastThreshold: false,
    newRecords: [],
    watermarkCount: 0,
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
    totalFires: 43,
    distinctPhrases: 31,
    reason: "past-threshold",
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
    totalFires: 1457,
    distinctPhrases: 5,
    reason: "past-threshold",
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

  test("time-stale does not fire when every new record was suppressed", () => {
    const entry = makeEntry(ASK_ROUTING_DEFERRAL);
    const results = [makeResult(entry, { ...ALL_SUPPRESSED, totalFires: 40 })];
    const watermarks = {
      [entry.path]: { lastReviewedCount: 28, lastReviewedAt: LONG_AGO },
    };
    const due = computeReviewDueLogs(results, watermarks, NOW);
    expect(due).toHaveLength(0);
  });

  test("time-stale still fires when at least one new record was injected", () => {
    const entry = makeEntry(ASK_ROUTING_DEFERRAL);
    const results = [
      makeResult(entry, {
        firesSinceLastReview: 12,
        suppressedSinceLastReview: 11,
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
    expect(due).toHaveLength(0);
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
        totalFires: 43,
        distinctPhrases: 31,
        reason: "past-threshold",
      },
      {
        name: RETROSPECTIVE_TRIGGER,
        path: ".minsky/retrospective-trigger-calibration.jsonl",
        kind: "retrospective-trigger",
        firesSinceLastReview: 8,
        injectedFiresSinceLastReview: 8,
        suppressedSinceLastReview: 0,
        totalFires: 20,
        distinctPhrases: 3,
        reason: "time-stale",
      },
    ];
    const msg = formatCadenceWarning(due);
    expect(msg).toContain(ASK_ROUTING_DEFERRAL);
    expect(msg).toContain("43 new fire(s)");
    expect(msg).toContain(RETROSPECTIVE_TRIGGER);
    expect(msg).toContain("unreviewed for >=");
    expect(msg).toContain("/calibration-review");
    // The override env var is deliberately NOT named here (mt#3479): advisory
    // text is read by the agent, and the override is the operator's escape
    // hatch, catalogued in `CLAUDE.md §Hook Files`. Asserted as an absence so a
    // re-added advertisement fails here as well as in guard-feedback-shape.
    expect(msg).not.toContain("MINSKY_SKIP_CALIBRATION_CADENCE");
  });

  test("names the never-reviewed reason (mt#2896)", () => {
    const due: ReviewDueLog[] = [
      {
        name: "causal-premise",
        path: ".minsky/causal-premise-calibration.jsonl",
        kind: "causal-premise",
        firesSinceLastReview: 1,
        totalFires: 1,
        distinctPhrases: 1,
        reason: "never-reviewed",
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
    function worstCaseDue(name = WORST_CASE_NAME): ReviewDueLog {
      return {
        name,
        path: `.minsky/${name}-calibration.jsonl`,
        kind: name,
        firesSinceLastReview: 999,
        injectedFiresSinceLastReview: 999,
        suppressedSinceLastReview: 999,
        totalFires: 9999,
        distinctPhrases: 999,
        reason: "never-fired",
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
    totalFires: 1477,
    distinctPhrases: 5,
    reason: "past-threshold",
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
    totalFires: 1477,
    distinctPhrases: 5,
    reason: "past-threshold",
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
  const STORE_UNREACHABLE = "ask store unreachable";

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

  test("an UNREACHABLE store is distinguishable from a not-found ask", () => {
    // Without this distinction a dead lookup renders exactly like a healthy one that found
    // nothing — the mt#3019 / mt#3046 shape, and the same shape as this detector's own bug.
    const notFound = formatPendingAskLines([pendingLog()], lookups({ kind: "not-found" }));
    const unreachable = formatPendingAskLines(
      [pendingLog()],
      lookups({ kind: "unavailable", reason: "Configuration not initialized" })
    );
    expect(unreachable).not.toBe(notFound);
    expect(unreachable).toContain(STORE_UNREACHABLE);
    expect(unreachable).toContain("Configuration not initialized");
    expect(unreachable).not.toContain(AWAITING);
  });

  test("a missing lookup never silently reads as an open ask", () => {
    const msg = formatPendingAskLines([pendingLog()], new Map());
    expect(msg).not.toContain(AWAITING);
    expect(msg).toContain(STORE_UNREACHABLE);
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
