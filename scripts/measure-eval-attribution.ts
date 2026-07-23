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

  // Step order mirrors src/cli.ts lines 2-60. Relative specifiers resolve against src/ from this
  // scripts/ dir via ../src; @minsky/* aliases resolve workspace-wide (same as cli.ts).
  await import("reflect-metadata");
  mark("reflect-metadata");

  await import("../src/utils/cold-start-profile");
  mark("cold-start-profile");

  // config-setup pulls the @minsky/domain subtree; cli.ts imports it, then AWAITS
  // setupConfiguration() before any other domain import. Replicate both to measure the real cost.
  const configSetup = await import("@minsky/domain/config-setup");
  mark("import:@minsky/domain/config-setup");
  await configSetup.setupConfiguration();
  mark("call:setupConfiguration()");

  await import("@minsky/domain/configuration/loader");
  mark("@minsky/domain/configuration/loader");

  await import("commander");
  mark("commander");

  await import("@minsky/shared/logger");
  await import("@minsky/shared/process");
  await import("@minsky/shared/stdout-sync");
  mark("@minsky/shared/{logger,process,stdout-sync}");

  // The CLI command factory + shared command registry — the other suspected heavy subtree.
  await import("../src/adapters/cli/cli-command-factory");
  mark("import:cli-command-factory");

  await import("@minsky/domain/schemas/error");
  mark("@minsky/domain/schemas/error");

  await import("../src/cli-discriminators");
  mark("cli-discriminators");

  const total = marks.reduce((a, m) => a + m.ms, 0);
  process.stdout.write(`${JSON.stringify({ marks, total })}\n`);
}

/** Median of a numeric array (lower-middle for even length). */
function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? 0;
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

  const totalMed = median(totals);
  process.stdout.write(
    "\n=== module-EVAL attribution (source path, marginal per import, medians) ===\n"
  );
  process.stdout.write(`iterations: ${totals.length}   total median: ${totalMed.toFixed(0)}ms\n\n`);
  const w = Math.max(...order.map((s) => s.length));
  for (const r of rows) {
    const pct = totalMed > 0 ? (100 * r.median) / totalMed : 0;
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
