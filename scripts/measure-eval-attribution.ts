#!/usr/bin/env bun
/**
 * Module-EVAL attribution harness for the CLI cold-boot bundle+init layer (mt#3090).
 *
 * ## What this measures and why it exists
 *
 * mt#2968 established the CLI cold boot pays a ~775ms "bundle load + runtime/DI/config init"
 * layer (version - runtime tier delta), and mt#3006 proved it is EVAL-bound, not parse-bound
 * (bundle size -34% via --minify moved boot time only -8%). The existing `profileCheckpoint`
 * instrumentation in `src/cli.ts` attributes only ~110ms of that layer — the remaining ~660ms is
 * module top-level EVALUATION that runs during bun's evaluation of the module graph, before the
 * profiler's own checkpoints can see it (the profiler module loads mid-evaluation).
 *
 * This harness attributes that uninstrumented eval cost by REPLAYING `src/cli.ts`'s exact eager
 * top-level import order in a COLD process and timing the marginal cost of each step. Because
 * imports are cached within a process, each step's delta is its TRUE added cost given everything
 * already loaded — exactly what the real boot pays, in the real order. This is the per-component
 * attribution discipline of mem#413 (a2e3b097) / mt#1792's `measure-adapter-costs.ts`.
 *
 * ## Method
 *
 * Each ITERATION is a fresh `bun` subprocess (module cache is per-process, so a fresh process is
 * the only way to measure COLD eval cost). The orchestrator (no `--once`) spawns this same file
 * with `--once` N times, each of which runs one cold import sequence and prints a single JSON line
 * of `{ step: marginalMs }`. The orchestrator aggregates per-step medians and prints a table.
 *
 * ## Fidelity caveat
 *
 * This runs the SOURCE path (`bun` importing `src/**` + `@minsky/*` workspaces), not the built
 * bundle — per-import attribution is inherently a source-path technique (the bundle is one file).
 * mt#1729 measured the source path ~60ms faster than the bundle but the SAME shape, so the
 * attribution (which subtree dominates) transfers; the absolute ms are a lower bound on the
 * bundle's. The dominant subtree is the lever regardless of the ~60ms source-vs-bundle offset.
 *
 * ## Usage
 *
 *   bun scripts/measure-eval-attribution.ts            # orchestrate: N cold runs + median table
 *   bun scripts/measure-eval-attribution.ts --n=12     # N iterations (default 8)
 *   bun scripts/measure-eval-attribution.ts --once      # one cold sequence -> one JSON line
 *
 * @see mt#3090 — this task (module-eval attribution)
 * @see mem#413 (a2e3b097) — measure cost-attribution before locking success criteria
 * @see scripts/benchmark-cold-boot.ts — the 4-tier wall-clock harness this drills into
 */

import { spawnSync } from "child_process";
import { fileURLToPath } from "url";

const SELF = fileURLToPath(import.meta.url);

/**
 * One cold import sequence. Mirrors `src/cli.ts`'s eager top-level imports IN ORDER, timing the
 * marginal cost of each step. `performance.now()` deltas; the process is already cold (fresh spawn).
 *
 * ORDERING (PR #2229 review): every static import is performed BEFORE `setupConfiguration()` is
 * called, because that is what actually happens at runtime. ESM evaluates a module's entire import
 * graph before executing its body, so although `src/cli.ts` reads as "import config-setup, await
 * setupConfiguration(), then the rest", the real evaluation order is: all of lines 2-60's imports,
 * THEN the body's `await setupConfiguration()`. (cli.ts's "setup config FIRST before any other
 * imports" comment describes authorial intent; ESM hoisting means it does not hold for static
 * imports.) Interleaving the call earlier — as this harness first did — mis-attributes marginal
 * cost, since modules imported after the call would find config already initialised.
 *
 * Returns an ordered list of { step, ms } marginal timings, printed as one JSON line.
 */
async function runOnce(): Promise<void> {
  const marks: Array<{ step: string; ms: number }> = [];
  let last = performance.now();
  const mark = (step: string) => {
    const now = performance.now();
    marks.push({ step, ms: now - last });
    last = now;
  };

  // --- Phase 1: every static import, in src/cli.ts's declaration order (lines 2-60). Relative
  // specifiers resolve against src/ from this scripts/ dir via ../src; @minsky/* aliases resolve
  // workspace-wide (same as cli.ts).
  await import("reflect-metadata");
  mark("reflect-metadata");

  await import("../src/utils/cold-start-profile");
  mark("cold-start-profile");

  const configSetup = await import("@minsky/domain/config-setup");
  mark("import:@minsky/domain/config-setup");

  await import("@minsky/domain/configuration/loader");
  mark("@minsky/domain/configuration/loader");

  await import("commander");
  mark("commander");

  await import("@minsky/shared/logger");
  await import("@minsky/shared/process");
  await import("@minsky/shared/stdout-sync");
  mark("@minsky/shared/{logger,process,stdout-sync}");

  await import("../src/adapters/cli/cli-command-factory");
  mark("import:cli-command-factory");

  await import("@minsky/domain/schemas/error");
  mark("@minsky/domain/schemas/error");

  await import("../src/cli-discriminators");
  mark("cli-discriminators");

  // --- Phase 2: the module BODY's first real work — cli.ts's `await setupConfiguration()`.
  await configSetup.setupConfiguration();
  mark("call:setupConfiguration()");

  const total = marks.reduce((a, m) => a + m.ms, 0);
  process.stdout.write(`${JSON.stringify({ marks, total })}\n`);
}

