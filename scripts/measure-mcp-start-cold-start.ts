#!/usr/bin/env bun
/**
 * Cold-start measurement for the actual `mcp start` path (mt#1745).
 *
 * mt#1740's `scripts/measure-cold-start.ts` uses `--help` and exits before
 * `server.start()` — its 1.2× source-vs-bundle delta missed the cost of
 * DI container init, 170-tool registration, and stdio transport wiring.
 * mt#1705's client-log captures showed 2083–3863ms cold-start times for
 * actual Claude Code `/mcp` reconnects, an order of magnitude past what
 * `--help` exercises.
 *
 * This script measures the real path:
 *   1. Spawn `bun run <entry> mcp start` with stdio pipes
 *      and MINSKY_MCP_PROFILE=1.
 *   2. Send an MCP `initialize` JSON-RPC request on stdin.
 *   3. Time wall-clock from spawn to the `initialize` response on stdout.
 *   4. Parse `[profile] checkpoint=<name> t=<ms>` lines from stderr
 *      (emitted by `src/commands/mcp/start-command.ts` when the env var
 *      is set) to build a per-stage breakdown.
 *   5. Kill the child, repeat N (default 10) times per path.
 *
 * Outputs structured JSON to `scripts/mcp-start-cold-start-results.json`
 * with median + p95 wall-clock per path, plus per-checkpoint median
 * times per path. The benchmark itself does NOT enforce a pass/fail
 * threshold — the goal is characterization, not a regression gate.
 */

import { spawn, type ChildProcessByStdio } from "child_process";
import type { Readable, Writable } from "stream";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(SCRIPT_DIR, "..");
const SOURCE_PATH = join(PACKAGE_ROOT, "src", "cli.ts");
const BUNDLE_PATH = join(PACKAGE_ROOT, "dist", "minsky.js");
const RESULTS_PATH = join(SCRIPT_DIR, "mcp-start-cold-start-results.json");

const ITERATIONS = Number(process.env.MEASURE_ITERATIONS ?? 10);
const PER_INVOCATION_TIMEOUT_MS = Number(process.env.MEASURE_TIMEOUT_MS ?? 15_000);

interface Stats {
  count: number;
  median: number;
  p95: number;
  min: number;
  max: number;
}

interface CheckpointStats {
  name: string;
  count: number;
  median: number;
  p95: number;
  min: number;
  max: number;
}

interface IterationResult {
  initializeMs: number;
  toolsListMs: number;
  checkpoints: Map<string, number>;
}

interface PathStats {
  label: string;
  entry: string;
  iterations: number;
  /** Spawn → `initialize` JSON-RPC response. */
  initializeWallClock: Stats & { raw: number[] };
  /**
   * Spawn → `tools/list` response. Approximates what Claude Code's `/mcp`
   * UI waits for before reporting "server connected" — the SDK calls
   * tools/list right after the initialize handshake to populate its
   * tool registry.
   */
  toolsListWallClock: Stats & { raw: number[] };
  checkpoints: CheckpointStats[];
}

function computeStats(samples: number[]): Stats {
  const sorted = [...samples].sort((a, b) => a - b);
  const n = sorted.length;
  if (n === 0) return { count: 0, median: 0, p95: 0, min: 0, max: 0 };
  const median = n % 2 === 0 ? (sorted[n / 2 - 1] + sorted[n / 2]) / 2 : sorted[Math.floor(n / 2)];
  const p95Index = Math.min(n - 1, Math.floor(n * 0.95));
  return {
    count: n,
    median,
    p95: sorted[p95Index],
    min: sorted[0],
    max: sorted[n - 1],
  };
}

const INITIALIZE_REQUEST = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "mt#1745-benchmark", version: "1.0.0" },
  },
};

const INITIALIZED_NOTIFICATION = {
  jsonrpc: "2.0",
  method: "notifications/initialized",
};

const TOOLS_LIST_REQUEST = {
  jsonrpc: "2.0",
  id: 2,
  method: "tools/list",
  params: {},
};

