// Tests for .minsky/hooks/coverage-receipt.ts — mt#2554 (RFC Phase 1 SC#5).
//
// The coverage-receipt done-gate: a detector PASSES only when >=1
// `source:"live"` calibration entry falls inside the rolling window; a
// detector with zero live fires in the window is FLAGGED (SC#5 / AT#4). All
// tests use a fixed injected clock and (for the read path) an in-memory fs
// fixture — no test touches the real filesystem or a real calibration log.

import { describe, test, expect } from "bun:test";
import {
  checkCoverageReceipt,
  checkDetectorCoverage,
  readCalibrationEntries,
  isLiveReceipt,
  resolveCalibrationLogPath,
  summarizeCoverage,
  formatCoverageResult,
  DEFAULT_COVERAGE_WINDOW_DAYS,
  type CoverageCalibrationEntry,
  type CoverageFsDeps,
} from "./coverage-receipt";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW_ISO = "2026-07-20T12:00:00.000Z";
const NOW_MS = Date.parse(NOW_ISO);
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DETECTOR = "retrospective-trigger";
const LOG_PATH = "/fake/repo/.minsky/retrospective-trigger-calibration.jsonl";

const fixedNow = (): Date => new Date(NOW_MS);

/** ISO timestamp `n` days before the fixed NOW. */
function daysAgo(n: number): string {
  return new Date(NOW_MS - n * MS_PER_DAY).toISOString();
}

function liveEntry(daysBack: number): CoverageCalibrationEntry {
  return { source: "live", timestamp: daysAgo(daysBack) };
}

function syntheticEntry(daysBack: number): CoverageCalibrationEntry {
  return { source: "synthetic", timestamp: daysAgo(daysBack) };
}

/** A pre-mt#2554 record — real runtime fire, but no `source` field. */
function legacyEntry(daysBack: number): CoverageCalibrationEntry {
  return { timestamp: daysAgo(daysBack) };
}

function makeReadOnlyFs(files: Record<string, string>): CoverageFsDeps {
  return {
    existsSync: (p: string) => p in files,
    readFileSync: (p: string) => {
      if (!(p in files)) throw new Error(`ENOENT: ${p}`);
      return files[p] as string;
    },
  };
}

