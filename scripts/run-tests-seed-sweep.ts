#!/usr/bin/env bun
/**
 * Run the main test suite under N random seeds and report the tests whose
 * outcome DEPENDS on the order (mt#3575).
 *
 * ## Why this exists rather than a shell loop
 *
 * The obvious form — `for i in $(seq 1 20); do bun test --seed=$i ...; done` —
 * is what this task's own acceptance test said, and it is a probe that CANNOT
 * FAIL. Measured 2026-09-02 on Bun 1.3.14:
 *
 *   - `seed` only takes effect when `[test] randomize` is TRUE in `bunfig.toml`.
 *   - The `--randomize` CLI flag did NOT enable it while bunfig said `false`.
 *
 * So with `randomize = false` — which is exactly the state this task exists to
 * retire — that loop shuffles nothing and reports a clean sweep every time. It
 * is mem#704's shape: a probe that returns the same answer whether or not the
 * system is broken.
 *
 * This script therefore PROVES randomization is live before it reports anything,
 * and exits non-zero if it cannot. That self-check is the point; the seeds are
 * the easy part.
 *
 * ## What it does
 *
 *   1. Self-check — confirm the repo's bunfig enables randomization AND that a
 *      generated probe genuinely produces different orders under different
 *      seeds. If either fails, exit 2: the sweep would be meaningless.
 *   2. Sweep — one full run per seed, collecting each run's failures.
 *   3. Discriminate — for every seed that produced a failure, run that SAME seed
 *      a second time. Same seed means the same order, so a failure that comes
 *      back is caused by the order and one that comes and goes is not.
 *   4. Classify on both axes (`classifySweep`): variance ACROSS seeds separates
 *      order-sensitive tests from the standing red set; repeatability WITHIN a
 *      seed separates genuine order-dependence from load-sensitivity.
 *
 * There is deliberately no declaration-order baseline. Once this task succeeds
 * and `randomize = true`, a seedless run is itself randomized — so a "baseline"
 * would just be another sample wearing a different name — and Bun 1.3.14 offers
 * no `--no-randomize` or config-path flag to force declaration order back.
 * Variance answers the question directly instead of approximating it.
 *
 * Usage:
 *   bun scripts/run-tests-seed-sweep.ts                 # 20 seeds
 *   bun scripts/run-tests-seed-sweep.ts --seeds 5       # fewer, for a spot check
 *   bun scripts/run-tests-seed-sweep.ts --json
 *
 * Exit code: 0 = no order-dependent test found across the seeds run; 1 = at
 * least one test's outcome varied with the order, or a finding could not be
 * classified; 2 = the sweep could not establish that randomization is active (or
 * fewer than 2 seeds were asked for), so it proves nothing and its silence must
 * not be read as a pass.
 *
 * Load-sensitive findings do NOT fail the run: they are mt#3501 / mt#3494's
 * population, out of this task's scope and owned elsewhere. They are printed
 * loudly so a nightly does not silently swallow them.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");

// ── Functional core (pure — unit-tested without spawning a suite) ────────────

/** A `(fail)` line from bun's reporter, reduced to a stable identity. */
export function parseFailureNames(output: string): string[] {
  const names: string[] = [];
  for (const line of output.split("\n")) {
    const match = line.match(/^\(fail\)\s+(.*?)(?:\s+\[[\d.]+m?s\])?\s*$/);
    if (match?.[1] !== undefined) names.push(match[1].trim());
  }
  return names;
}

/** What one seed produced: a run, plus a SECOND run at that same seed when one was taken. */
export interface SeedObservation {
  readonly seed: number;
  readonly failures: readonly string[];
  /**
   * A repeat run at the SAME seed — i.e. the same execution order. Absent when
   * the first run was clean (nothing to discriminate) or the repeat was not
   * taken, and that absence is what puts a finding in `unclassified` rather than
   * silently promoting it to a verdict the evidence does not support.
   */
  readonly repeatFailures?: readonly string[];
}

