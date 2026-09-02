#!/usr/bin/env bun
/**
 * Run the main test suite under N random seeds and report order-dependent
 * failures, against a declaration-order baseline (mt#3575).
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
 *   1. Self-check — run a generated probe file twice under two different seeds
 *      and require the observed test order to DIFFER. If it does not, exit 2:
 *      the sweep would be meaningless.
 *   2. Baseline — one run in declaration order, to collect failures that have
 *      nothing to do with ordering. On 2026-09-02 that was 2 (both mt#3377).
 *   3. Sweep — one run per seed; report failures NOT present in the baseline.
 *
 * Usage:
 *   bun scripts/run-tests-seed-sweep.ts                 # 20 seeds
 *   bun scripts/run-tests-seed-sweep.ts --seeds 5       # fewer, for a spot check
 *   bun scripts/run-tests-seed-sweep.ts --json
 *
 * Exit code: 0 = no order-dependent failures beyond the baseline; 1 = at least
 * one seed produced a failure the baseline did not; 2 = the sweep could not
 * establish that randomization is active, so it proves nothing.
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

/**
 * Failures a seed produced that the baseline did not.
 *
 * Subtracting the baseline is what separates ORDER-dependence from the suite's
 * standing red set. Without it every seed inherits the baseline's failures and
 * the sweep reports a population that is mostly not this task's.
 */
export function orderDependentFailures(
  baseline: readonly string[],
  seedFailures: readonly string[]
): string[] {
  const known = new Set(baseline);
  return seedFailures.filter((name) => !known.has(name));
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

  const baselineRun = runBunTest(["scripts/run-tests-main.ts"]);
  const baseline = parseFailureNames(baselineRun.output);
  if (!json) {
    console.log(`Baseline (declaration order): ${baseline.length} failure(s)`);
    for (const name of baseline) console.log(`  ${name}`);
    console.log("");
  }

  const findings: { seed: number; failures: string[] }[] = [];
  for (let seed = 1; seed <= seedCount; seed++) {
    const run = runBunTest(["scripts/run-tests-main.ts", "--seed", String(seed)]);
    const novel = orderDependentFailures(baseline, parseFailureNames(run.output));
    if (novel.length > 0) findings.push({ seed, failures: novel });
    if (!json) {
      console.log(
        `seed ${seed}: ${novel.length === 0 ? "clean" : `${novel.length} order-dependent`}`
      );
      for (const name of novel) console.log(`    ${name}`);
    }
  }

  if (json) {
    console.log(JSON.stringify({ selfCheck, seedCount, baseline, findings }, null, 2));
  } else {
    const seedsWithFindings = findings.length;
    console.log(
      `\n${seedCount - seedsWithFindings}/${seedCount} seeds clean; ` +
        `${new Set(findings.flatMap((f) => f.failures)).size} distinct order-dependent test(s).`
    );
  }

  process.exit(findings.length > 0 ? 1 : 0);
}

if (import.meta.main) {
  main();
}
