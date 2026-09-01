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
  countInvocationsPerLog,
  resolveDetectorsToCheck,
  resolveCalibrationLogDir,
  discoverCalibrationDetectors,
  DEFAULT_COVERAGE_WINDOW_DAYS,
  type CoverageCalibrationEntry,
  type CoverageFsDeps,
} from "./coverage-receipt";
// mt#4784: the writer/reader agreement tests at the bottom of this file must use the
// REAL filesystem — an injected fs would assume the very agreement they exist to prove,
// and a fixed '/mock/tmp' is writable by nobody. Isolation is the documented
// XDG_STATE_HOME override scoped to a mkdtemp dir; see the block comment above their
// describe() for the full rationale.
// eslint-disable-next-line custom/no-real-fs-in-tests -- mt#4784: see the note above
import { mkdtempSync, rmSync } from "node:fs";
// eslint-disable-next-line custom/no-real-fs-in-tests -- mt#4784: see the note above
import { tmpdir } from "node:os";
import { join as pathJoin } from "node:path";
import { findRepoRoot } from "./types";

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
  // mt#4748: the dispatcher's convention moved from repo-rooted
  // `.minsky/<name>-calibration.jsonl` to state-dir, project-keyed.
  test("path follows the dispatcher's <state dir>/projects/<key>/<name>-calibration.jsonl convention", () => {
    const p = resolveCalibrationLogPath(DETECTOR);
    expect(p.endsWith(`/${DETECTOR}-calibration.jsonl`)).toBe(true);
    expect(p).toContain("/projects/");
    expect(p.includes("/.minsky/")).toBe(false);
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

describe("three-state coverage: dormant vs dead (mt#3502)", () => {
  const IN_WINDOW = "2026-01-14T00:00:00.000Z";

  test("no records but invocations in the window reports dormant, not flagged", () => {
    const r = checkCoverageReceipt([], {
      detectorName: DETECTOR,
      now: fixedNow,
      invocations: { count: 854, lastAt: IN_WINDOW },
    });
    expect(r.state).toBe("dormant");
    expect(r.flagged).toBe(false);
    expect(r.hasCoverage).toBe(false);
    expect(r.invocationCount).toBe(854);
    expect(r.lastInvocation).toBe(IN_WINDOW);
    expect(formatCoverageResult(r).startsWith("[DORMANT]")).toBe(true);
  });

  test("no records and zero invocations still flags — the mt#2057 signal survives", () => {
    // The negative control for the whole change: if this passes as dormant,
    // the gate has been disabled rather than taught to distinguish.
    const r = checkCoverageReceipt([], {
      detectorName: DETECTOR,
      now: fixedNow,
      invocations: { count: 0, lastAt: null },
    });
    expect(r.state).toBe("no-liveness-evidence");
    expect(r.flagged).toBe(true);
    expect(formatCoverageResult(r).startsWith("[FLAGGED]")).toBe(true);
  });

  test("omitting invocations preserves the pre-mt#3502 behavior", () => {
    // A caller that has not been taught the join must not silently gain a
    // pass. Absent evidence is "did not look", not "there were none".
    const r = checkCoverageReceipt([], { detectorName: DETECTOR, now: fixedNow });
    expect(r.state).toBe("no-liveness-evidence");
    expect(r.flagged).toBe(true);
    expect(r.invocationCount).toBeNull();
  });

  test("records in the window win over invocation evidence", () => {
    const r = checkCoverageReceipt([liveEntry(1)], {
      detectorName: DETECTOR,
      now: fixedNow,
      invocations: { count: 5, lastAt: IN_WINDOW },
    });
    expect(r.state).toBe("covered");
    expect(r.flagged).toBe(false);
  });

  test("summarizeCoverage counts dormant separately and does not fail the run", () => {
    const dormant = checkCoverageReceipt([], {
      detectorName: "dormant-one",
      now: fixedNow,
      invocations: { count: 3, lastAt: IN_WINDOW },
    });
    const covered = checkCoverageReceipt([liveEntry(1)], {
      detectorName: "covered-one",
      now: fixedNow,
    });
    const report = summarizeCoverage([dormant, covered]);
    expect(report.dormantCount).toBe(1);
    expect(report.flaggedCount).toBe(0);
    expect(report.allCovered).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// countInvocationsPerLog — the many-to-many join (mt#3519)
// ---------------------------------------------------------------------------

describe("countInvocationsPerLog (mt#3519)", () => {
  const WINDOW_START = NOW_MS - 7 * MS_PER_DAY;
  const inWindow = "2026-07-19T12:00:00.000Z";
  const older = "2026-07-19T06:00:00.000Z";
  const outOfWindow = "2026-07-01T12:00:00.000Z";
  /** The real two-log guard this join was widened for. */
  const TWO_LOG_GUARD = "require-execution-evidence-before-merge";

  test("one guard writing TWO logs credits its invocations to BOTH", () => {
    // The regression: the guard->log inversion held one log per guard, so the
    // second declaration overwrote the first and that log counted zero — it
    // reported "no evidence the entry point ran" while its sibling, backed by
    // the same invocations, read as dormant.
    const logToGuards = new Map([
      ["execution-evidence-at-coverage", [TWO_LOG_GUARD]],
      ["execution-evidence-test-first", [TWO_LOG_GUARD]],
    ]);
    const evidence = countInvocationsPerLog(
      [
        { guardName: TWO_LOG_GUARD, timestamp: older },
        { guardName: TWO_LOG_GUARD, timestamp: inWindow },
      ],
      logToGuards,
      WINDOW_START,
      NOW_MS
    );

    expect(evidence.get("execution-evidence-at-coverage")).toEqual({ count: 2, lastAt: inWindow });
    expect(evidence.get("execution-evidence-test-first")).toEqual({ count: 2, lastAt: inWindow });
  });

  test("one log written by TWO guards sums both (the pre-existing direction still holds)", () => {
    const logToGuards = new Map([["operator-deferral", ["guard-a", "guard-b"]]]);
    const evidence = countInvocationsPerLog(
      [
        { guardName: "guard-a", timestamp: older },
        { guardName: "guard-b", timestamp: inWindow },
      ],
      logToGuards,
      WINDOW_START,
      NOW_MS
    );
    expect(evidence.get("operator-deferral")).toEqual({ count: 2, lastAt: inWindow });
  });

  test("a log with a declared guard but no in-window invocations reports zero, not absent", () => {
    // Zero-with-evidence and absent-evidence are different states downstream:
    // one is "the entry point ran and had nothing to say", the other is "no
    // guard declares this log at all".
    const logToGuards = new Map([["quiet-log", ["quiet-guard"]]]);
    const evidence = countInvocationsPerLog(
      [{ guardName: "quiet-guard", timestamp: outOfWindow }],
      logToGuards,
      WINDOW_START,
      NOW_MS
    );
    expect(evidence.get("quiet-log")).toEqual({ count: 0, lastAt: null });
  });

  test("invocations by an undeclared guard are ignored", () => {
    const logToGuards = new Map([["declared-log", ["declared-guard"]]]);
    const evidence = countInvocationsPerLog(
      [{ guardName: "some-other-guard", timestamp: inWindow }],
      logToGuards,
      WINDOW_START,
      NOW_MS
    );
    expect(evidence.get("declared-log")).toEqual({ count: 0, lastAt: null });
    expect(evidence.has("some-other-guard")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// resolveDetectorsToCheck (mt#3742)
//
// The defect this closes: enumerating detectors from the on-disk calibration
// logs alone cannot see a DECLARED detector that has never fired, because a
// never-fired detector writes no file. Observed live 2026-08-05 — the sweep
// reported `Checked: 19 ... PASS` while `stop-at-decision` and
// `build-claim-injection`, both declared, appeared nowhere in its output.
// ---------------------------------------------------------------------------

describe("resolveDetectorsToCheck (mt#3742)", () => {
  // The two real detectors the live 2026-08-05 sweep could not see, plus one
  // that is only ever on disk — named once so the cases below read as the
  // scenarios they are rather than as repeated literals.
  const DECLARED_NEVER_FIRED = "stop-at-decision";
  const ON_DISK_UNDECLARED = "ask-form-lint";

  test("includes a declared detector that has written no log", () => {
    const result = resolveDetectorsToCheck([DECLARED_NEVER_FIRED], []);
    expect(result).toEqual([DECLARED_NEVER_FIRED]);
  });

  test("includes an on-disk log that no guard declares", () => {
    // The inverse direction, owned by mt#3716 — this function must not drop it.
    const result = resolveDetectorsToCheck([], [ON_DISK_UNDECLARED]);
    expect(result).toEqual([ON_DISK_UNDECLARED]);
  });

  test("unions both sources without duplicating the overlap", () => {
    const declared = ["wall-of-text", DECLARED_NEVER_FIRED, "pre-narration"];
    const onDisk = ["wall-of-text", "pre-narration", ON_DISK_UNDECLARED];
    expect(resolveDetectorsToCheck(declared, onDisk)).toEqual([
      ON_DISK_UNDECLARED,
      "pre-narration",
      DECLARED_NEVER_FIRED,
      "wall-of-text",
    ]);
  });

  test("sorts, so report order does not depend on which source a name came from", () => {
    expect(resolveDetectorsToCheck(["zulu", "alpha"], ["mike"])).toEqual(["alpha", "mike", "zulu"]);
  });

  test("accepts a Map's keys iterator, which is what the caller passes", () => {
    const logToGuards = new Map([
      [DECLARED_NEVER_FIRED, ["stop-at-decision-scan"]],
      ["wall-of-text", ["wall-of-text-scan"]],
    ]);
    expect(resolveDetectorsToCheck(logToGuards.keys(), [])).toEqual([
      DECLARED_NEVER_FIRED,
      "wall-of-text",
    ]);
  });

  test("returns empty only when both sources are empty", () => {
    expect(resolveDetectorsToCheck([], [])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// mt#4784 — the WRITER and the DISCOVERY reader must resolve to one directory
// ---------------------------------------------------------------------------
//
// Unlike every test above, these touch the real filesystem on purpose: the
// property under test is that two independently-callable functions agree about
// WHERE a stream lives, and an fs fixture shared between them would assume the
// very agreement it is supposed to prove. Isolation is the documented
// XDG_STATE_HOME override (see `packages/shared/src/paths.ts`), scoped to a
// temp dir and restored in `finally`.
//
// The bug this pins: discovery re-derived its own root as
// `join(findRepoRoot(cwd), ".minsky")` and kept it through mt#4748's move, so
// the roster came from a frozen pre-migration directory while the records came
// from the state dir. Nothing failed — in a tree with leftover files the sweep
// still printed a full report, and in one without it exited 0 saying "nothing
// to check".

/* eslint-disable custom/no-real-fs-in-tests --
   These three tests touch the real filesystem deliberately, and an fs fixture
   would defeat their purpose. The property under test is that the WRITER
   (`logCalibrationRecord`) and the DISCOVERY reader (`discoverCalibrationDetectors`)
   independently resolve to the SAME directory; handing both an injected fs, or a
   shared path constant, would assume exactly the agreement being proven — which is
   how the mt#4784 split survived a full migration with a green suite. Isolation is
   the documented XDG_STATE_HOME override (`packages/shared/src/paths.ts`), scoped to
   a mkdtemp dir and restored in `finally`, so nothing is written outside the temp
   directory and no state leaks between tests. */
describe("discovery agrees with the production writer (mt#4784)", () => {
  const DETECTOR = "mt4784-writer-reader-agreement";

  test("discovers a stream written through logCalibrationRecord", async () => {
    const { logCalibrationRecord } = await import("./dispatcher");
    const repoRoot = findRepoRoot(process.cwd());
    const previousXdg = process.env["XDG_STATE_HOME"];
    const stateHome = mkdtempSync(pathJoin(tmpdir(), "mt4784-"));
    process.env["XDG_STATE_HOME"] = stateHome;
    try {
      // No path literal crosses this boundary: the writer is given a project
      // root and the reader is given the same root, and each resolves its own
      // location. If they ever disagree again, this fails.
      logCalibrationRecord(
        DETECTOR,
        { source: "test", timestamp: NOW_ISO },
        {
          projectDir: repoRoot,
        }
      );
      expect(discoverCalibrationDetectors(repoRoot)).toContain(DETECTOR);
    } finally {
      if (previousXdg === undefined) delete process.env["XDG_STATE_HOME"];
      else process.env["XDG_STATE_HOME"] = previousXdg;
      rmSync(stateHome, { recursive: true, force: true });
    }
  });

  test("discovery does NOT resolve to the pre-mt#4748 repo-rooted location", () => {
    // The absence half. A test that only asserts the new shape is present
    // would still pass if the old repo-rooted read were restored alongside it
    // (PR #3541 R1's precedent, one task over in this same family).
    const repoRoot = findRepoRoot(process.cwd());
    expect(resolveCalibrationLogDir(repoRoot)).not.toBe(pathJoin(repoRoot, ".minsky"));
    expect(resolveCalibrationLogDir(repoRoot).startsWith(repoRoot)).toBe(false);
  });

  test("an absent directory reads as no telemetry, not as an error", () => {
    const previousXdg = process.env["XDG_STATE_HOME"];
    process.env["XDG_STATE_HOME"] = pathJoin(tmpdir(), "mt4784-nonexistent-state-home");
    try {
      expect(discoverCalibrationDetectors(findRepoRoot(process.cwd()))).toEqual([]);
    } finally {
      if (previousXdg === undefined) delete process.env["XDG_STATE_HOME"];
      else process.env["XDG_STATE_HOME"] = previousXdg;
    }
  });
});
