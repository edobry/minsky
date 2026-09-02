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
 *   3. Classify by CROSS-SEED VARIANCE (`classifyFailures`). A test that fails
 *      under some orders and passes under others is order-dependent; one that
 *      fails under every order belongs to the suite's standing red set.
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
 * least one test's outcome varied with the order; 2 = the sweep could not
 * establish that randomization is active (or fewer than 2 seeds were asked
 * for), so it proves nothing and its silence must not be read as a pass.
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

export interface SweepClassification {
  /** Failed under SOME seeds and passed under others — order-dependent by definition. */
  readonly orderDependent: string[];
  /** Failed under EVERY seed — the suite's standing red set, not this task's. */
  readonly standingRed: string[];
}

/**
 * Classify failures by CROSS-SEED VARIANCE rather than against a baseline.
 *
 * The obvious design — subtract a declaration-order baseline — stops working the
 * moment this task succeeds: once `bunfig.toml` says `randomize = true`, a
 * seedless run is itself randomized, so the "baseline" is just another sample.
 * Bun 1.3.14 offers no `--no-randomize` and no config-path flag to force
 * declaration order back, so there is nothing to subtract.
 *
 * Variance needs no baseline and answers the question directly: a test that
 * fails in one order and passes in another IS order-dependent — that is the
 * definition, not a proxy for it. One that fails in every order is failing for
 * some other reason, which is exactly what the baseline was being used to
 * approximate.
 *
 * Bound worth stating: with N seeds this can only see order-dependence that at
 * least one of those N orders exposes, and a test failing under all N is
 * reported as standing-red even if a 21st order would have passed it. More
 * seeds tighten both; neither is fixed by a baseline.
 */
export function classifyFailures(
  perSeedFailures: ReadonlyArray<readonly string[]>
): SweepClassification {
  if (perSeedFailures.length === 0) return { orderDependent: [], standingRed: [] };

  const counts = new Map<string, number>();
  for (const failures of perSeedFailures) {
    for (const name of new Set(failures)) counts.set(name, (counts.get(name) ?? 0) + 1);
  }

  const orderDependent: string[] = [];
  const standingRed: string[] = [];
  for (const [name, seenIn] of counts) {
    if (seenIn === perSeedFailures.length) standingRed.push(name);
    else orderDependent.push(name);
  }
  return { orderDependent: orderDependent.sort(), standingRed: standingRed.sort() };
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
 * Prove `[test] randomize` is actually shuffling, in a throwaway directory with
 * its OWN bunfig — so the answer does not depend on the repo's current setting
 * and the check cannot be silently disabled by the very flag it is testing.
 */
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

  const perSeed: string[][] = [];
  for (let seed = 1; seed <= seedCount; seed++) {
    const run = runBunTest(["scripts/run-tests-main.ts", "--seed", String(seed)]);
    const failures = parseFailureNames(run.output);
    perSeed.push(failures);
    if (!json) console.log(`seed ${seed}: ${failures.length} failure(s)`);
  }

  const { orderDependent, standingRed } = classifyFailures(perSeed);

  if (json) {
    console.log(JSON.stringify({ selfCheck, seedCount, orderDependent, standingRed }, null, 2));
  } else {
    console.log(
      `\nOrder-dependent (failed under some orders, passed under others): ${orderDependent.length}`
    );
    for (const name of orderDependent) console.log(`  ${name}`);
    console.log(
      `\nStanding red set (failed under EVERY order — not this sweep's concern): ${standingRed.length}`
    );
    for (const name of standingRed) console.log(`  ${name}`);
  }

  process.exit(orderDependent.length > 0 ? 1 : 0);
}

if (import.meta.main) {
  main();
}
