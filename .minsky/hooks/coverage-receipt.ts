// Coverage-receipt done-gate — mt#2554 (RFC mt#2263 Phase 1, SC#5).
//
// A detector is not "done" because it shipped, passed unit tests, or returned
// a healthy signal — it is done only when its calibration log proves it
// actually FIRED on its intended surface with real (live) input. This is the
// coverage-receipt principle (memory fc8c66e7 / the mt#2057 9-day dead-hook
// incident): `status:DONE` and `count > 0` are liveness/shape signals, not
// coverage claims.
//
// This module is the LIVE half of the two-part coverage story:
//   - SYNTHETIC half — `canary-runner.ts` (mt#2889) proves a guard's DECISION
//     LOGIC still works by running a synthetic fixture through its real run().
//   - LIVE half (this module) — proves the guard actually SEES real input by
//     requiring >=1 `source:"live"` calibration entry inside a rolling window.
// The `source: "live" | "synthetic"` field on each calibration entry is the
// discriminator both halves share.
//
// Dependency-free (per `.minsky/hooks/SPEC.md`'s invariant): no `src/` or
// `packages/domain` imports — only the sibling `./types` helper for repo-root
// resolution. Read-only + fail-safe: a malformed log line is skipped, a
// missing log yields zero live receipts (which FLAGS the detector — the
// honest "no coverage" answer — rather than throwing).
//
// @see mt#2554 — this task (RFC Phase 1 SC#5)
// @see .minsky/hooks/canary-runner.ts — the synthetic-input sibling (mt#2889)
// @see .minsky/hooks/fire-log.ts — the corpus-wide guard fire-log (mt#2597); a
//      DIFFERENT log (allow/warn/deny decisions), not the per-detector
//      calibration log this module reads
// @see scripts/check-coverage-receipts.ts — CLI entrypoint / invocation path
// @see docs/architecture/evaluation-loop-fire-log.md — evaluation-loop writeup

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { getMinskyStateDir } from "@minsky/shared/paths";
import { findRepoRoot } from "./types";

// ---------------------------------------------------------------------------
// Calibration-entry shape (the subset this gate reads)
// ---------------------------------------------------------------------------

/**
 * Provenance of a calibration entry. `live` = a real runtime fire of the
 * detector on a genuine transcript. `synthetic` = a fixture/replay/backfill
 * entry (a test wrote it; the detector did not fire on real input). Only
 * `live` entries are coverage receipts.
 */
export type CalibrationSource = "live" | "synthetic";

/**
 * The fields of a calibration record this gate consumes. Detectors write
 * richer records (matches, excerpt, session_id); those are ignored here.
 * `source` is OPTIONAL because entries written before mt#2554 carry no
 * `source` field — see {@link isLiveReceipt} for how legacy entries are
 * treated.
 */
export interface CoverageCalibrationEntry {
  timestamp: string;
  source?: CalibrationSource;
  /**
   * Optional explicit true-positive/false-positive label. TP-vs-FP labelling
   * is NOT mechanizable at write time in Phase 1 (RFC mt#2263: "no TP/FP
   * labelling in early phases"), so this is absent on ordinary runtime fires.
   * When a later calibration review DOES label an entry `truePositive:false`,
   * that entry stops counting as a receipt — so a detector firing only on
   * known false positives is still flagged as un-covered.
   */
  truePositive?: boolean;
}

export const DEFAULT_COVERAGE_WINDOW_DAYS = 7;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// fs dependency seam (testability — no real fs touched in unit tests)
// ---------------------------------------------------------------------------

export interface CoverageFsDeps {
  existsSync: (p: string) => boolean;
  readFileSync: (p: string, encoding: "utf-8") => string;
}

const REAL_FS: CoverageFsDeps = { existsSync, readFileSync };

