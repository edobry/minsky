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
  computeReviewDueLogs,
  formatCadenceWarning,
  shouldReWarn,
  STALE_DAYS_MS,
  COOLDOWN_MS,
  type LastWarnedStore,
  type ReviewDueLog,
} from "./calibration-review-cadence-detector";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const NOW = Date.parse("2026-07-06T00:00:00Z");

// Shared string constants (extracted to satisfy no-magic-string-duplication).
const ASK_ROUTING_DEFERRAL = "ask-routing-deferral";
const RETROSPECTIVE_TRIGGER = "retrospective-trigger";

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
    const watermarks = { [entry.path]: { lastReviewedCount: 0, lastReviewedAt: "not-a-date" } };
    const due = computeReviewDueLogs(results, watermarks, NOW);
    expect(due).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// shouldReWarn
// ---------------------------------------------------------------------------

describe("shouldReWarn", () => {
  const due: ReviewDueLog = {
    name: "policy-coverage",
    path: ".minsky/policy-coverage-calibration.jsonl",
    firesSinceLastReview: 1457,
    totalFires: 1457,
    distinctPhrases: 5,
    reason: "past-threshold",
  };

  test("warns when never warned before", () => {
    expect(shouldReWarn(due, {}, NOW)).toBe(true);
  });

  test("does not re-warn within the cooldown when fire count is unchanged", () => {
    const lastWarned: LastWarnedStore = {
      [due.path]: { lastWarnedAt: new Date(NOW - 60_000).toISOString(), lastWarnedFireCount: 1457 },
    };
    expect(shouldReWarn(due, lastWarned, NOW)).toBe(false);
  });

  test("re-warns when the fire count has grown since last warned", () => {
    const lastWarned: LastWarnedStore = {
      [due.path]: { lastWarnedAt: new Date(NOW - 60_000).toISOString(), lastWarnedFireCount: 1000 },
    };
    expect(shouldReWarn(due, lastWarned, NOW)).toBe(true);
  });

  test("re-warns once the cooldown has elapsed even with an unchanged fire count", () => {
    const lastWarned: LastWarnedStore = {
      [due.path]: {
        lastWarnedAt: new Date(NOW - (COOLDOWN_MS + 60_000)).toISOString(),
        lastWarnedFireCount: 1457,
      },
    };
    expect(shouldReWarn(due, lastWarned, NOW)).toBe(true);
  });

  test("re-warns on a malformed lastWarnedAt rather than staying silent forever", () => {
    const lastWarned: LastWarnedStore = {
      [due.path]: { lastWarnedAt: "not-a-date", lastWarnedFireCount: 1457 },
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
        path: ".minsky/ask-routing-deferral-calibration.jsonl",
        firesSinceLastReview: 43,
        totalFires: 43,
        distinctPhrases: 31,
        reason: "past-threshold",
      },
      {
        name: RETROSPECTIVE_TRIGGER,
        path: ".minsky/retrospective-trigger-calibration.jsonl",
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