export interface SweepClassification {
  /** Varied across seeds AND reproduced under its own seed — order-dependent. */
  readonly orderDependent: string[];
  /** Came and went under a FIXED seed — contention, not order (mt#3501's class). */
  readonly loadSensitive: string[];
  /** Failed under EVERY seed — the suite's standing red set, not this task's. */
  readonly standingRed: string[];
  /** Varied across seeds, but no fixed-seed repeat covered it. Class UNKNOWN. */
  readonly unclassified: string[];
}

/**
 * Classify failures on TWO axes: variance across seeds, and repeatability under
 * a fixed one.
 *
 * ## Why cross-seed variance alone is not enough
 *
 * The first axis needs no declaration-order baseline, which is the whole reason
 * it was chosen: once `bunfig.toml` says `randomize = true`, a seedless run is
 * itself randomized, so a "baseline" is just another sample wearing a different
 * name, and Bun 1.3.14 offers no `--no-randomize` to force declaration order
 * back. Variance answers "does this test's outcome vary?" directly.
 *
 * But a LOAD-SENSITIVE test varies too. So variance over-reports by exactly the
 * class this task's `## Scope` puts out of scope (mt#3501 / mt#3494), and it did:
 * the 4-seed sweep on 2026-09-02 reported three order-dependent findings, two of
 * which mt#3501's spec names verbatim as its own load-dependent population.
 *
 * ## The second axis
 *
 * mem#942 states the discriminator: a load-sensitive assertion ROTATES, while an
 * order-dependent one fails identically for a given order. So re-run the SAME
 * seed — the same order — and see whether the failure comes back.
 *
 *   - reproduces under its own seed  → the ORDER causes it → order-dependent
 *   - comes and goes under that seed → something other than order → contention
 *
 * ## Precedence, and why it points this way
 *
 * A flip under a fixed seed WINS over a repeat under some other seed. Seeing a
 * failure twice is consistent with order-dependence and equally consistent with
 * contention that happened to land twice; seeing it flip while the order is held
 * constant is positive evidence that something other than the order moved. The
 * asymmetry is deliberate, and its cost is the honest one: this can file a
 * genuinely order-dependent test as `loadSensitive` when it is ALSO
 * load-sensitive. Both buckets are printed with their per-seed evidence so a
 * reader can re-form the judgment rather than inherit it.
 *
 * ## Bounds
 *
 * With N seeds this can only see order-dependence that one of those N orders
 * exposes, and a test failing under all N is reported as standing-red even if a
 * 21st order would have passed it. `standingRed` is computed from FIRST runs
 * only — one sample per order — so the repeat runs cannot skew that axis. More
 * seeds tighten both bounds; neither is fixed by a baseline.
 */
export function classifySweep(observations: readonly SeedObservation[]): SweepClassification {
  if (observations.length === 0) {
    return { orderDependent: [], loadSensitive: [], standingRed: [], unclassified: [] };
  }

  const names = new Set<string>();
  for (const observation of observations) {
    for (const name of observation.failures) names.add(name);
    for (const name of observation.repeatFailures ?? []) names.add(name);
  }

  const orderDependent: string[] = [];
  const loadSensitive: string[] = [];
  const standingRed: string[] = [];
  const unclassified: string[] = [];

  for (const name of names) {
    const seedsFailingFirstRun = observations.filter((o) => o.failures.includes(name)).length;
    if (seedsFailingFirstRun === observations.length) {
      standingRed.push(name);
      continue;
    }

    let flippedUnderFixedSeed = false;
    let reproducedUnderFixedSeed = false;
    for (const observation of observations) {
      if (observation.repeatFailures === undefined) continue;
      const inFirst = observation.failures.includes(name);
      const inRepeat = observation.repeatFailures.includes(name);
      if (inFirst !== inRepeat) flippedUnderFixedSeed = true;
      else if (inFirst) reproducedUnderFixedSeed = true;
    }

    if (flippedUnderFixedSeed) loadSensitive.push(name);
    else if (reproducedUnderFixedSeed) orderDependent.push(name);
    else unclassified.push(name);
  }

  return {
    orderDependent: orderDependent.sort(),
    loadSensitive: loadSensitive.sort(),
    standingRed: standingRed.sort(),
    unclassified: unclassified.sort(),
  };
}