// ---------------------------------------------------------------------------
// Path resolution — mirrors the dispatcher's D4 `calibrationLogPath`
// (dispatcher.ts): state dir, project-keyed (mt#4748 SC1).
// ---------------------------------------------------------------------------

/**
 * Derive a stable, filesystem-safe key for a repo root — duplicated (not
 * imported) from `dispatcher.ts` / `ingest-runtime.ts`'s `projectStateKey`
 * for the same reason those two don't share one either: each module tree
 * stays free of a dependency on the others by convention. Must compute the
 * IDENTICAL value from the IDENTICAL input for this reader to ever find what
 * the dispatcher wrote (mt#4748).
 */
function projectStateKey(repoRoot: string): string {
  return createHash("sha256").update(repoRoot).digest("hex").slice(0, 16);
}

/**
 * Resolve the calibration JSONL path for a logical detector name (e.g.
 * `"retrospective-trigger"` ->
 * `<state dir>/projects/<key>/retrospective-trigger-calibration.jsonl`).
 * Mirrors the exact convention the dispatcher's `calibrationLogPath` and the
 * `src/domain/calibration/calibration-sweep.ts` consumer already expect.
 *
 * mt#4748 (SC1): rooted on `getMinskyStateDir()`, not the repo — this was a
 * split-brain reader waiting to happen the moment `calibrationLogPath`
 * moved: `findRepoRoot(cwd)` alone still resolves fine, it just no longer
 * names where the file IS.
 */
export function resolveCalibrationLogPath(
  detectorName: string,
  cwd: string = process.cwd()
): string {
  const repoRoot = findRepoRoot(cwd);
  return join(
    getMinskyStateDir(),
    "projects",
    projectStateKey(repoRoot),
    `${detectorName}-calibration.jsonl`
  );
}

/**
 * The detector set a coverage sweep must examine (mt#3742).
 *
 * Enumerating from disk alone cannot see a DECLARED detector that has never
 * fired: with no `<name>-calibration.jsonl` written there is no file to
 * discover, so the detector is never checked and can never be `[FLAGGED]` —
 * even though "no records at all" is precisely the dead-entry-point symptom
 * this gate exists to catch. That is the check's own purpose inverted: absence
 * of output is what it hunts, and absence of output is what made a detector
 * invisible to it.
 *
 * Unioning the DECLARED names in closes that blind spot, and needs no
 * downstream change: `checkDetectorCoverage` already handles a detector with
 * no records, and the dormant-vs-dead call is made from fire-log invocation
 * evidence rather than from the records — so a declared-but-never-fired
 * detector resolves to DORMANT (its entry point ran, nothing to report) or
 * FLAGGED (nothing invoked it) on the same evidence as any other.
 *
 * Sorted and de-duplicated, so report order does not depend on which source a
 * name arrived from.
 */
export function resolveDetectorsToCheck(
  declaredNames: Iterable<string>,
  discoveredNames: readonly string[]
): string[] {
  return [...new Set([...declaredNames, ...discoveredNames])].sort();
}

// ---------------------------------------------------------------------------
// Reading (pure read of the on-disk JSONL — fail-safe, never throws)
// ---------------------------------------------------------------------------

function isEntryShape(item: unknown): item is CoverageCalibrationEntry {
  if (!item || typeof item !== "object") return false;
  const r = item as Record<string, unknown>;
  return typeof r.timestamp === "string";
}

/**
 * Read + parse a calibration JSONL log. Malformed lines are skipped; a
 * missing file yields `[]` (no throw). Entries without a `timestamp` string
 * are dropped (they cannot be windowed).
 */