/**
 * Run a single `bun run <entry> mcp start` invocation and time it from
 * spawn to the JSON-RPC `initialize` response on stdout. Stderr lines
 * matching `[profile] checkpoint=<name> t=<ms>` are captured.
 *
 * Returns null if the child failed to respond within the per-invocation
 * timeout (the caller logs and continues).
 */
async function measureOne(entry: string): Promise<IterationResult | null> {
  return new Promise((resolve) => {
    const start = performance.now();

    const child: ChildProcessByStdio<Writable, Readable, Readable> = spawn(
      "bun",
      ["run", entry, "mcp", "start"],
      {
        cwd: PACKAGE_ROOT,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, MINSKY_MCP_PROFILE: "1" },
      }
    );

    let stdoutBuf = "";
    let stderrBuf = "";
    const checkpoints = new Map<string, number>();
    let initializeMs = 0;
    let toolsListMs = 0;
    let settled = false;

    const cleanupAndResolve = (result: IterationResult | null) => {
      if (settled) return;
      settled = true;
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      resolve(result);
    };

    /**
     * After receiving the tools/list response, wait briefly so any
     * trailing stderr (notably `server_started`) flushes from the
     * child's buffer before we kill it. The wall-clock measurements
     * are already captured; this is only for checkpoint completeness.
     */
    const settleAfterFinalResponse = () => {
      setTimeout(() => cleanupAndResolve({ initializeMs, toolsListMs, checkpoints }), 150);
    };

    const timeoutHandle = setTimeout(() => {
      process.stderr.write(
        `[measure] iteration timed out after ${PER_INVOCATION_TIMEOUT_MS}ms; killing child\n`
      );
      cleanupAndResolve(null);
    }, PER_INVOCATION_TIMEOUT_MS);

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBuf += chunk.toString("utf8");
      // MCP stdio is newline-delimited JSON. Look for our responses
      // (id=1 = initialize, id=2 = tools/list).
      let newlineIdx: number;
      while ((newlineIdx = stdoutBuf.indexOf("\n")) >= 0) {
        const line = stdoutBuf.slice(0, newlineIdx).trim();
        stdoutBuf = stdoutBuf.slice(newlineIdx + 1);
        if (!line.startsWith("{")) continue; // non-JSON log line on stdout
        try {
          const msg = JSON.parse(line) as { id?: number; jsonrpc?: string; result?: unknown };
          if (msg.jsonrpc !== "2.0" || msg.result === undefined) continue;

          if (msg.id === 1 && initializeMs === 0) {
            initializeMs = performance.now() - start;
            // Send notifications/initialized + tools/list to capture the
            // post-initialize timing that Claude Code's /mcp UI waits for.
            const frames = `${JSON.stringify(INITIALIZED_NOTIFICATION)}\n${JSON.stringify(
              TOOLS_LIST_REQUEST
            )}\n`;
            child.stdin.write(frames, (err) => {
              if (err) {
                process.stderr.write(`[measure] post-init stdin write error: ${err.message}\n`);
              }
            });
          } else if (msg.id === 2 && toolsListMs === 0) {
            toolsListMs = performance.now() - start;
            clearTimeout(timeoutHandle);
            settleAfterFinalResponse();
            return;
          }
        } catch {
          // Not JSON — ignore (legacy log.cli lines may appear on stdout
          // pre-handshake; the SDK + Claude Code tolerate them).
        }
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderrBuf += chunk.toString("utf8");
      let newlineIdx: number;
      while ((newlineIdx = stderrBuf.indexOf("\n")) >= 0) {
        const line = stderrBuf.slice(0, newlineIdx);
        stderrBuf = stderrBuf.slice(newlineIdx + 1);
        const m = line.match(/^\[profile\] checkpoint=(\S+) t=([\d.]+)/);
        if (m) checkpoints.set(m[1], Number(m[2]));
      }
    });

    child.on("error", (err) => {
      process.stderr.write(`[measure] child spawn error: ${(err as Error).message}\n`);
      clearTimeout(timeoutHandle);
      cleanupAndResolve(null);
    });

    child.on("exit", (code, signal) => {
      // If we already resolved on `initialize`, this is just the SIGKILL
      // tear-down. Otherwise the child died before responding.
      if (!settled) {
        process.stderr.write(
          `[measure] child exited code=${code} signal=${signal} before initialize response\n`
        );
        if (stderrBuf.length > 0) {
          process.stderr.write(`[measure] tail stderr: ${stderrBuf.slice(-500)}\n`);
        }
        clearTimeout(timeoutHandle);
        cleanupAndResolve(null);
      }
    });

    // Write the initialize request as a single newline-terminated frame.
    const frame = `${JSON.stringify(INITIALIZE_REQUEST)}\n`;
    child.stdin.write(frame, (err) => {
      if (err) {
        process.stderr.write(`[measure] stdin write error: ${err.message}\n`);
        clearTimeout(timeoutHandle);
        cleanupAndResolve(null);
      }
    });
  });
}

