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
 * `--json` output shape (mt#3519 added `nonGuard` and changed what `results`
 * covers — documented here because there is no schema version and the textual
 * `Checked:` count is derived from the same set):
 *
 *   {
 *     results: CoverageReceiptResult[],  // one per CHECKED detector
 *     flaggedCount: number,
 *     dormantCount: number,
 *     allCovered: boolean,
 *     unmapped: string[],   // logs no guard declares — a defect to fix
 *     nonGuard: string[]    // logs with a declared NON-guard producer
 *   }
 *
 * `results` covers the discovered calibration logs MINUS `nonGuard` — a
 * non-guard producer has no entry point to instrument, so a coverage verdict
 * on it would be a claim about something that does not exist. `Checked:` in
 * the textual summary is `results.length` and therefore excludes them too;
 * they are printed on their own `[NON-GUARD]` line. Consumers were audited
 * when this changed (mt#3519): the only ones are this file's own textual
 * output, `.minsky/skills/calibration-review/SKILL.md` Step 1b, and
 * `docs/architecture/evaluation-loop-fire-log.md` — no CI job or script parses
 * the JSON. Anything added later should read `results` + `nonGuard` together
 * if it needs the full discovered set.
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
  countInvocationsPerLog,
  DEFAULT_COVERAGE_WINDOW_DAYS,
} = await import("../.minsky/hooks/coverage-receipt");
const { readFireLogEntries } = await import("../.minsky/hooks/fire-log");
const { GUARD_REGISTRY } = await import("../.minsky/hooks/registry");
const { STANDALONE_GUARD_CANARIES } = await import("./lib/standalone-guard-canaries");

import type { InvocationEvidence } from "../.minsky/hooks/coverage-receipt";

