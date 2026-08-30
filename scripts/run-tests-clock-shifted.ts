#!/usr/bin/env bun
/**
 * Run the test suite with the wall clock moved forward, to catch time bombs before they detonate
 * (mt#4726).
 *
 * A fixture pinned to an absolute instant and compared against a real-clock window passes until
 * the wall clock crosses it, then reddens CI with no warning. Three have done exactly that
 * (mt#2491, mt#3818, mt#4721). Running the suite `N` days in the future makes such a fixture fail
 * TONIGHT, in a non-blocking scheduled job, with `N` days of lead time.
 *
 * ## Why the horizon is 30 days
 *
 * From the observed FUSE — the interval between a fixture being armed and detonating — not from
 * how often detonations happen. mt#2491's fuse was 1 day, mt#3818's 14, mt#4721's 7. The longest
 * observed is 14; +30d is roughly twice it. (Inter-arrival is the wrong quantity: a nightly at any
 * positive horizon catches every bomb eventually, so the horizon buys LEAD TIME, not coverage.)
 *
 * ## Exit codes are three-valued on purpose
 *
 * - `0` — the shifted suite passed. The corpus is clean at this horizon.
 * - `1` — the shifted suite FAILED. Read the named tests; each is a bomb or an exemption candidate.
 * - `2` — the RUN ITSELF is broken (preflight failed, exemption list malformed, zero files found).
 *
 * Collapsing 2 into 0 would be the whole mechanism's failure mode: this is a default-empty probe,
 * so a shim that silently stopped working produces an empty failure list — byte-identical to a
 * clean corpus. Nothing downstream can tell those apart, which is why the preflight below runs
 * before every suite invocation and refuses to continue (mem#704).
 *
 * ## Scope
 *
 * Covers `ROOTS` plus `./.minsky/hooks`. The hooks tree is deliberately outside the pre-push
 * runner's `ROOTS` for latency, but it is where mt#4721's bomb actually lived, so a nightly that
 * skipped it would miss this task's own originating instance. `src/mcp/**` stays excluded, via
 * `discoverTestFiles`' own exclusion list — see CLAUDE.md on the Bun truncated-run defect.
 */

import { appendFileSync, statSync } from "node:fs";
import { evaluateBunTestSummary } from "./run-tests-gated";
import { discoverTestFiles, GRAPH_ONLY_ROOTS, ROOTS, toBunTestArgs } from "./run-tests-main";
import {
  FULL_SUITE_PER_TEST_TIMEOUT_MS,
  formatWatchdogTimeout,
  resolveWatchdogBudgetMs,
  spawnWithWatchdog,
  WATCHDOG_BUDGETS_MS,
} from "./spawn-with-watchdog";
import { CLOCK_SHIFT_ENV_VAR, describeOffset } from "../tests/clock-shift";
import { assertExemptionsWellFormed, isClockShiftExempt } from "../tests/clock-shift-exemptions";

