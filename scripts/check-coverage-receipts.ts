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
 * Read-only: reads `<state dir>/projects/<key>/*-calibration.jsonl` plus the
 * guard registries' DECLARED detector names (mt#3742 — a never-fired detector
 * has no file, so the disk scan alone cannot see it) and reports. It writes no
 * state, so (unlike the canary runner) it needs no temp-dir isolation.
 *
 * mt#4784: that first path used to read `.minsky/` in the REPO tree, which is
 * where these streams lived before mt#4748 moved them. Both the roster and the
 * records now resolve through `resolveCalibrationLogDir`; see its docblock in
 * `.minsky/hooks/coverage-receipt.ts` for why they must not be derived twice.
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
 * covers; mt#4204 added `retired` — documented here because there is no schema
 * version and the textual `Checked:` count is derived from the same set):
 *
 *   {
 *     results: CoverageReceiptResult[],  // one per CHECKED detector
 *     flaggedCount: number,
 *     dormantCount: number,
 *     allCovered: boolean,
 *     unmapped: string[],   // logs no guard declares — a defect to fix
 *     nonGuard: string[],   // logs with a declared NON-guard producer
 *     retired: string[]     // logs whose producer was deleted on purpose
 *   }
 *
 * `results` covers the UNION of the DECLARED detectors and the calibration
 * logs discovered on disk, MINUS `nonGuard` and `retired` (mt#3742 widened this from
 * discovered-only; see `resolveDetectorsToCheck`) — a
 * non-guard producer has no entry point to instrument, so a coverage verdict
 * on it would be a claim about something that does not exist. `Checked:` in
 * the textual summary is `results.length` and therefore excludes them too;
 * they are printed on their own `[NON-GUARD]` line. Consumers were audited
 * when this changed (mt#3519): the only ones are this file's own textual
 * output, `.minsky/skills/calibration-review/SKILL.md` Step 1b, and
 * `docs/architecture/evaluation-loop-fire-log.md` — no CI job or script parses
 * the JSON. Anything added later should read `results` + `nonGuard` together
 * if it needs the full checked set.
 *
 * @see .minsky/hooks/coverage-receipt.ts — core check logic this wraps
 * @see scripts/run-guard-canaries.ts — the synthetic-input sibling (mt#2889)
 * @see .claude/skills/calibration-review/SKILL.md — the cadence that runs this
 * @see docs/architecture/evaluation-loop-fire-log.md
 */

const {
  checkDetectorCoverage,
  summarizeCoverage,
  formatCoverageResult,
  countInvocationsPerLog,
  resolveDetectorsToCheck,
  resolveCalibrationLogDir,
  discoverCalibrationDetectors,
  DEFAULT_COVERAGE_WINDOW_DAYS,
} = await import("../.minsky/hooks/coverage-receipt");
const { readFireLogEntries } = await import("../.minsky/hooks/fire-log");
// mt#3716: the declaration-reading logic (GUARD_REGISTRY + STANDALONE_GUARD_CANARIES union,
// plus the non-guard-producer enumeration) moved to `./lib/calibration-log-declarations` so it
// is the ONE shared accessor mt#3742 SC5 requires — the calibration-sweep derivation
// (`src/domain/calibration/calibration-sweep.ts`'s `deriveCalibrationLogEntries`) consumes the
// same functions rather than re-deriving the union a second time.
const {
  buildCalibrationLogToGuards,
  NON_GUARD_CALIBRATION_PRODUCERS,
  RETIRED_CALIBRATION_PRODUCERS,
} = await import("./lib/calibration-log-declarations");

import type { InvocationEvidence } from "../.minsky/hooks/coverage-receipt";

/**
 * The `--json` payload, as ONE type both emission paths satisfy.
 *
 * There are two exits that write JSON — the empty-telemetry short-circuit and the normal path —
 * and a consumer must not see a different schema depending on which fired. That was a comment
 * before mt#4204 and is a type now: adding a field to the payload without adding it to BOTH
 * call sites is a compile error rather than a divergence somebody notices in review.
 */
interface CoverageJsonPayload {
  readonly results: readonly unknown[];
  readonly flaggedCount: number;
  readonly dormantCount: number;
  readonly allCovered: boolean;
  /** Logs no producer declares — a real defect to fix. */
  readonly unmapped: readonly string[];
  /** Logs with a declared NON-guard producer (mt#3519). */
  readonly nonGuard: readonly string[];
  /** Logs whose producer was retired on purpose (mt#4204). */
  readonly retired: readonly string[];
}

function renderJson(payload: CoverageJsonPayload): string {
  return `${JSON.stringify(payload, null, 2)}\n`;
}
const MS_PER_DAY = 24 * 60 * 60 * 1000;

// `NON_GUARD_CALIBRATION_PRODUCERS` and `buildCalibrationLogToGuards` are imported above from
// `./lib/calibration-log-declarations` (mt#3716) — see that module for the full doc comment.

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
  const logToGuards = buildCalibrationLogToGuards();
  // mt#3742: enumerate the DECLARED detectors as well as the on-disk logs. A
  // detector that has never fired writes no calibration file, so a disk-only
  // scan cannot see it — and "no records at all" is the very symptom this gate
  // exists to catch. An explicit CLI detector list still wins: that is the
  // deliberate-override path.
  const discovered = discoverCalibrationDetectors(cwd);
  const detectors =
    requested.length > 0 ? requested : resolveDetectorsToCheck(logToGuards.keys(), discovered);

  // The "nothing to check" exit gates on TELEMETRY PRESENCE, not on the
  // detector set (mt#3742). Calibration logs live outside the repo (mt#4748),
  // so a machine that has never run a guard has none — and since the union
  // above is never empty while any guard declares a log, gating on `detectors`
  // would turn every fresh checkout into a wall of FLAGGED. Absence of ALL
  // telemetry means the sweep has nothing to reason from; absence of ONE
  // declared detector's log is the real finding.
  //
  // mt#4784: this gate is why the stale-roster bug was silent rather than
  // loud. `discovered` came from the repo dir, so in any workspace without
  // leftover pre-migration files it was empty and this branch swallowed the
  // whole sweep — exit 0, no findings, indistinguishable from a clean pass.
  if (requested.length === 0 && discovered.length === 0) {
    if (json) {
      // Same key set as the populated path below — a JSON consumer must not
      // see a different schema just because the repo has no calibration logs.
      // Both paths go through `renderJson` so that invariant is structural
      // rather than remembered: mt#4204 added `retired` to the populated path
      // only, and the two schemas silently diverged until review caught it.
      process.stdout.write(
        renderJson({
          results: [],
          flaggedCount: 0,
          dormantCount: 0,
          allCovered: true,
          unmapped: [],
          nonGuard: [],
          retired: [],
        })
      );
    } else {
      console.log(
        `No calibration logs found under ${resolveCalibrationLogDir(cwd)} — nothing to check.`
      );
    }
    process.exit(0);
  }

  const now = new Date();
  const invocations = buildInvocationEvidence(logToGuards, windowDays, now);

  // A detector whose log maps to no guard gets NO invocation evidence, which
  // means it can only ever come back flagged. Report those by name rather than
  // letting them read as genuine dead entry points (SC5).
  //
  // mt#3519: a log with a DECLARED non-guard producer is not that defect — it
  // has no guard by construction, so it is reported in its own category rather
  // than as a missing declaration nobody can add.
  const nonGuard = detectors.filter((d) => d in NON_GUARD_CALIBRATION_PRODUCERS);

  // mt#4204: a RETIRED producer is the same class as a non-guard one — there is no entry point
  // to instrument, so `FLAGGED` ("no evidence the entry point ran") is a false claim about it
  // rather than a weak one. Excluded and reported separately, exactly like `nonGuard`. Without
  // this a deliberately-retained log reads as a dead detector on every run, forever (mt#4197).
  const retired = detectors.filter((d) => d in RETIRED_CALIBRATION_PRODUCERS);

  const unmapped = detectors.filter(
    (d) =>
      !logToGuards.has(d) &&
      !(d in NON_GUARD_CALIBRATION_PRODUCERS) &&
      !(d in RETIRED_CALIBRATION_PRODUCERS)
  );

  // A non-guard producer is EXCLUDED from the coverage results, not merely
  // annotated alongside them: `FLAGGED` asserts "no evidence the entry point
  // ran", which for a log with no entry point to instrument is a false claim,
  // not a weak one. It is reported in its own category below instead.
  const checked = detectors.filter(
    (d) => !(d in NON_GUARD_CALIBRATION_PRODUCERS) && !(d in RETIRED_CALIBRATION_PRODUCERS)
  );

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
    process.stdout.write(renderJson({ ...report, unmapped, nonGuard, retired }));
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
    for (const name of retired) {
      console.log(
        `[RETIRED] ${name}: ${RETIRED_CALIBRATION_PRODUCERS[name]} — producer deleted on purpose, so there is no entry point to have invocation evidence for; the log is kept as history (mt#4204).`
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