const CALIBRATION_SUFFIX = "-calibration.jsonl";
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Map each calibration-log name to the guard name(s) that write it (mt#3502).
 *
 * Derived from declarations, never from string matching. The two differ for
 * real detectors — calibration log `untaken-action` is guard
 * `turn-end-untaken-action-scan`, `retrospective-trigger` is
 * `turn-end-retro-scan` — and a name-matching first pass at this reported both
 * as having zero invocations when they had 874 and 1531. Several logs are
 * written by more than one guard (`operator-deferral`,
 * `retrospective-trigger`), so the value is a list.
 *
 * `GUARD_REGISTRY`'s entries hold `module` as a lazy `() => import(...)`, so
 * importing the registry for its metadata does not load any guard module.
 */
function buildCalibrationLogToGuards(): Map<string, string[]> {
  const map = new Map<string, string[]>();
  const add = (log: string, guard: string): void => {
    const existing = map.get(log);
    if (existing) existing.push(guard);
    else map.set(log, [guard]);
  };
  // mt#3519: a declaration may name one log or several — the execution-evidence
  // merge gate writes two. The read side was always many-to-many; this makes
  // the write side match.
  const addAll = (logs: string | string[], guard: string): void => {
    for (const log of Array.isArray(logs) ? logs : [logs]) add(log, guard);
  };
  for (const reg of GUARD_REGISTRY) {
    if (reg.calibrationLog) addAll(reg.calibrationLog, reg.name);
  }
  // Standalone guards are not in GUARD_REGISTRY; their canary declaration
  // carries the same join key.
  for (const canary of STANDALONE_GUARD_CANARIES) {
    if (canary.calibrationLog) addAll(canary.calibrationLog, canary.guardName);
  }
  return map;
}

/**
 * Calibration logs written by something that is NOT a guard (mt#3519).
 *
 * `ask-form-lint` is the standing case: the log is written by
 * `src/adapters/shared/commands/ask-form-lint-calibration.ts` on the
 * `asks_create` command path, not by any hook. It has no guard name, no
 * dispatcher invocation, and no canary — so neither declaration mechanism can
 * reach it, and it is NOT the "no guard declares this" defect that the
 * `Unmapped` line reports.
 *
 * Deliberately NOT solved by recording fire-log entries from the command path:
 * the fire log is the GUARD invocation log (`guardName` is its identity
 * field), and `src/` is bundled into the deployed MCP server, which must not
 * import `.minsky/hooks/`. Declaring the producer keeps the signal honest —
 * these are reported in their own category and never counted as `covered`,
 * which is what the coverage receipt would otherwise imply.
 *
 * A log listed here is EXEMPT from the invocation-evidence join, not from
 * review: its records still feed the calibration sweep exactly as before.
 */
const NON_GUARD_CALIBRATION_PRODUCERS: Record<string, string> = {
  "ask-form-lint":
    "src/adapters/shared/commands/ask-form-lint-calibration.ts (asks_create command path, not a hook)",
};

/**
 * Count fire-log invocations per calibration-log name inside the window.
 *
 * Reads the fire log ONCE for the whole run rather than per detector — it is
 * an append-only log of every guard invocation and is routinely tens of MB.
 */
function buildInvocationEvidence(
  logToGuards: Map<string, string[]>,
  windowDays: number,
  now: Date
): Map<string, InvocationEvidence> {
  // The counting itself lives in `coverage-receipt.ts` (mt#3519) so the
  // many-to-many join is testable; this wrapper supplies the I/O and window.
  return countInvocationsPerLog(
    readFireLogEntries(),
    logToGuards,
    now.getTime() - windowDays * MS_PER_DAY,
    now.getTime()
  );
}

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
    if (a === undefined) continue;
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
      // Same key set as the populated path below — a JSON consumer must not
      // see a different schema just because the repo has no calibration logs.
      process.stdout.write(
        `${JSON.stringify(
          {
            results: [],
            flaggedCount: 0,
            dormantCount: 0,
            allCovered: true,
            unmapped: [],
            nonGuard: [],
          },
          null,
          2
        )}\n`
      );
    } else {
      console.log("No calibration logs found under .minsky/ — nothing to check.");
    }
    process.exit(0);
  }

  const now = new Date();
  const logToGuards = buildCalibrationLogToGuards();
  const invocations = buildInvocationEvidence(logToGuards, windowDays, now);

  // A detector whose log maps to no guard gets NO invocation evidence, which
  // means it can only ever come back flagged. Report those by name rather than
  // letting them read as genuine dead entry points (SC5).
  //
  // mt#3519: a log with a DECLARED non-guard producer is not that defect — it
  // has no guard by construction, so it is reported in its own category rather
  // than as a missing declaration nobody can add.
  const nonGuard = detectors.filter((d) => d in NON_GUARD_CALIBRATION_PRODUCERS);
  const unmapped = detectors.filter(
    (d) => !logToGuards.has(d) && !(d in NON_GUARD_CALIBRATION_PRODUCERS)
  );

  // A non-guard producer is EXCLUDED from the coverage results, not merely
  // annotated alongside them: `FLAGGED` asserts "no evidence the entry point
  // ran", which for a log with no entry point to instrument is a false claim,
  // not a weak one. It is reported in its own category below instead.
  const checked = detectors.filter((d) => !(d in NON_GUARD_CALIBRATION_PRODUCERS));

  const results = checked.map((name) =>
    checkDetectorCoverage(name, {
      cwd,
      windowDays,
      now: () => now,
      invocations: invocations.get(name),
    })
  );
  const report = summarizeCoverage(results);

  if (json) {
    process.stdout.write(`${JSON.stringify({ ...report, unmapped, nonGuard }, null, 2)}\n`);
  } else {
    for (const r of report.results) {
      console.log(formatCoverageResult(r));
    }
    console.log("");
    if (unmapped.length > 0) {
      console.log(
        `Unmapped (no guard declares this calibration log, so no invocation evidence is available): ${unmapped.join(", ")}`
      );
    }
    for (const name of nonGuard) {
      console.log(
        `[NON-GUARD] ${name}: written by ${NON_GUARD_CALIBRATION_PRODUCERS[name]} — no guard invocation evidence exists by construction (mt#3519).`
      );
    }
    const covered = results.length - report.flaggedCount - report.dormantCount;
    console.log(
      `Checked: ${results.length}  Covered: ${covered}  Dormant: ${report.dormantCount}  Flagged: ${report.flaggedCount}  (window ${windowDays}d)`
    );
    console.log(
      report.allCovered
        ? "PASS — every checked detector either has a live coverage receipt or is provably running."
        : "FLAGGED — one or more detectors show no records AND no invocations; surface at the next calibration review."
    );
  }

  process.exit(report.allCovered ? 0 : 1);
}

await main();
