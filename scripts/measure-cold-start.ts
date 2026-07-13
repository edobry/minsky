#!/usr/bin/env bun
/**
 * Cold-start measurement script for mt#1740 — the bundle vs raw-source perf delta.
 *
 * Runs N (default 10) fresh CLI invocations against:
 *   (a) `bun run src/cli.ts --help`         — raw source baseline
 *   (b) `bun run dist/minsky.js --help`     — bundled v1 path
 *
 * Measures wall-clock for each invocation, captures median + p95 for both
 * paths, writes structured JSON to `scripts/cold-start-results.json`.
 *
 * Exit codes:
 *   0 — PASS (bundle path ≥ 4× faster on warm cache)
 *   1 — FAIL (speedup below target OR error)
 *
 * The subagent ships this artifact in the PR; the main agent runs it from
 * main-agent context after PR creation and appends the result JSON
 * (redacted as needed) to the PR body's `## Live verification` section.
 *
 * Bundle prerequisite: if `dist/minsky.js` does not exist, the script
 * builds it first via the same `bun build` command the cli-entry uses.
 * Warm-cache invocations are what we measure — first build is excluded.
 */

import { spawnSync, type SpawnSyncReturns } from "child_process";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(SCRIPT_DIR, "..");
const SOURCE_PATH = join(PACKAGE_ROOT, "src", "cli.ts");
const BUNDLE_PATH = join(PACKAGE_ROOT, "dist", "minsky.js");
const RESULTS_PATH = join(SCRIPT_DIR, "cold-start-results.json");

const ITERATIONS = Number(process.env.MEASURE_ITERATIONS ?? 10);
const SPEEDUP_TARGET = Number(process.env.MEASURE_SPEEDUP_TARGET ?? 4);
const QUICK_ARG = "--help"; // exits fast after parsing, doesn't start the server

interface Stats {
  count: number;
  median: number;
  p95: number;
  min: number;
  max: number;
  raw: number[];
}

function computeStats(samples: number[]): Stats {
  const sorted = [...samples].sort((a, b) => a - b);
  const n = sorted.length;
  const median = n % 2 === 0 ? (sorted[n / 2 - 1] + sorted[n / 2]) / 2 : sorted[Math.floor(n / 2)];
  const p95Index = Math.min(n - 1, Math.floor(n * 0.95));
  return {
    count: n,
    median,
    p95: sorted[p95Index],
    min: sorted[0],
    max: sorted[n - 1],
    raw: samples,
  };
}

function measure(label: string, command: string, args: string[], iterations: number): Stats {
  process.stderr.write(
    `[measure] ${label}: ${iterations} iterations of \`${command} ${args.join(" ")}\`\n`
  );
  const samples: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    const result: SpawnSyncReturns<Buffer> = spawnSync(command, args, {
      cwd: PACKAGE_ROOT,
      stdio: ["ignore", "ignore", "ignore"],
    });
    const elapsed = performance.now() - start;
    if (result.status !== 0) {
      process.stderr.write(
        `[measure] ${label}: iteration ${i} exited with status ${result.status}\n`
      );
    }
    samples.push(elapsed);
  }
  return computeStats(samples);
}

function ensureBundle(): void {
  if (existsSync(BUNDLE_PATH)) return;
  process.stderr.write(`[measure] bundle missing; building via bun build...\n`);
  const result = spawnSync(
    "bun",
    ["build", "--target=bun", `--outfile=${BUNDLE_PATH}`, SOURCE_PATH],
    { cwd: PACKAGE_ROOT, stdio: "inherit" }
  );
  if (result.status !== 0) {
    process.stderr.write(`[measure] bundle build failed; cannot proceed\n`);
    process.exit(1);
  }
}

function main(): void {
  if (!existsSync(SOURCE_PATH)) {
    process.stderr.write(`[measure] src/cli.ts not found at ${SOURCE_PATH}; aborting\n`);
    process.exit(1);
  }

  ensureBundle();

  // Warmup: one untimed invocation per path so filesystem caches are populated
  // and the first-timed iteration isn't skewed by disk read latency.
  spawnSync("bun", ["run", SOURCE_PATH, QUICK_ARG], {
    cwd: PACKAGE_ROOT,
    stdio: ["ignore", "ignore", "ignore"],
  });
  spawnSync("bun", ["run", BUNDLE_PATH, QUICK_ARG], {
    cwd: PACKAGE_ROOT,
    stdio: ["ignore", "ignore", "ignore"],
  });

  const sourceStats = measure("source", "bun", ["run", SOURCE_PATH, QUICK_ARG], ITERATIONS);
  const bundleStats = measure("bundle", "bun", ["run", BUNDLE_PATH, QUICK_ARG], ITERATIONS);

  const speedup = sourceStats.median / bundleStats.median;
  const passed = speedup >= SPEEDUP_TARGET;

  const results = {
    timestamp: new Date().toISOString(),
    iterations: ITERATIONS,
    speedupTarget: SPEEDUP_TARGET,
    speedupActual: speedup,
    passed,
    sourcePath: SOURCE_PATH,
    bundlePath: BUNDLE_PATH,
    sourceStats,
    bundleStats,
  };

  mkdirSync(dirname(RESULTS_PATH), { recursive: true });
  writeFileSync(RESULTS_PATH, JSON.stringify(results, null, 2));

  const fmt = (n: number) => n.toFixed(1);
  process.stdout.write(
    `\n` +
      `[measure] Results written to ${RESULTS_PATH}\n` +
      `[measure] Source  median=${fmt(sourceStats.median)}ms  p95=${fmt(sourceStats.p95)}ms\n` +
      `[measure] Bundle  median=${fmt(bundleStats.median)}ms  p95=${fmt(bundleStats.p95)}ms\n` +
      `[measure] Speedup ${fmt(speedup)}× (target: ${SPEEDUP_TARGET}×)\n` +
      `[measure] ${passed ? "PASS" : "FAIL"}\n`
  );

  process.exit(passed ? 0 : 1);
}

if (import.meta.main) {
  main();
}