const PRELOAD = "./tests/setup.ts";
const DEFAULT_SHIFT_DAYS = 30;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Slack on top of the measured spawn window, before the preflight calls the horizon wrong.
 *
 * This was 5 minutes, sized to cover process startup on a cold CI runner. That reasoning was wrong
 * by orders of magnitude (PR #3487 R1): the bounds below are `realNowBefore` and `realNowAfter`,
 * which already BRACKET the instant the probe read its clock, so startup is accounted for by
 * construction and nothing is left for a fixed constant to cover except clock-read jitter.
 *
 * Seconds therefore suffice, and the tighter bound is strictly better: at 5 minutes the check
 * could only catch a horizon that was ABSENT or wildly wrong, while at 5 seconds it also catches
 * one that is merely slightly wrong — a unit slip, a rounding bug, a stale offset.
 */
const PREFLIGHT_JITTER_MS = 5_000;

const PROBE_FLAG = "--probe";
const PROBE_MARKER = "__MT4726_CLOCK_PROBE__";

interface ProbePayload {
  /** `Date.now()` under the shift. */
  readonly nowMs: number;
  /** Argless `new Date()` under the shift — a SEPARATE code path from `Date.now()`. */
  readonly newDateMs: number;
  readonly iso: string;
  /** `new Date(0)`, which must stay the epoch: explicit timestamps are never shifted. */
  readonly epochMs: number;
  /** A Date built inside native code must still be `instanceof Date`. */
  readonly nativeInstanceOfDate: boolean;
}

/**
 * Probe mode: report what the clock actually looks like inside a preloaded process.
 *
 * Spawned by {@link preflight} as `bun --preload <setup> <this file> --probe`, so it observes the
 * exact seam the suite will run under rather than a reconstruction of it.
 */
function runProbe(): void {
  const stat = statSync(process.cwd());
  const payload: ProbePayload = {
    nowMs: Date.now(),
    newDateMs: new Date().getTime(),
    iso: new Date().toISOString(),
    epochMs: new Date(0).getTime(),
    nativeInstanceOfDate: stat.mtime instanceof Date,
  };
  // `process.stdout.write`, never `console.log`. The preload this runs under REPLACES every
  // console method with a no-op mock (tests/setup.ts), so a console-based probe emits nothing and
  // reads exactly like a probe that failed to run — a silenced channel whose emptiness looks like
  // data (mem#704). Found by running this probe in the foreground before wiring it in.
  process.stdout.write(`${PROBE_MARKER}${JSON.stringify(payload)}\n`);
}

function parseShiftDays(argv: string[]): number {
  const flag = argv.find((arg) => arg.startsWith("--days="));
  if (flag === undefined) {
    return DEFAULT_SHIFT_DAYS;
  }
  const value = Number(flag.slice("--days=".length));
  if (!Number.isFinite(value) || value === 0) {
    // `fail()`, not `throw`: a bad horizon means the RUN is broken, which is exit 2. An uncaught
    // throw exits 1, and 1 is reserved for "a real fixture is going to expire" — the one reading a
    // CI consumer must not confuse with a misconfigured invocation.
    fail(
      `--days must be a non-zero finite number, got ${JSON.stringify(flag)}. A zero horizon runs ` +
        "the suite against the real clock, which this job has no way to distinguish from a broken " +
        "shim."
    );
  }
  return value;
}

function fail(message: string): never {
  process.stderr.write(`\n::error::run-tests-clock-shifted: ${message}\n`);
  process.exit(2);
}

/**
 * Prove the shift is actually in effect BEFORE running anything (SC6).
 *
 * This is the standing control. AT3's planted fixture proves the mechanism works once, by hand, at
 * build time; nothing then re-verifies it, so a shim broken by a later refactor would yield a
 * nightly that stays green forever while measuring nothing.
 */
async function preflight(shiftDays: number, thisFile: string): Promise<void> {
  const offsetMs = Math.trunc(shiftDays * MS_PER_DAY);
  const realNowBefore = Date.now();

  const result = await spawnWithWatchdog(["bun", "--preload", PRELOAD, thisFile, PROBE_FLAG], {
    budgetMs: 120_000,
    env: { [CLOCK_SHIFT_ENV_VAR]: String(shiftDays) },
  });
  const realNowAfter = Date.now();

  if (result.exitCode !== 0) {
    fail(`clock probe exited ${result.exitCode}. stderr:\n${result.stderr}`);
  }

  const line = result.stdout.split("\n").find((l) => l.includes(PROBE_MARKER));
  if (line === undefined) {
    fail(
      "clock probe produced no marker line — it did not run, or its output was swallowed. " +
        `stdout:\n${result.stdout}`
    );
  }

  let payload: ProbePayload;
  try {
    payload = JSON.parse(line.slice(line.indexOf(PROBE_MARKER) + PROBE_MARKER.length));
  } catch (error) {
    fail(`clock probe emitted unparseable JSON: ${String(error)}`);
  }

  if (payload.epochMs !== 0) {
    fail(
      `new Date(0) read as ${payload.epochMs}, not 0 — the shim is shifting EXPLICIT timestamps, ` +
        "not just the clock. Every date-literal fixture in the suite would be corrupted."
    );
  }

  if (payload.nativeInstanceOfDate !== true) {
    fail(
      "a natively constructed Date is no longer `instanceof Date` — the shim replaced the global " +
        "constructor in a way that breaks identity (the failure mode the Proxy in " +
        "tests/clock-shift.ts exists to avoid). Every `toBeInstanceOf(Date)` assertion in the " +
        "suite would fail for a reason unrelated to time."
    );
  }

  // Both clock-reading forms must have moved, and they are separate code paths in the shim.
  for (const [label, observed] of [
    ["Date.now()", payload.nowMs],
    ["new Date()", payload.newDateMs],
  ] as const) {
    const lower = realNowBefore + offsetMs - PREFLIGHT_JITTER_MS;
    const upper = realNowAfter + offsetMs + PREFLIGHT_JITTER_MS;
    if (observed < lower || observed > upper) {
      fail(
        `${label} returned ${new Date(observed).toISOString()}, which is not ${describeOffset(
          offsetMs
        )} from the real clock (${new Date(realNowBefore).toISOString()}). The shift is not in ` +
          `effect, so a green run would mean nothing. Check ${CLOCK_SHIFT_ENV_VAR} reaches the ` +
          `preload at ${PRELOAD}.`
      );
    }
  }

  process.stdout.write(
    `✅ preflight: ${describeOffset(offsetMs)} is in effect — the suite will see ${payload.iso}\n`
  );
}

/**
 * Mirror the verdict into GitHub's job summary when running under Actions.
 *
 * stdout already names the horizon, but that lives in the raw job log, which a reader has to open
 * and scroll. The summary is what shows on the run page directly, so the horizon is legible
 * without a rerun — SC3's "actionable without a rerun", applied to the surface a human lands on
 * (PR #3487 R1). A no-op locally, and never fatal: this is a reporting side channel, and failing
 * a clean run because a summary file could not be appended to would be strictly worse than
 * losing the summary.
 */
function writeJobSummary(lines: string[]): void {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath === undefined || summaryPath.trim() === "") {
    return;
  }
  try {
    appendFileSync(summaryPath, `${lines.join("\n")}\n`);
  } catch (error) {
    process.stderr.write(
      `run-tests-clock-shifted: could not write the job summary (continuing): ${String(error)}\n`
    );
  }
}