/**
 * Per-seed evidence for one finding, so a reader can re-form the verdict instead
 * of inheriting it. `"—"` marks a seed whose repeat was never taken.
 */
export function evidenceFor(name: string, observations: readonly SeedObservation[]): string {
  const cells: string[] = [];
  for (const observation of observations) {
    const first = observation.failures.includes(name) ? "F" : ".";
    const repeat =
      observation.repeatFailures === undefined
        ? "—"
        : observation.repeatFailures.includes(name)
          ? "F"
          : ".";
    cells.push(`s${observation.seed}:${first}${repeat}`);
  }
  return cells.join(" ");
}

/** Did two runs execute tests in a different order? The randomization self-check. */
export function ordersDiffer(a: readonly string[], b: readonly string[]): boolean {
  if (a.length === 0 || b.length === 0) return false;
  if (a.length !== b.length) return true;
  return a.some((name, i) => name !== b[i]);
}

export function parseSeedArg(argv: readonly string[], fallback = 20): number {
  const i = argv.indexOf("--seeds");
  if (i === -1) return fallback;
  const raw = argv[i + 1];
  const n = raw === undefined ? NaN : Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// ── Imperative shell ────────────────────────────────────────────────────────

interface RunResult {
  readonly exitCode: number;
  readonly output: string;
}

function runBunTest(args: readonly string[], cwd = REPO_ROOT): RunResult {
  const proc = Bun.spawnSync(["bun", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const decoder = new TextDecoder();
  return {
    exitCode: proc.exitCode ?? 1,
    output: decoder.decode(proc.stdout) + decoder.decode(proc.stderr),
  };
}

/**
 * Is `[test] randomize` TRUE in the repo's own bunfig?
 *
 * The sandbox probe below proves this Bun BUILD can shuffle. That is a
 * different question from whether THIS REPO's suite runs will shuffle, and
 * conflating them would rebuild the exact defect this script exists to prevent:
 * a self-check that passes while the runs it vouches for are in declaration
 * order. Both must hold.
 */
export function repoRandomizeEnabled(bunfigText: string): boolean {
  // No `[test]` section means no `[test] randomize`. Falling back to scanning
  // the whole file would count a `randomize` key from an unrelated section —
  // a false TRUE, which is the direction that vouches for a sweep that is not
  // shuffling. Absent reads as disabled.
  const testSection = bunfigText.split(/^\[/m).find((s) => s.startsWith("test]"));
  if (testSection === undefined) return false;
  const match = testSection.match(/^\s*randomize\s*=\s*(true|false)/m);
  return match?.[1] === "true";
}

/**
 * Prove `[test] randomize` is actually shuffling, in a throwaway directory with
 * its OWN bunfig — so the answer does not depend on the repo's current setting
 * and the check cannot be silently disabled by the very flag it is testing.
 */
export function randomizationIsLive(): { live: boolean; detail: string } {
  const bunfigPath = join(REPO_ROOT, "bunfig.toml");
  const bunfigText = existsSync(bunfigPath) ? readFileSync(bunfigPath, "utf8").toString() : "";
  if (!repoRandomizeEnabled(bunfigText)) {
    return {
      live: false,
      detail:
        "bunfig.toml's [test] randomize is not `true`, so the suite runs below would execute in " +
        "declaration order no matter what seed is passed. The --randomize CLI flag does not " +
        "override it (measured on Bun 1.3.14, mt#3575).",
    };
  }

  const dir = mkdtempSync(join(tmpdir(), "minsky-seed-selfcheck-"));
  try {
    writeFileSync(join(dir, "bunfig.toml"), "[test]\nrandomize = true\n");
    for (const name of ["aaa", "bbb", "ccc", "ddd"]) {
      writeFileSync(
        join(dir, `${name}.test.ts`),
        `import { test, expect } from "bun:test";\n` +
          `test("${name}", () => { process.stdout.write("SEEDPROBE=${name}\\n"); expect(1).toBe(1); });\n`
      );
    }
    const orderOf = (seed: number): string[] => {
      const { output } = runBunTest(["test", "--seed", String(seed), "."], dir);
      return [...output.matchAll(/SEEDPROBE=(\w+)/g)].map((m) => m[1] ?? "");
    };
    // Several pairs, because two seeds can coincide on one permutation by luck.
    const seedPairs: ReadonlyArray<readonly [number, number]> = [
      [1, 2],
      [3, 4],
      [5, 6],
    ];
    for (const [a, b] of seedPairs) {
      const left = orderOf(a);
      const right = orderOf(b);
      if (left.length === 0) {
        return { live: false, detail: `self-check probe produced no output at seed ${a}` };
      }
      if (ordersDiffer(left, right)) {
        return {
          live: true,
          detail: `seed ${a} → ${left.join(",")}; seed ${b} → ${right.join(",")}`,
        };
      }
    }
    return {
      live: false,
      detail:
        "three seed pairs produced identical order — randomization is NOT active. " +
        "Check `[test] randomize` in bunfig.toml; the --randomize CLI flag alone does not enable it.",
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function main(): never {
  const json = process.argv.includes("--json");
  const seedCount = parseSeedArg(process.argv);

  const selfCheck = randomizationIsLive();
  if (!selfCheck.live) {
    console.error(
      `run-tests-seed-sweep: randomization is not active, so this sweep would prove nothing.\n` +
        `  ${selfCheck.detail}`
    );
    process.exit(2);
  }
  if (!json) console.log(`Randomization confirmed live — ${selfCheck.detail}\n`);

  if (seedCount < 2) {
    console.error(
      "run-tests-seed-sweep: at least 2 seeds are required — order-dependence is detected by " +
        "DIFFERENCE between orders, so a single sample can never show it."
    );
    process.exit(2);
  }

  const observations: SeedObservation[] = [];
  for (let seed = 1; seed <= seedCount; seed++) {
    const run = runBunTest(["scripts/run-tests-main.ts", "--seed", String(seed)]);
    const failures = parseFailureNames(run.output);
    if (!json) console.log(`seed ${seed}: ${failures.length} failure(s)`);

    if (failures.length === 0) {
      observations.push({ seed, failures });
      continue;
    }

    // The discriminator. Re-running the SAME seed re-runs the SAME order, so a
    // failure that comes back is caused by the order and one that comes and goes
    // is caused by something else — contention, typically (mem#942). Only failing
    // seeds pay for this, so a clean sweep costs nothing extra.
    const repeat = runBunTest(["scripts/run-tests-main.ts", "--seed", String(seed)]);
    const repeatFailures = parseFailureNames(repeat.output);
    if (!json) {
      console.log(`seed ${seed} (fixed-seed repeat): ${repeatFailures.length} failure(s)`);
    }
    observations.push({ seed, failures, repeatFailures });
  }

  const { orderDependent, loadSensitive, standingRed, unclassified } = classifySweep(observations);

  if (json) {
    console.log(
      JSON.stringify(
        {
          selfCheck,
          seedCount,
          observations,
          orderDependent,
          loadSensitive,
          standingRed,
          unclassified,
        },
        null,
        2
      )
    );
  } else {
    const report = (heading: string, names: readonly string[]): void => {
      console.log(`\n${heading}: ${names.length}`);
      for (const name of names) console.log(`  ${name}\n    ${evidenceFor(name, observations)}`);
    };
    console.log(
      "\n(evidence key: sN:XY — X = first run at seed N, Y = fixed-seed repeat; F = failed)"
    );
    report("Order-dependent (varied across seeds, reproduced under its own seed)", orderDependent);
    report(
      "Load-sensitive (flipped under a FIXED seed — mt#3501's class, not this task's)",
      loadSensitive
    );
    report("Standing red set (failed under EVERY order — not this sweep's concern)", standingRed);
    report("UNCLASSIFIED (varied across seeds, no fixed-seed repeat covered it)", unclassified);
  }

  // Load-sensitive findings are deliberately not a failure signal here: they are
  // owned by mt#3501 / mt#3494 and this task's `## Scope` excludes them. An
  // unclassified finding IS a failure signal — the sweep did not establish a
  // class for it, and silence must not read as a pass.
  process.exit(orderDependent.length > 0 || unclassified.length > 0 ? 1 : 0);
}

if (import.meta.main) {
  main();
}
