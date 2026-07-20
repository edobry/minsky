#!/usr/bin/env bun
/**
 * Coverage-receipt gate CLI — mt#2554 (RFC mt#2263 Phase 1, SC#5).
 *
 * The LIVE-input complement to `run-guard-canaries.ts`. The canary runner
 * proves a detector's DECISION LOGIC still works (synthetic input); this
 * script proves each detector actually FIRES on real input by requiring
 * >=1 `source:"live"` calibration entry inside a rolling window. A detector
 * with zero live fires in the window is FLAGGED — "shipped is not firing"
 * (memory fc8c66e7 / the mt#2057 9-day dead-hook incident).
 *
 * Read-only: reads `.minsky/*-calibration.jsonl` and reports. It writes no
 * state, so (unlike the canary runner) it needs no temp-dir isolation.
 *
 * Usage:
 *   bun scripts/check-coverage-receipts.ts                       # all detectors, 7d window
 *   bun scripts/check-coverage-receipts.ts retrospective-trigger # one named detector
 *   bun scripts/check-coverage-receipts.ts --window-days 14      # widen the window
 *   bun scripts/check-coverage-receipts.ts --json                # structured report
 *
 * Exit code: 0 = every checked detector has a live coverage receipt in the
 * window; 1 = at least one detector is flagged (surface for review at the
 * next calibration review — this is a review-surfacing signal, NOT a merge
 * gate).
 *
 * @see .minsky/hooks/coverage-receipt.ts — core check logic this wraps
 * @see scripts/run-guard-canaries.ts — the synthetic-input sibling (mt#2889)
 * @see .claude/skills/calibration-review/SKILL.md — the cadence that runs this
 * @see docs/architecture/evaluation-loop-fire-log.md
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";

const { findRepoRoot } = await import("../.minsky/hooks/types");
const {
  checkDetectorCoverage,
  summarizeCoverage,
  formatCoverageResult,
  DEFAULT_COVERAGE_WINDOW_DAYS,
} = await import("../.minsky/hooks/coverage-receipt");

const CALIBRATION_SUFFIX = "-calibration.jsonl";

/** Discover every `<name>-calibration.jsonl` under the repo's `.minsky/` dir. */
function discoverDetectors(cwd: string): string[] {
  const dir = join(findRepoRoot(cwd), ".minsky");
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => n.endsWith(CALIBRATION_SUFFIX))
    .map((n) => n.slice(0, -CALIBRATION_SUFFIX.length))
    .sort();
}

function parseArgs(argv: string[]): { detectors: string[]; windowDays: number; json: boolean } {
  const json = argv.includes("--json");
  let windowDays = DEFAULT_COVERAGE_WINDOW_DAYS;
  const detectors: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") continue;
    if (a === "--window-days") {
      const v = Number(argv[++i]);
      if (Number.isFinite(v) && v > 0) windowDays = v;
      continue;
    }
    if (a.startsWith("--")) continue;
    detectors.push(a);
  }
  return { detectors, windowDays, json };
}

async function main(): Promise<void> {
  const { detectors: requested, windowDays, json } = parseArgs(process.argv.slice(2));
  const cwd = process.cwd();
  const detectors = requested.length > 0 ? requested : discoverDetectors(cwd);

  if (detectors.length === 0) {
    if (json) {
      process.stdout.write(
        `${JSON.stringify({ results: [], flaggedCount: 0, allCovered: true }, null, 2)}\n`
      );
    } else {
      console.log("No calibration logs found under .minsky/ — nothing to check.");
    }
    process.exit(0);
  }

  const results = detectors.map((name) => checkDetectorCoverage(name, { cwd, windowDays }));
  const report = summarizeCoverage(results);

  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    for (const r of report.results) {
      console.log(formatCoverageResult(r));
    }
    console.log("");
    console.log(
      `Checked: ${results.length}  Covered: ${results.length - report.flaggedCount}  Flagged: ${report.flaggedCount}  (window ${windowDays}d)`
    );
    console.log(
      report.allCovered
        ? "PASS — every checked detector has a live coverage receipt in the window."
        : "FLAGGED — one or more detectors have no live fire in the window; surface at the next calibration review."
    );
  }

  process.exit(report.allCovered ? 0 : 1);
}

await main();