async function measureMany(label: string, entry: string, iterations: number): Promise<PathStats> {
  process.stderr.write(
    `[measure] ${label}: ${iterations} iterations of \`bun run ${entry} mcp start\`\n`
  );

  // Warmup: one untimed invocation so the FS page-cache is warm and the
  // first timed iteration isn't skewed.
  await measureOne(entry);

  const results: IterationResult[] = [];
  for (let i = 0; i < iterations; i++) {
    const r = await measureOne(entry);
    if (r) {
      results.push(r);
      process.stderr.write(
        `[measure] ${label} iter ${i + 1}/${iterations}: init=${r.initializeMs.toFixed(0)}ms tools=${r.toolsListMs.toFixed(0)}ms\n`
      );
    } else {
      process.stderr.write(`[measure] ${label} iter ${i + 1}/${iterations}: FAILED\n`);
    }
  }

  const initSamples = results.map((r) => r.initializeMs);
  const toolsSamples = results.map((r) => r.toolsListMs);
  const initStats = computeStats(initSamples);
  const toolsStats = computeStats(toolsSamples);

  // Aggregate per-checkpoint medians across iterations.
  const checkpointNames = new Set<string>();
  for (const r of results) for (const k of r.checkpoints.keys()) checkpointNames.add(k);

  const checkpointStatsList: CheckpointStats[] = [];
  for (const name of checkpointNames) {
    const samples = results
      .map((r) => r.checkpoints.get(name))
      .filter((v): v is number => v !== undefined);
    if (samples.length === 0) continue;
    const s = computeStats(samples);
    checkpointStatsList.push({ name, ...s });
  }
  // Sort by median ascending so the timeline reads top-down.
  checkpointStatsList.sort((a, b) => a.median - b.median);

  return {
    label,
    entry,
    iterations: results.length,
    initializeWallClock: { ...initStats, raw: initSamples },
    toolsListWallClock: { ...toolsStats, raw: toolsSamples },
    checkpoints: checkpointStatsList,
  };
}

interface CostContributor {
  stage: string;
  medianMs: number;
}

/**
 * Compute per-stage costs by differencing adjacent checkpoint medians.
 *
 * Two synthetic stages bracket the checkpoint timeline:
 *
 *   spawn → cli_top   = bun runtime startup + reflect-metadata import.
 *                       Captured by `cli_top.median` itself (which is
 *                       relative to module-load time).
 *
 *   server_started → initialize_response
 *                     = SDK transport-connect + microtask scheduling +
 *                       initialize handler + stdout flush. Approximated
 *                       as `wall_clock_median - server_started.median`.
 */
function computeStageCosts(stats: PathStats): CostContributor[] {
  const cps = stats.checkpoints;
  if (cps.length === 0) return [];

  const stages: CostContributor[] = [];

  // Synthetic: spawn → first checkpoint.
  const first = cps[0];
  if (first.median > 0) {
    stages.push({
      stage: `spawn → ${first.name} (bun startup + reflect-metadata)`,
      medianMs: first.median,
    });
  }

  // Adjacent-checkpoint differences.
  for (let i = 1; i < cps.length; i++) {
    const prev = cps[i - 1];
    const curr = cps[i];
    const delta = curr.median - prev.median;
    if (delta > 0) {
      stages.push({ stage: `${prev.name} → ${curr.name}`, medianMs: delta });
    }
  }

  // Synthetic: last checkpoint → initialize response on the wire.
  const last = cps[cps.length - 1];
  const handshake = stats.initializeWallClock.median - last.median;
  if (handshake > 0) {
    stages.push({
      stage: `${last.name} → initialize_response (SDK handshake)`,
      medianMs: handshake,
    });
  }

  // Synthetic: initialize_response → tools/list_response (the second
  // round-trip; Claude Code's /mcp UI waits for this too).
  const toolsList = stats.toolsListWallClock.median - stats.initializeWallClock.median;
  if (toolsList > 0) {
    stages.push({
      stage: `initialize_response → tools_list_response (170-tool enumeration)`,
      medianMs: toolsList,
    });
  }

  // Sort descending so most expensive shows first.
  stages.sort((a, b) => b.medianMs - a.medianMs);
  return stages;
}

