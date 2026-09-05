#!/usr/bin/env bun
/**
 * mt#4970 — verify the log-only exclusion against the LIVE `untaken-action`
 * corpus, and make the pre/post-declaration boundary explicit.
 *
 * ## What this answers, and why a unit test cannot
 *
 * The exclusion's value is a claim about a real window: `untaken-action`'s
 * 2026-09-04 review window reported 120 injected fires when 23 reached the
 * agent. Whether the shipped predicate reproduces that split depends on how
 * authors' records actually look, which only the corpus can say.
 *
 * ## The boundary this script exists to keep honest
 *
 * The records already on disk were written BEFORE the writer declared
 * `logOnly`, and the sweep deliberately treats an absent marker as "not
 * declared" — counted as injected — so that shipping this change cannot
 * retroactively reclassify history and shift an FP rate under a reader
 * (mt#4970 AT4).
 *
 * So there are two true statements and this script prints both:
 *
 *  - **As-is**, the historical window still reports its original count. That is
 *    AT4 working, not the fix failing.
 *  - **With the declaration applied** — each match marked exactly as
 *    `toCalibrationMatches` in `turn-end-untaken-action-scan.ts` now marks it —
 *    the same window reports the corrected split. That is what every window
 *    written after this change will report.
 *
 * Usage:
 *   bun scripts/verify-log-only-exclusion.ts [--log <path>] [--window <n>]
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { calibrationLogPath } from "../.minsky/hooks/dispatcher";
import {
  computeLogResult,
  type CalibrationLogEntry,
} from "../src/domain/calibration/calibration-sweep";

const REPO_ROOT = resolve(import.meta.dir, "..");
const GUARD = "untaken-action";

/**
 * The families `turn-end-untaken-action-scan.ts` declares LOG_ONLY.
 *
 * IMPORTED from the writer, not restated (PR #3644 R1). This script simulates
 * the writer's declaration over records written before it existed, so a local
 * copy would be a second place that has to agree about the family set forever —
 * the exact mt#4465 drift hazard this task's SC2 exists to remove, reintroduced
 * in the tool that verifies it.
 */
import { LOG_ONLY_FAMILIES } from "../.minsky/hooks/turn-end-untaken-action-scan";

/** The 2026-09-04 review window: watermark 0 → 190. */
const DEFAULT_WINDOW = 190;

function parseArgs(): { logPath: string; window: number } {
  const argv = process.argv.slice(2);
  const flag = (name: string): string | null => {
    const i = argv.indexOf(name);
    if (i === -1) return null;
    return argv[i + 1] ?? null;
  };
  const rawWindow = flag("--window");
  return {
    logPath: flag("--log") ?? calibrationLogPath(GUARD, { fallbackCwd: REPO_ROOT }),
    window: rawWindow === null ? DEFAULT_WINDOW : Number(rawWindow),
  };
}

/** Mark each match whose family is log-only, exactly as the writer now does. */
function applyDeclaration(line: string): string {
  const raw = JSON.parse(line) as Record<string, unknown>;
  if (!Array.isArray(raw["matches"])) return line;
  raw["matches"] = (raw["matches"] as Array<Record<string, unknown>>).map((m) => ({
    ...m,
    ...(typeof m["family"] === "string" && LOG_ONLY_FAMILIES.has(m["family"])
      ? { logOnly: true }
      : {}),
  }));
  return JSON.stringify(raw);
}

function main(): void {
  const { logPath, window } = parseArgs();
  if (!existsSync(logPath)) {
    console.error(`SKIP: calibration log not found: ${logPath}`);
    process.exit(0);
  }

  const allLines = readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean);
  const windowLines = allLines.slice(0, Math.min(window, allLines.length));
  if (windowLines.length === 0) {
    console.error(`FAIL: log ${logPath} has no records to replay.`);
    process.exit(2);
  }

  const entry: CalibrationLogEntry = { path: logPath, name: GUARD, kind: GUARD };
  const asIs = computeLogResult(entry, windowLines.join("\n"), true, undefined);
  const declared = computeLogResult(
    entry,
    windowLines.map(applyDeclaration).join("\n"),
    true,
    undefined
  );

  console.log(`mt#4970 — log-only exclusion over ${GUARD}`);
  console.log(`  log:    ${logPath}`);
  console.log(`  window: first ${windowLines.length} of ${allLines.length} records\n`);

  const row = (label: string, r: typeof asIs): void => {
    console.log(
      `  ${label.padEnd(26)} injected=${String(r.injectedFiresSinceLastReview).padStart(4)}` +
        `  logOnly=${String(r.logOnlyFamilySinceLastReview).padStart(4)}` +
        `  suppressed=${String(r.suppressedSinceLastReview).padStart(4)}` +
        `  evalOnly=${String(r.evaluatedOnlySinceLastReview).padStart(4)}`
    );
  };
  row("as-is (pre-declaration)", asIs);
  row("with declaration applied", declared);

  // ---- Controls: each assertion below can fail, and says what it means ----

  if (asIs.logOnlyFamilySinceLastReview !== 0) {
    console.error(
      `\nFAIL (AT4): records on disk carry no \`logOnly\` marker, so the as-is pass must report ` +
        `0 log-only — got ${asIs.logOnlyFamilySinceLastReview}. An absent marker is being read as a ` +
        `declaration, which would retroactively reclassify history.`
    );
    process.exit(1);
  }

  if (declared.logOnlyFamilySinceLastReview === 0) {
    console.error(
      `\nFAIL (control): applying the declaration changed nothing. Either the corpus has no ` +
        `log-only-family matches or the marker is not reaching the predicate — either way this ` +
        `run says nothing about the exclusion.`
    );
    process.exit(1);
  }

  const moved = asIs.injectedFiresSinceLastReview - declared.injectedFiresSinceLastReview;
  if (moved !== declared.logOnlyFamilySinceLastReview) {
    console.error(
      `\nFAIL: ${moved} records left the injected column but ${declared.logOnlyFamilySinceLastReview} ` +
        `arrived in the log-only column. The two must balance — a record may not be dropped from ` +
        `both or counted in both.`
    );
    process.exit(1);
  }

  console.log(
    `\nOK: ${moved} records move from injected to log-only once the writer's declaration is ` +
      `present (${asIs.injectedFiresSinceLastReview} -> ${declared.injectedFiresSinceLastReview}); ` +
      `the columns balance, and the as-is pass is unchanged at ${asIs.injectedFiresSinceLastReview} ` +
      `because an absent marker is not a declaration (AT4).`
  );
}

if (import.meta.main) main();