interface PhaseResult {
  readonly name: string;
  readonly ok: boolean;
  readonly reason: string;
  readonly fileCount: number;
}

async function runPhase(
  name: string,
  files: string[],
  shiftDays: number,
  budgetMs: number
): Promise<PhaseResult> {
  process.stdout.write(`\n── ${name}: ${files.length} file(s) at +${shiftDays}d ──\n`);

  const result = await spawnWithWatchdog(
    [
      "bun",
      "test",
      "--preload",
      PRELOAD,
      `--timeout=${FULL_SUITE_PER_TEST_TIMEOUT_MS}`,
      ...toBunTestArgs(files),
    ],
    { budgetMs, env: { [CLOCK_SHIFT_ENV_VAR]: String(shiftDays) } }
  );

  if (result.timedOut) {
    process.stderr.write(
      `\n::error::${formatWatchdogTimeout(`clock-shifted ${name}`, budgetMs, result)}\n`
    );
    return { name, ok: false, reason: "watchdog timeout", fileCount: files.length };
  }

  // Same fail-closed summary gate the pre-push runner uses: a truncated run exits 0 with no
  // summary at all, which would otherwise read as a clean corpus.
  const verdict = evaluateBunTestSummary(`${result.stdout}\n${result.stderr}`, result.exitCode);
  return { name, ok: verdict.ok, reason: verdict.reason, fileCount: files.length };
}