async function main(): Promise<void> {
  if (!existsSync(SOURCE_PATH)) {
    process.stderr.write(`[measure] src/cli.ts not found at ${SOURCE_PATH}; aborting\n`);
    process.exit(1);
  }
  if (!existsSync(BUNDLE_PATH)) {
    process.stderr.write(
      `[measure] dist/minsky.js not found at ${BUNDLE_PATH}; build it via \`bun run build\` first\n`
    );
    process.exit(1);
  }

  const sourceStats = await measureMany("source", SOURCE_PATH, ITERATIONS);
  const bundleStats = await measureMany("bundle", BUNDLE_PATH, ITERATIONS);

  const sourceCosts = computeStageCosts(sourceStats);
  const bundleCosts = computeStageCosts(bundleStats);

  const speedupInit =
    bundleStats.initializeWallClock.median > 0
      ? sourceStats.initializeWallClock.median / bundleStats.initializeWallClock.median
      : 0;
  const speedupTools =
    bundleStats.toolsListWallClock.median > 0
      ? sourceStats.toolsListWallClock.median / bundleStats.toolsListWallClock.median
      : 0;

  const results = {
    timestamp: new Date().toISOString(),
    iterations: ITERATIONS,
    timeoutMs: PER_INVOCATION_TIMEOUT_MS,
    speedupInitialize: speedupInit,
    speedupToolsList: speedupTools,
    source: { ...sourceStats, topStageCosts: sourceCosts.slice(0, 5) },
    bundle: { ...bundleStats, topStageCosts: bundleCosts.slice(0, 5) },
  };

  mkdirSync(dirname(RESULTS_PATH), { recursive: true });
  writeFileSync(RESULTS_PATH, JSON.stringify(results, null, 2));

  const fmt = (n: number) => n.toFixed(1);
  process.stdout.write(
    `\n` +
      `[measure] Results written to ${RESULTS_PATH}\n` +
      `[measure] Source  initialize: median=${fmt(sourceStats.initializeWallClock.median)}ms  p95=${fmt(sourceStats.initializeWallClock.p95)}ms\n` +
      `[measure] Source  tools/list: median=${fmt(sourceStats.toolsListWallClock.median)}ms  p95=${fmt(sourceStats.toolsListWallClock.p95)}ms\n` +
      `[measure] Bundle  initialize: median=${fmt(bundleStats.initializeWallClock.median)}ms  p95=${fmt(bundleStats.initializeWallClock.p95)}ms\n` +
      `[measure] Bundle  tools/list: median=${fmt(bundleStats.toolsListWallClock.median)}ms  p95=${fmt(bundleStats.toolsListWallClock.p95)}ms\n` +
      `[measure] Speedup initialize=${fmt(speedupInit)}×  tools/list=${fmt(speedupTools)}×  (n=${sourceStats.iterations})\n` +
      `\n` +
      `[measure] Source top stage costs:\n`
  );
  for (const c of sourceCosts.slice(0, 5)) {
    process.stdout.write(`  ${fmt(c.medianMs).padStart(8)}ms  ${c.stage}\n`);
  }
  process.stdout.write(`\n[measure] Bundle top stage costs:\n`);
  for (const c of bundleCosts.slice(0, 5)) {
    process.stdout.write(`  ${fmt(c.medianMs).padStart(8)}ms  ${c.stage}\n`);
  }
  process.stdout.write("\n");

  process.exit(0);
}

if (import.meta.main) {
  void main();
}
