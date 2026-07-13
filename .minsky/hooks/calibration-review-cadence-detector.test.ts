// Tests for calibration-review-cadence-detector.ts (mt#2619)
//
// Exercises the pure logic (computeReviewDueLogs, shouldReWarn,
// formatCadenceWarning) with in-memory fixtures — no filesystem I/O per
// `custom/no-real-fs-in-tests`.

import { describe, expect, test } from "bun:test";
import type {
  CalibrationLogEntry,
  CalibrationLogResult,
} from "../../src/domain/calibration/calibration-sweep";
import {
  buildPendingAskRecord,
  computeReviewDueLogs,
  formatCadenceWarning,
  formatPendingAskLines,
  selectPendingAskLogs,
  shouldReWarn,
  STALE_DAYS_MS,
  COOLDOWN_MS,
  type LastWarnedRecord,
  type LastWarnedStore,
  type ReviewDueLog,
} from "./calibration-review-cadence-detector";

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
  return {
    entry,
    exists: true,
    totalFires: 0,
    firesSinceLastReview: 0,
    distinctPhrases: 0,
    atCountThreshold: false,
    lowDiversity: false,
    pastThreshold: false,
    newRecords: [],
    watermarkCount: 0,
    ...overrides,
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

describe("formatCadenceWarning", () => {
  test("names each due log with its fire count and reason", () => {
    const due: ReviewDueLog[] = [
      {
        name: ASK_ROUTING_DEFERRAL,
        path: ASK_ROUTING_DEFERRAL_PATH,
        kind: ASK_ROUTING_DEFERRAL,
        firesSinceLastReview: 43,
        totalFires: 43,
        distinctPhrases: 31,
        reason: "past-threshold",
      },
      {
        name: RETROSPECTIVE_TRIGGER,
        path: ".minsky/retrospective-trigger-calibration.jsonl",
        kind: "retrospective-trigger",
        firesSinceLastReview: 8,
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
    expect(msg).toContain("MINSKY_SKIP_CALIBRATION_CADENCE");
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
  test("names the log and the open ask id, without demanding action", () => {
    const pending: ReviewDueLog[] = [
      {
        name: POLICY_COVERAGE,
        path: POLICY_COVERAGE_PATH,
        kind: POLICY_COVERAGE,
        firesSinceLastReview: 20,
        totalFires: 1477,
        distinctPhrases: 5,
        reason: "past-threshold",
        openAskId: TEST_ASK_ID,
      },
    ];
    const msg = formatPendingAskLines(pending);
    expect(msg).toContain(POLICY_COVERAGE);
    expect(msg).toContain(TEST_ASK_ID);
    expect(msg).toContain("disposition pending");
    expect(msg).not.toContain("/calibration-review");
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