if (import.meta.main) {
  if (process.argv.includes(PROBE_FLAG)) {
    runProbe();
  } else {
    const shiftDays = parseShiftDays(process.argv.slice(2));

    const exemptionProblems = assertExemptionsWellFormed();
    if (exemptionProblems.length > 0) {
      fail(
        `tests/clock-shift-exemptions.ts is malformed:\n  - ${exemptionProblems.join("\n  - ")}`
      );
    }

    await preflight(shiftDays, import.meta.path);

    const partition = (roots: string[]): { run: string[]; skipped: string[] } => {
      const all = discoverTestFiles(roots);
      return {
        run: all.filter((f) => !isClockShiftExempt(f)),
        skipped: all.filter((f) => isClockShiftExempt(f)),
      };
    };

    const main = partition(ROOTS);
    const hooks = partition(GRAPH_ONLY_ROOTS);
    const skipped = [...main.skipped, ...hooks.skipped];

    if (main.run.length === 0 || hooks.run.length === 0) {
      fail(
        `found ${main.run.length} main and ${hooks.run.length} hook test file(s) — a zero here is ` +
          "a discovery bug, not an empty suite, and would report a false clean run."
      );
    }

    // No silent caps: say what was not run, every time, so a growing exemption list is visible in
    // the job log rather than only in a file nobody opens.
    if (skipped.length > 0) {
      process.stdout.write(`\nExempt from the shifted run (${skipped.length}):\n`);
      for (const file of skipped) {
        process.stdout.write(`  - ${file}\n`);
      }
    }

    const budgetMs = resolveWatchdogBudgetMs(WATCHDOG_BUDGETS_MS.MAIN);
    const results = [
      await runPhase("main suite", main.run, shiftDays, budgetMs),
      await runPhase("hooks suite", hooks.run, shiftDays, budgetMs),
    ];

    const failures = results.filter((r) => !r.ok);
    process.stdout.write("\n────────────────────────────────────────\n");
    process.stdout.write(`Clock-shifted run at ${describeOffset(shiftDays * MS_PER_DAY)}\n`);
    process.stdout.write(
      `Effective date: ${new Date(Date.now() + shiftDays * MS_PER_DAY).toISOString()}\n`
    );
    for (const r of results) {
      process.stdout.write(
        `  ${r.ok ? "PASS" : "FAIL"}  ${r.name} (${r.fileCount} files)` +
          `${r.ok ? "" : ` — ${r.reason}`}\n`
      );
    }

    // This runner is NOT itself shifted — the env var is set only on the children — so the real
    // clock here plus the offset is the date the suite actually saw.
    const effectiveDate = new Date(Date.now() + shiftDays * MS_PER_DAY).toISOString();
    writeJobSummary([
      `## Clock-shifted test run — ${describeOffset(shiftDays * MS_PER_DAY)}`,
      "",
      `**Effective date the suite saw:** ${effectiveDate}`,
      `**Real date:** ${new Date().toISOString()}`,
      "",
      "| Phase | Files | Result |",
      "| --- | --- | --- |",
      ...results.map(
        (r) => `| ${r.name} | ${r.fileCount} | ${r.ok ? "PASS" : `**FAIL** — ${r.reason}`} |`
      ),
      "",
      skipped.length === 0
        ? "No exemptions — every discovered test file ran under the shift."
        : `Exempt (${skipped.length}): ${skipped.map((f) => `\`${f}\``).join(", ")}`,
      "",
      failures.length > 0
        ? `A fixture is pinned to an absolute instant that will detonate within ${shiftDays} days, ` +
          "or the shim cannot represent its world — see `tests/clock-shift-exemptions.ts`."
        : "No wall-clock time bombs found at this horizon.",
    ]);

    if (failures.length > 0) {
      process.stderr.write(
        `\n::error::A test's outcome depends on the clock being ${describeOffset(
          shiftDays * MS_PER_DAY
        )}. Each failure above is either a fixture pinned to an absolute instant that will detonate ` +
          `within ${shiftDays} days, or a case the shim cannot represent — in which case add it to ` +
          "tests/clock-shift-exemptions.ts as a `probe-artifact` with an owning task.\n"
      );
      process.exit(1);
    }

    process.stdout.write("\nNo wall-clock time bombs found at this horizon.\n");
    process.exit(0);
  }
}