export function readCalibrationEntries(
  logPath: string,
  fs: CoverageFsDeps = REAL_FS
): CoverageCalibrationEntry[] {
  try {
    if (!fs.existsSync(logPath)) return [];
    const raw = fs.readFileSync(logPath, "utf-8");
    const entries: CoverageCalibrationEntry[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (isEntryShape(parsed)) entries.push(parsed);
      } catch {
        // Skip malformed line.
      }
    }
    return entries;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// The coverage check (pure — no I/O)
// ---------------------------------------------------------------------------

/**
 * True when `entry` counts as a live coverage receipt:
 *   - NOT explicitly `source:"synthetic"` (a fixture/replay entry), AND
 *   - NOT explicitly labelled `truePositive:false` (a known false positive).
 *
 * A MISSING `source` counts as live (backward compatibility): every
 * calibration entry written before mt#2554 was a real runtime fire —
 * `synthetic` entries did not exist — so treating legacy entries as live is
 * both historically accurate and avoids false-flagging a genuinely-live
 * detector during the schema transition. Legacy entries age out of the
 * rolling window within `windowDays` regardless. Going forward, every
 * synthetic entry is explicitly tagged `source:"synthetic"`, so this default
 * only ever affects pre-mt#2554 records.
 */
export function isLiveReceipt(entry: CoverageCalibrationEntry): boolean {
  return entry.source !== "synthetic" && entry.truePositive !== false;
}

/**
 * What the calibration log plus the invocation evidence jointly say about a
 * detector (mt#3502).
 *
 * The two-state version of this gate conflated the last two: an empty
 * calibration log was reported as "no coverage" whether the entry point was
 * running and had nothing exceptional to say, or was not running at all. Those
 * demand opposite responses — the first is healthy, the second is the mt#2057
 * dead-hook incident this gate exists for — and both were live in the repo at
 * once when this was written (`causal-premise` dormant-but-flagged,
 * `policy-coverage` with no liveness evidence at all).
 *
 * - `covered` — at least one live receipt inside the window.
 * - `dormant` — no receipts, but the entry point demonstrably RAN inside the
 *   window. Healthy: it had nothing exceptional to report.
 * - `no-liveness-evidence` — neither. The only state that flags.
 */
export type CoverageState = "covered" | "dormant" | "no-liveness-evidence";

/**
 * Proof that a detector's entry point actually ran, independent of whether it
 * had anything to record. Supplied by the caller rather than read here: the
 * detector-name-to-guard-name join lives in the guard registry, and this
 * module deliberately stays free of that dependency (see the header note).
 *
 * A canary result is NOT an acceptable substitute. A canary calls the guard's
 * exported PURE decision function, so it proves the LOGIC works while saying
 * nothing about whether anything invokes it — exactly the dead-entry-point
 * class of mt#3019 / mt#3046 / mt#3308. Only an observed invocation answers
 * "does it still run".
 */
export interface InvocationEvidence {
  /** Invocations observed inside the window. */
  count: number;
  /** ISO timestamp of the most recent one, or null when there are none. */
  lastAt: string | null;
}

/** One fire-log entry, reduced to what the invocation count needs. */
export interface InvocationSource {
  guardName: string;
  timestamp: string;
}

/**
 * Count fire-log invocations per calibration-log name inside a window (mt#3519).
 *
 * Pure and injectable — lives here rather than in
 * `scripts/check-coverage-receipts.ts` so the many-to-many join can be tested.
 * It was inline in that script, and its guard→log inversion held ONE log per
 * guard: when a guard declared two logs (the execution-evidence merge gate
 * writes `execution-evidence-at-coverage` itself and
 * `execution-evidence-test-first` through `test-first-evidence.ts`), the second
 * declaration overwrote the first and that log counted ZERO invocations. It
 * then reported "no evidence the entry point ran at all" while its sibling,
 * backed by the very same invocations, read as dormant — the precise ambiguity
 * mt#3502 removed, reintroduced through the back door.
 *
 * @param entries fire-log entries (already read; this function does no I/O)
 * @param logToGuards calibration-log name -> every guard that writes it
 */
export function countInvocationsPerLog(
  entries: Iterable<InvocationSource>,
  logToGuards: Map<string, string[]>,
  cutoffMs: number,
  nowMs: number
): Map<string, InvocationEvidence> {
  // guard -> EVERY log it writes. Both directions are many-to-many:
  // `operator-deferral` is written by two guards, and the execution-evidence
  // gate writes two logs.
  const guardToLogs = new Map<string, string[]>();
  for (const [log, guards] of logToGuards) {
    for (const g of guards) {
      const existing = guardToLogs.get(g);
      if (existing) existing.push(log);
      else guardToLogs.set(g, [log]);
    }
  }

  const evidence = new Map<string, InvocationEvidence>();
  for (const log of logToGuards.keys()) evidence.set(log, { count: 0, lastAt: null });

  for (const entry of entries) {
    const logs = guardToLogs.get(entry.guardName);
    if (logs === undefined) continue;
    const t = Date.parse(entry.timestamp);
    if (Number.isNaN(t) || t < cutoffMs || t > nowMs) continue;
    for (const log of logs) {
      const cur = evidence.get(log);
      if (!cur) continue;
      cur.count += 1;
      if (cur.lastAt === null || entry.timestamp > cur.lastAt) cur.lastAt = entry.timestamp;
    }
  }
  return evidence;
}

export interface CoverageReceiptResult {
  detector: string;
  /** True when >=1 live receipt exists inside the window. */
  hasCoverage: boolean;
  /**
   * True when the detector should be surfaced for review. Equals
   * `state === "no-liveness-evidence"` — NOT `!hasCoverage`, which is what it
   * meant before mt#3502 and which flagged every dormant detector.
   */
  flagged: boolean;
  /** mt#3502 — see {@link CoverageState}. */
  state: CoverageState;
  liveFireCount: number;
  /** Invocations observed in the window; null when the caller supplied none. */
  invocationCount: number | null;
  /** Most recent observed invocation inside the window, or null. */
  lastInvocation: string | null;
  windowDays: number;
  /** ISO timestamp the window ends at (the reference "now"). */
  referenceTime: string;
  /** ISO timestamp of the most recent live receipt inside the window, or null. */
  lastLiveFire: string | null;
  /** Total calibration entries considered (pre-window-filter). */
  totalEntries: number;
  reason: string;
}

export interface CheckCoverageOptions {
  detectorName?: string;
  windowDays?: number;
  /** Injectable clock (default `() => new Date()`) so tests are deterministic. */
  now?: () => Date;
  /**
   * mt#3502 — invocation evidence for this detector inside the window.
   *
   * OMITTED means "the caller did not look", not "there were none": the result
   * then reports `no-liveness-evidence` on an empty log exactly as the
   * pre-mt#3502 gate did, so a caller that has not been taught the join keeps
   * its old behavior instead of silently gaining a pass.
   */
  invocations?: InvocationEvidence;
}

/**
 * Evaluate the coverage-receipt gate for one detector's calibration entries.
 * PASSES (`hasCoverage:true`, `flagged:false`) when >=1 live receipt falls
 * inside the `[now - windowDays, now]` window; otherwise FLAGS the detector
 * (`hasCoverage:false`, `flagged:true`) — the "zero live fires in N days
 * retroactively fails and is surfaced for review" gate (SC#5).
 */
export function checkCoverageReceipt(
  entries: readonly CoverageCalibrationEntry[],
  options: CheckCoverageOptions = {}
): CoverageReceiptResult {
  const detector = options.detectorName ?? "detector";
  const windowDays = options.windowDays ?? DEFAULT_COVERAGE_WINDOW_DAYS;
  const now = (options.now ?? (() => new Date()))();
  const nowMs = now.getTime();
  const cutoffMs = nowMs - windowDays * MS_PER_DAY;

  let liveFireCount = 0;
  let lastLiveFire: string | null = null;

  for (const entry of entries) {
    if (!isLiveReceipt(entry)) continue;
    const t = Date.parse(entry.timestamp);
    // Drop unparseable timestamps and entries outside the rolling window
    // (future-dated entries beyond `now` are also excluded).
    if (Number.isNaN(t) || t < cutoffMs || t > nowMs) continue;
    liveFireCount++;
    if (lastLiveFire === null || entry.timestamp > lastLiveFire) {
      lastLiveFire = entry.timestamp;
    }
  }

  const hasCoverage = liveFireCount > 0;
  const invocations = options.invocations;

  let state: CoverageState;
  let reason: string;
  if (hasCoverage) {
    state = "covered";
    reason = `${liveFireCount} live fire(s) in the last ${windowDays}d (most recent ${lastLiveFire}).`;
  } else if (invocations !== undefined && invocations.count > 0) {
    state = "dormant";
    reason =
      `Dormant: no records in the last ${windowDays}d, but ${invocations.count} invocation(s) ` +
      `(most recent ${invocations.lastAt}) — the entry point is running and had nothing to report.`;
  } else {
    state = "no-liveness-evidence";
    reason =
      invocations === undefined
        ? `No live fires in the last ${windowDays}d and no invocation evidence was supplied — detector has no coverage receipt and is surfaced for review.`
        : `No live fires AND no invocations in the last ${windowDays}d — no evidence the entry point ran at all.`;
  }

  return {
    detector,
    hasCoverage,
    flagged: state === "no-liveness-evidence",
    state,
    liveFireCount,
    invocationCount: invocations?.count ?? null,
    lastInvocation: invocations?.lastAt ?? null,
    windowDays,
    referenceTime: now.toISOString(),
    lastLiveFire,
    totalEntries: entries.length,
    reason,
  };
}

/**
 * Convenience: resolve the log path, read it fresh from disk, and evaluate
 * the gate for one named detector. Fail-safe — a missing/unreadable log
 * yields a flagged result (zero live receipts), never a throw.
 */
export function checkDetectorCoverage(
  detectorName: string,
  options: CheckCoverageOptions & { cwd?: string; fs?: CoverageFsDeps; logPath?: string } = {}
): CoverageReceiptResult {
  const logPath = options.logPath ?? resolveCalibrationLogPath(detectorName, options.cwd);
  const entries = readCalibrationEntries(logPath, options.fs);
  return checkCoverageReceipt(entries, {
    detectorName,
    windowDays: options.windowDays,
    now: options.now,
    invocations: options.invocations,
  });
}

// ---------------------------------------------------------------------------
// Report formatting (pure — no I/O)
// ---------------------------------------------------------------------------

/**
 * One human-readable line per detector result.
 *
 * The label names the STATE, not just pass/fail (mt#3502): a bare `[OK]` on a
 * dormant detector hides which of the two very different healthy situations it
 * is in, and hiding that is what let `policy-coverage` read `[OK]` for weeks on
 * borrowed records while having no liveness evidence at all.
 */
export function formatCoverageResult(r: CoverageReceiptResult): string {
  const status = r.state === "covered" ? "OK" : r.state === "dormant" ? "DORMANT" : "FLAGGED";
  return `[${status}] ${r.detector}: ${r.reason}`;
}

export interface CoverageReport {
  results: CoverageReceiptResult[];
  flaggedCount: number;
  /** mt#3502 — detectors running but with nothing to report. Not a failure. */
  dormantCount: number;
  /**
   * True when nothing is flagged. Named for the pre-mt#3502 two-state world;
   * it now means "nothing lacks liveness evidence", so a run with dormant
   * detectors is still `allCovered: true` and still exits zero.
   */
  allCovered: boolean;
}

export function summarizeCoverage(results: CoverageReceiptResult[]): CoverageReport {
  const flaggedCount = results.filter((r) => r.flagged).length;
  const dormantCount = results.filter((r) => r.state === "dormant").length;
  return { results, flaggedCount, dormantCount, allCovered: flaggedCount === 0 };
}