function toJsonl(entries: CoverageCalibrationEntry[]): string {
  return `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// checkCoverageReceipt — the core gate (SC#5 / AT#4)
// ---------------------------------------------------------------------------

describe("checkCoverageReceipt — passes with a live receipt in the window", () => {
  test(">=1 live fire in window → hasCoverage, not flagged (AT#4)", () => {
    const r = checkCoverageReceipt([liveEntry(2)], { detectorName: DETECTOR, now: fixedNow });
    expect(r.hasCoverage).toBe(true);
    expect(r.flagged).toBe(false);
    expect(r.liveFireCount).toBe(1);
    expect(r.lastLiveFire).toBe(daysAgo(2));
    expect(r.windowDays).toBe(DEFAULT_COVERAGE_WINDOW_DAYS);
    expect(r.detector).toBe(DETECTOR);
  });

  test("multiple live fires → count and lastLiveFire reflect the most recent", () => {
    const r = checkCoverageReceipt([liveEntry(6), liveEntry(1), liveEntry(3)], {
      detectorName: DETECTOR,
      now: fixedNow,
    });
    expect(r.liveFireCount).toBe(3);
    expect(r.lastLiveFire).toBe(daysAgo(1));
    expect(r.flagged).toBe(false);
  });
});

describe("checkCoverageReceipt — flags when no live receipt in the window", () => {
  test("zero entries → flagged (AT#4)", () => {
    const r = checkCoverageReceipt([], { detectorName: DETECTOR, now: fixedNow });
    expect(r.hasCoverage).toBe(false);
    expect(r.flagged).toBe(true);
    expect(r.liveFireCount).toBe(0);
    expect(r.lastLiveFire).toBeNull();
  });

  test("synthetic-only entries in window → flagged (synthetic is not a receipt)", () => {
    const r = checkCoverageReceipt([syntheticEntry(1), syntheticEntry(3)], {
      detectorName: DETECTOR,
      now: fixedNow,
    });
    expect(r.flagged).toBe(true);
    expect(r.liveFireCount).toBe(0);
  });

  test("live fire OUTSIDE the window (>7d ago) → flagged", () => {
    const r = checkCoverageReceipt([liveEntry(8)], { detectorName: DETECTOR, now: fixedNow });
    expect(r.flagged).toBe(true);
    expect(r.liveFireCount).toBe(0);
  });

  test("future-dated live fire (after now) → excluded → flagged", () => {
    const future = new Date(NOW_MS + 2 * MS_PER_DAY).toISOString();
    const r = checkCoverageReceipt([{ source: "live", timestamp: future }], {
      detectorName: DETECTOR,
      now: fixedNow,
    });
    expect(r.flagged).toBe(true);
  });

  test("live fire labelled truePositive:false → excluded → flagged (all-FP detector)", () => {
    const r = checkCoverageReceipt(
      [{ source: "live", timestamp: daysAgo(1), truePositive: false }],
      {
        detectorName: DETECTOR,
        now: fixedNow,
      }
    );
    expect(r.flagged).toBe(true);
    expect(r.liveFireCount).toBe(0);
  });
});

describe("checkCoverageReceipt — legacy and boundary behavior", () => {
  test("legacy entry (no source) in window counts as live (backward-compat)", () => {
    const r = checkCoverageReceipt([legacyEntry(2)], { detectorName: DETECTOR, now: fixedNow });
    expect(r.hasCoverage).toBe(true);
    expect(r.liveFireCount).toBe(1);
  });

  test("wider window picks up a fire the default 7d window misses", () => {
    const entries = [liveEntry(10)];
    const narrow = checkCoverageReceipt(entries, { detectorName: DETECTOR, now: fixedNow });
    const wide = checkCoverageReceipt(entries, {
      detectorName: DETECTOR,
      windowDays: 14,
      now: fixedNow,
    });
    expect(narrow.flagged).toBe(true);
    expect(wide.flagged).toBe(false);
    expect(wide.windowDays).toBe(14);
  });

  test("unparseable timestamp is skipped without crashing", () => {
    const entries: CoverageCalibrationEntry[] = [
      { source: "live", timestamp: "not-a-date" },
      liveEntry(1),
    ];
    const r = checkCoverageReceipt(entries, { detectorName: DETECTOR, now: fixedNow });
    expect(r.liveFireCount).toBe(1);
  });

  test("mixed corpus: only the single live-TP in-window entry counts", () => {
    const entries = [
      liveEntry(1), // counts
      syntheticEntry(1), // synthetic — excluded
      liveEntry(30), // out of window — excluded
      { source: "live" as const, timestamp: daysAgo(2), truePositive: false }, // known FP — excluded
    ];
    const r = checkCoverageReceipt(entries, { detectorName: DETECTOR, now: fixedNow });
    expect(r.liveFireCount).toBe(1);
    expect(r.flagged).toBe(false);
    expect(r.totalEntries).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// isLiveReceipt
// ---------------------------------------------------------------------------

describe("isLiveReceipt", () => {
  test("live entry is a receipt", () => {
    expect(isLiveReceipt({ source: "live", timestamp: NOW_ISO })).toBe(true);
  });
  test("synthetic entry is not a receipt", () => {
    expect(isLiveReceipt({ source: "synthetic", timestamp: NOW_ISO })).toBe(false);
  });
  test("missing source (legacy) is a receipt", () => {
    expect(isLiveReceipt({ timestamp: NOW_ISO })).toBe(true);
  });
  test("truePositive:false is not a receipt", () => {
    expect(isLiveReceipt({ source: "live", timestamp: NOW_ISO, truePositive: false })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// readCalibrationEntries — fs seam
// ---------------------------------------------------------------------------

describe("readCalibrationEntries", () => {
  test("reads valid JSONL and skips malformed lines", () => {
    const good = toJsonl([liveEntry(1), liveEntry(2)]);
    const raw = `${good}{ this is not json }\n${JSON.stringify(liveEntry(3))}\n`;
    const fs = makeReadOnlyFs({ [LOG_PATH]: raw });
    const entries = readCalibrationEntries(LOG_PATH, fs);
    expect(entries.length).toBe(3);
  });

  test("missing file → empty array (no throw)", () => {
    const fs = makeReadOnlyFs({});
    expect(readCalibrationEntries(LOG_PATH, fs)).toEqual([]);
  });

  test("entry without a timestamp string is dropped", () => {
    const raw = `${JSON.stringify({ source: "live" })}\n${JSON.stringify(liveEntry(1))}\n`;
    const fs = makeReadOnlyFs({ [LOG_PATH]: raw });
    const entries = readCalibrationEntries(LOG_PATH, fs);
    expect(entries.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// checkDetectorCoverage — read + check integration via the fs seam
// ---------------------------------------------------------------------------

describe("checkDetectorCoverage", () => {
  test("flags a detector whose log has only an out-of-window live fire", () => {
    const fs = makeReadOnlyFs({ [LOG_PATH]: toJsonl([liveEntry(20)]) });
    const r = checkDetectorCoverage(DETECTOR, { logPath: LOG_PATH, fs, now: fixedNow });
    expect(r.flagged).toBe(true);
    expect(r.detector).toBe(DETECTOR);
  });

  test("passes a detector with a recent live fire", () => {
    const fs = makeReadOnlyFs({ [LOG_PATH]: toJsonl([liveEntry(1)]) });
    const r = checkDetectorCoverage(DETECTOR, { logPath: LOG_PATH, fs, now: fixedNow });
    expect(r.flagged).toBe(false);
    expect(r.liveFireCount).toBe(1);
  });

  test("missing log → flagged (fail-safe, no throw)", () => {
    const fs = makeReadOnlyFs({});
    const r = checkDetectorCoverage(DETECTOR, { logPath: LOG_PATH, fs, now: fixedNow });
    expect(r.flagged).toBe(true);
    expect(r.totalEntries).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Path resolution + report formatting
// ---------------------------------------------------------------------------

describe("resolveCalibrationLogPath / summarizeCoverage / formatCoverageResult", () => {
  test("path follows the dispatcher's .minsky/<name>-calibration.jsonl convention", () => {
    const p = resolveCalibrationLogPath(DETECTOR);
    expect(p.endsWith(`/.minsky/${DETECTOR}-calibration.jsonl`)).toBe(true);
  });

  test("summarizeCoverage counts flagged detectors", () => {
    const covered = checkCoverageReceipt([liveEntry(1)], { detectorName: "a", now: fixedNow });
    const flagged = checkCoverageReceipt([], { detectorName: "b", now: fixedNow });
    const report = summarizeCoverage([covered, flagged]);
    expect(report.flaggedCount).toBe(1);
    expect(report.allCovered).toBe(false);
  });

  test("formatCoverageResult renders FLAGGED / OK status", () => {
    const flagged = checkCoverageReceipt([], { detectorName: DETECTOR, now: fixedNow });
    const ok = checkCoverageReceipt([liveEntry(1)], { detectorName: DETECTOR, now: fixedNow });
    expect(formatCoverageResult(flagged).startsWith("[FLAGGED]")).toBe(true);
    expect(formatCoverageResult(ok).startsWith("[OK]")).toBe(true);
  });
});