/**
 * Conventional median: for odd length the middle sample, for EVEN length the mean of the two middle
 * samples. (PR #2229 review: the previous implementation's doc claimed "lower-middle" while
 * `Math.floor(n/2)` actually selected the UPPER middle on a 0-based array.)
 */
function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  if (s.length % 2 === 1) return s[mid] ?? 0;
  return ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2;
}

async function orchestrate(n: number): Promise<void> {
  const perStep = new Map<string, number[]>();
  const totals: number[] = [];
  let order: string[] = [];

  process.stderr.write(`[eval-attr] ${n} cold iterations (fresh process each)...\n`);
  for (let i = 0; i < n; i++) {
    // Fresh subprocess = cold module cache. spawnSync keeps the loop simple and serial.
    const res = spawnSync("bun", [SELF, "--once"], {
      encoding: "utf8",
      env: { ...process.env },
    });
    if (res.status !== 0) {
      process.stderr.write(
        `[eval-attr] iter ${i + 1}/${n} FAILED (status ${res.status}):\n${res.stderr}\n`
      );
      continue;
    }
    const line = res.stdout.trim().split("\n").filter(Boolean).pop();
    if (!line) {
      process.stderr.write(`[eval-attr] iter ${i + 1}/${n}: no JSON output\n`);
      continue;
    }
    let parsed: { marks: Array<{ step: string; ms: number }>; total: number };
    try {
      parsed = JSON.parse(line);
    } catch {
      process.stderr.write(`[eval-attr] iter ${i + 1}/${n}: unparseable: ${line}\n`);
      continue;
    }
    if (order.length === 0) order = parsed.marks.map((m) => m.step);
    for (const m of parsed.marks) {
      let bucket = perStep.get(m.step);
      if (!bucket) {
        bucket = [];
        perStep.set(m.step, bucket);
      }
      bucket.push(m.ms);
    }
    totals.push(parsed.total);
    process.stderr.write(`[eval-attr] iter ${i + 1}/${n}: total ${parsed.total.toFixed(0)}ms\n`);
  }

  if (totals.length === 0) {
    process.stderr.write("[eval-attr] no successful iterations\n");
    process.exit(1);
  }

  const rows = order.map((step) => ({ step, median: median(perStep.get(step) ?? []) }));
  rows.sort((a, b) => b.median - a.median);

  // Percentages are normalised to the SUM of the per-step medians, NOT to the median of the
  // per-iteration totals (PR #2229 review). `median(sum(step_i)) != sum(median(step_i))` in general,
  // so mixing the two produced a column that did not sum to 100%. Both figures are printed: the
  // shares below are internally consistent, and any gap against the median-total is visible.
  const medianSum = rows.reduce((a, r) => a + r.median, 0);
  const totalMed = median(totals);
  process.stdout.write(
    "\n=== module-EVAL attribution (source path, marginal per import, medians) ===\n"
  );
  process.stdout.write(
    `iterations: ${totals.length}   sum of per-step medians: ${medianSum.toFixed(0)}ms   median of per-iteration totals: ${totalMed.toFixed(0)}ms\n(shares below are of the per-step-median sum, so they total 100%)\n\n`
  );
  const w = Math.max(...order.map((s) => s.length));
  for (const r of rows) {
    const pct = medianSum > 0 ? (100 * r.median) / medianSum : 0;
    const bar = "#".repeat(Math.round(pct / 2));
    process.stdout.write(
      `${r.step.padEnd(w)}  ${r.median.toFixed(1).padStart(7)}ms  ${pct.toFixed(1).padStart(5)}%  ${bar}\n`
    );
  }
}

const args = process.argv.slice(2);
if (args.includes("--once")) {
  await runOnce();
} else {
  const nArg = args.find((a) => a.startsWith("--n="));
  const n = nArg ? parseInt(nArg.slice(4), 10) : 8;
  await orchestrate(n);
}
