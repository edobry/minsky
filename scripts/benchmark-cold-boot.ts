#!/usr/bin/env bun
/**
 * Cold-boot benchmark harness for the `minsky` CLI (mt#2968).
 *
 * Every `minsky` CLI invocation pays a cold-boot cost (measured ~3.5-5.7s
 * during the mt#2958 investigation). Every hook that shells out to `minsky`,
 * all interactive CLI use, and completion pay this cost cold, every time.
 * This harness decomposes that cost by LAYER so the optimization work can be
 * sized to where the cost actually is (the profile-first decomposition
 * decided in mt#2968 planning).
 *
 * ## Method
 *
 * Four command TIERS, each timed as a fresh process (spawn -> exit wall-clock),
 * N iterations with warmup discarded:
 *
 *   runtime : `bun -e "process.exit(0)"`      -> pure bun startup floor (no bundle)
 *   version : `<bin> --version`               -> + parse/eval 37MB bundle + config setup + CLI imports
 *   list    : `<bin> tasks list --limit 1`    -> + DI container init + Postgres connect + query
 *   search  : `<bin> tasks search <q> --limit`-> + embedding call + vector query
 *
 * The three cold-boot LAYERS the spec names fall out as tier-median deltas:
 *
 *   bundle+init layer = version - runtime      (bundle load + runtime/DI/config init)
 *   Postgres-connect  = list    - version      (fresh DB connection each process)
 *   embedding+vector  = search  - list         (embed the query remotely + vector query)
 *
 * In addition, each tier is run once more with `MINSKY_MCP_PROFILE=1` so the
 * intra-process `[profile] checkpoint=<name> t=<ms>` timeline (mt#1745
 * instrumentation in src/cli.ts) decomposes the bundle+init layer internally.
 *
 * ## Fidelity
 *
 * Defaults to the BUILT bundle (`dist/minsky.js` run via `bun <bundle>`),
 * because that is what the installed `minsky` and the hooks actually execute
 * — running `bun run src/cli.ts` transpiles on the fly and measures a
 * different, non-production cost. Pass `--source` to also compare the
 * from-source path. Build the bundle first: `bun run build`.
 *
 * ## Usage
 *
 *   bun scripts/benchmark-cold-boot.ts
 *   bun scripts/benchmark-cold-boot.ts --n=20
 *   bun scripts/benchmark-cold-boot.ts --bin=/absolute/path/to/minsky.js
 *   bun scripts/benchmark-cold-boot.ts --source        # also measure src/cli.ts
 *   bun scripts/benchmark-cold-boot.ts --query="cold boot latency"
 *
 * Writes structured JSON to `scripts/cold-boot-benchmark-results.json` and a
 * human-readable table to stdout. Characterization only — no pass/fail gate.
 *
 * @see mt#2968 — this task (profile-first decomposition)
 * @see scripts/measure-mcp-start-cold-start.ts — sibling harness for the
 *   `mcp start` stdio path (mt#1745); this one covers the interactive CLI tiers.
 */

import { spawn } from "child_process";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(SCRIPT_DIR, "..");
const SOURCE_PATH = join(PACKAGE_ROOT, "src", "cli.ts");
const DEFAULT_BUNDLE = join(PACKAGE_ROOT, "dist", "minsky.js");
const RESULTS_PATH = join(SCRIPT_DIR, "cold-boot-benchmark-results.json");

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

interface Args {
  n: number;
  warmup: number;
  bin: string;
  query: string;
  includeSource: boolean;
  perInvocationTimeoutMs: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    n: 10,
    warmup: 2,
    bin: DEFAULT_BUNDLE,
    query: "cold boot latency optimization",
    includeSource: false,
    perInvocationTimeoutMs: 30_000,
  };
  for (const raw of argv.slice(2)) {
    const [k, v] = raw.split("=");
    if (k === "--n") args.n = Number.parseInt(v ?? "", 10);
    else if (k === "--warmup") args.warmup = Number.parseInt(v ?? "", 10);
    else if (k === "--bin") args.bin = v ?? args.bin;
    else if (k === "--query") args.query = v ?? args.query;
    else if (k === "--source") args.includeSource = true;
    else if (k === "--timeout") args.perInvocationTimeoutMs = Number.parseInt(v ?? "", 10);
  }
  if (!Number.isFinite(args.n) || args.n < 1) throw new Error(`Invalid --n: ${args.n}`);
  if (!Number.isFinite(args.warmup) || args.warmup < 0) throw new Error(`Invalid --warmup`);
  return args;
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

interface Stats {
  count: number;
  meanMs: number;
  medianMs: number;
  p95Ms: number;
  minMs: number;
  maxMs: number;
}

function computeStats(samples: number[]): Stats {
  const sorted = [...samples].sort((a, b) => a - b);
  const n = sorted.length;
  if (n === 0) return { count: 0, meanMs: 0, medianMs: 0, p95Ms: 0, minMs: 0, maxMs: 0 };
  const at = (i: number): number => {
    const v = sorted[i];
    if (v === undefined) throw new Error(`computeStats: index ${i} out of bounds (n=${n})`);
    return v;
  };
  const median = n % 2 === 0 ? (at(n / 2 - 1) + at(n / 2)) / 2 : at(Math.floor(n / 2));
  const p95Index = Math.min(n - 1, Math.floor(n * 0.95));
  const total = sorted.reduce((sum, x) => sum + x, 0);
  return {
    count: n,
    meanMs: total / n,
    medianMs: median,
    p95Ms: at(p95Index),
    minMs: at(0),
    maxMs: at(n - 1),
  };
}

// ---------------------------------------------------------------------------
// Single-invocation timing
// ---------------------------------------------------------------------------

interface InvocationResult {
  wallMs: number;
  exitCode: number | null;
  checkpoints: Map<string, number>;
  stderrTail: string;
}

/**
 * Spawn one process, time spawn -> exit, and capture any
 * `[profile] checkpoint=<name> t=<ms>` lines from stderr. `command` +
 * `commandArgs` are passed straight to `spawn` (e.g. `bun`, `[bin, ...]`).
 */
function measureOne(
  command: string,
  commandArgs: string[],
  profile: boolean,
  timeoutMs: number
): Promise<InvocationResult> {
  return new Promise((resolve) => {
    const start = performance.now();
    const child = spawn(command, commandArgs, {
      cwd: PACKAGE_ROOT,
      stdio: ["ignore", "ignore", "pipe"],
      env: profile ? { ...process.env, MINSKY_MCP_PROFILE: "1" } : { ...process.env },
    });

    const checkpoints = new Map<string, number>();
    let stderrBuf = "";
    let settled = false;

    const parseCheckpointLine = (line: string): void => {
      const m = line.match(/^\[profile\] checkpoint=(\S+) t=([\d.]+)/);
      if (m) {
        const name = m[1];
        const t = m[2];
        if (name !== undefined && t !== undefined) checkpoints.set(name, Number(t));
      }
    };

    // Single settle path: resolve exactly once, clearing the timer, draining
    // any final unterminated stderr line, and dropping listeners so no stray
    // timer or listener survives in a long-lived parent (reviewer PR #2104 R1).
    const finish = (exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      if (stderrBuf.length > 0) parseCheckpointLine(stderrBuf); // final line, no trailing "\n"
      child.stderr.removeAllListeners("data");
      child.removeAllListeners("error");
      child.removeAllListeners("exit");
      resolve({
        wallMs: performance.now() - start,
        exitCode,
        checkpoints,
        stderrTail: stderrBuf.slice(-500),
      });
    };

    const timeoutHandle = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      finish(null);
    }, timeoutMs);

    child.stderr.on("data", (chunk: Buffer) => {
      stderrBuf += chunk.toString("utf8");
      let idx: number;
      while ((idx = stderrBuf.indexOf("\n")) >= 0) {
        parseCheckpointLine(stderrBuf.slice(0, idx));
        stderrBuf = stderrBuf.slice(idx + 1);
      }
    });

    child.on("error", () => finish(null));
    child.on("exit", (code) => finish(code));
  });
}

// ---------------------------------------------------------------------------
// Tier definitions
// ---------------------------------------------------------------------------

interface TierResult {
  tier: string;
  description: string;
  argvDisplay: string;
  stats: Stats;
  exitCodes: number[];
  cleanExit: boolean;
  /** Checkpoints from the single profiled run of this tier (one run, not medianed). */
  checkpoints: Array<{ name: string; t: number }>;
}

interface TierSpec {
  tier: string;
  description: string;
  /** How to build the (command, args) for a run given the resolved binary. */
  build: (bin: string, useSource: boolean, query: string) => { cmd: string; args: string[] };
}

function buildBinInvocation(
  bin: string,
  useSource: boolean,
  trailing: string[]
): { cmd: string; args: string[] } {
  // Source: `bun run src/cli.ts <args>`; bundle: `bun <bundle> <args>`.
  return useSource
    ? { cmd: "bun", args: ["run", SOURCE_PATH, ...trailing] }
    : { cmd: "bun", args: [bin, ...trailing] };
}

const TIERS: TierSpec[] = [
  {
    tier: "runtime",
    description: "pure bun startup floor (no bundle)",
    build: () => ({ cmd: "bun", args: ["-e", "process.exit(0)"] }),
  },
  {
    tier: "version",
    description: "bundle load + runtime/DI/config init (no DB, no embed)",
    build: (bin, src) => buildBinInvocation(bin, src, ["--version"]),
  },
  {
    tier: "list",
    description: "+ DI container init + Postgres connect + query",
    build: (bin, src) => buildBinInvocation(bin, src, ["tasks", "list", "--limit", "1"]),
  },
  {
    tier: "search",
    description: "+ embedding call + vector query",
    build: (bin, src, q) => buildBinInvocation(bin, src, ["tasks", "search", q, "--limit", "5"]),
  },
];

async function measureTier(
  spec: TierSpec,
  bin: string,
  useSource: boolean,
  args: Args
): Promise<TierResult> {
  const { cmd, args: cmdArgs } = spec.build(bin, useSource, args.query);
  const argvDisplay = [cmd, ...cmdArgs].join(" ");
  process.stderr.write(`[bench] ${spec.tier}: ${args.n} iters of \`${argvDisplay}\`\n`);

  // Warmup (discarded) — absorb FS page-cache + any first-run cost.
  for (let i = 0; i < args.warmup; i++) {
    await measureOne(cmd, cmdArgs, false, args.perInvocationTimeoutMs);
  }

  const wallSamples: number[] = [];
  const exitCodes: number[] = [];
  for (let i = 0; i < args.n; i++) {
    const r = await measureOne(cmd, cmdArgs, false, args.perInvocationTimeoutMs);
    wallSamples.push(r.wallMs);
    exitCodes.push(r.exitCode ?? -1);
    process.stderr.write(
      `[bench] ${spec.tier} iter ${i + 1}/${args.n}: ${r.wallMs.toFixed(0)}ms exit=${r.exitCode}\n`
    );
  }

  // One profiled run for the intra-process checkpoint timeline.
  const profiled = await measureOne(cmd, cmdArgs, true, args.perInvocationTimeoutMs);
  const checkpoints = [...profiled.checkpoints.entries()]
    .map(([name, t]) => ({ name, t }))
    .sort((a, b) => a.t - b.t);

  // A tier is "clean" only if EVERY timed run exited 0. A timeout or spawn
  // error resolves with exitCode null -> recorded as -1 above, so those runs
  // also flip cleanExit false and mark the dependent layer deltas UNRELIABLE.
  const cleanExit = exitCodes.every((c) => c === 0);
  if (!cleanExit) {
    process.stderr.write(
      `[bench] WARNING: ${spec.tier} had non-zero exits (${exitCodes.join(",")}). ` +
        `Layer deltas that depend on this tier are unreliable. Tail: ${profiled.stderrTail}\n`
    );
  }

  return {
    tier: spec.tier,
    description: spec.description,
    argvDisplay,
    stats: computeStats(wallSamples),
    exitCodes,
    cleanExit,
    checkpoints,
  };
}

// ---------------------------------------------------------------------------
// Layer decomposition
// ---------------------------------------------------------------------------

interface Layer {
  layer: string;
  formula: string;
  medianMs: number;
  reliable: boolean;
}

function computeLayers(tiers: Map<string, TierResult>): Layer[] {
  const m = (t: string) => tiers.get(t)?.stats.medianMs ?? 0;
  const clean = (t: string) => tiers.get(t)?.cleanExit ?? false;
  const runtime = m("runtime");
  const version = m("version");
  const list = m("list");
  const search = m("search");
  return [
    {
      layer: "bun runtime floor",
      formula: "runtime",
      medianMs: runtime,
      reliable: clean("runtime"),
    },
    {
      layer: "bundle load + runtime/DI/config init",
      formula: "version - runtime",
      medianMs: Math.max(0, version - runtime),
      reliable: clean("version") && clean("runtime"),
    },
    {
      layer: "Postgres connect + query",
      formula: "list - version",
      medianMs: Math.max(0, list - version),
      reliable: clean("list") && clean("version"),
    },
    {
      layer: "embedding call + vector query",
      formula: "search - list",
      medianMs: Math.max(0, search - list),
      reliable: clean("search") && clean("list"),
    },
  ];
}

/** Difference adjacent checkpoint medians into per-stage costs. */
function stageCosts(
  checkpoints: Array<{ name: string; t: number }>
): Array<{ stage: string; ms: number }> {
  const stages: Array<{ stage: string; ms: number }> = [];
  if (checkpoints.length === 0) return stages;
  const at = (i: number): { name: string; t: number } => {
    const v = checkpoints[i];
    if (v === undefined) throw new Error(`stageCosts: index ${i} out of bounds`);
    return v;
  };
  const first = at(0);
  stages.push({ stage: `spawn -> ${first.name}`, ms: first.t });
  for (let i = 1; i < checkpoints.length; i++) {
    const prev = at(i - 1);
    const curr = at(i);
    stages.push({
      stage: `${prev.name} -> ${curr.name}`,
      ms: curr.t - prev.t,
    });
  }
  return stages;
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function pad(s: string, w: number): string {
  return s.length >= w ? s : s + " ".repeat(w - s.length);
}
function padL(s: string, w: number): string {
  return s.length >= w ? s : " ".repeat(w - s.length) + s;
}

function renderReport(label: string, tiers: Map<string, TierResult>): string {
  const lines: string[] = [];
  lines.push(`\n=== ${label} — per-tier wall-clock (fresh process each) ===`);
  lines.push(
    `${pad("tier", 10)}${padL("median", 10)}${padL("p95", 10)}${padL("min", 9)}${padL("max", 9)}  exit`
  );
  for (const spec of TIERS) {
    const t = tiers.get(spec.tier);
    if (!t) continue;
    const s = t.stats;
    lines.push(
      `${pad(t.tier, 10)}${padL(`${s.medianMs.toFixed(0)}ms`, 10)}${padL(
        `${s.p95Ms.toFixed(0)}ms`,
        10
      )}${padL(`${s.minMs.toFixed(0)}ms`, 9)}${padL(`${s.maxMs.toFixed(0)}ms`, 9)}  ${
        t.cleanExit ? "ok" : "NONZERO"
      }`
    );
  }

  lines.push(`\n=== ${label} — cold-boot LAYER decomposition (tier-median deltas) ===`);
  const layers = computeLayers(tiers);
  for (const l of layers) {
    lines.push(
      `${pad(l.layer, 42)}${padL(`${l.medianMs.toFixed(0)}ms`, 9)}  (${l.formula})${
        l.reliable ? "" : "  [UNRELIABLE — non-zero exit upstream]"
      }`
    );
  }
  // The layers are telescoped tier-median deltas: runtime + (version-runtime) +
  // (list-version) + (search-list) collapses to the search-tier median BY
  // CONSTRUCTION. This is NOT a sum of independent per-invocation costs (which
  // need not be linear) — it is the same search-tier median, re-derived.
  const total = layers.reduce((sum, l) => sum + l.medianMs, 0);
  lines.push(
    `${pad("TOTAL (= search-tier median, telescoped)", 42)}${padL(`${total.toFixed(0)}ms`, 9)}`
  );

  // Intra-process checkpoint breakdown for the `list` tier (fullest boot with DB).
  const listTier = tiers.get("list");
  if (listTier && listTier.checkpoints.length > 0) {
    lines.push(`\n=== ${label} — boot checkpoint timeline (list tier, MINSKY_MCP_PROFILE=1) ===`);
    const stages = stageCosts(listTier.checkpoints).sort((a, b) => b.ms - a.ms);
    for (const st of stages.slice(0, 12)) {
      lines.push(`${padL(`${st.ms.toFixed(1)}ms`, 10)}  ${st.stage}`);
    }
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function measureAll(
  bin: string,
  useSource: boolean,
  args: Args
): Promise<Map<string, TierResult>> {
  const tiers = new Map<string, TierResult>();
  for (const spec of TIERS) {
    tiers.set(spec.tier, await measureTier(spec, bin, useSource, args));
  }
  return tiers;
}

function tiersToJson(tiers: Map<string, TierResult>) {
  return {
    tiers: [...tiers.values()],
    layers: computeLayers(tiers),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);

  if (!existsSync(args.bin)) {
    process.stderr.write(
      `[bench] bundle not found at ${args.bin}\n` +
        `[bench] build it first: bun run build   (or pass --bin=<path>, or --source)\n`
    );
    if (!args.includeSource) process.exit(1);
  }

  process.stderr.write(
    `[bench] mt#2968 cold-boot benchmark — n=${args.n}, warmup=${args.warmup}, bin=${args.bin}\n`
  );

  const bundleTiers = existsSync(args.bin) ? await measureAll(args.bin, false, args) : null;
  const sourceTiers = args.includeSource ? await measureAll(args.bin, true, args) : null;

  const results = {
    task: "mt#2968",
    timestamp: new Date().toISOString(),
    n: args.n,
    warmup: args.warmup,
    bin: args.bin,
    query: args.query,
    bundle: bundleTiers ? tiersToJson(bundleTiers) : null,
    source: sourceTiers ? tiersToJson(sourceTiers) : null,
  };

  mkdirSync(dirname(RESULTS_PATH), { recursive: true });
  writeFileSync(RESULTS_PATH, JSON.stringify(results, null, 2));

  if (bundleTiers)
    process.stdout.write(`${renderReport("BUNDLE (dist/minsky.js)", bundleTiers)}\n`);
  if (sourceTiers)
    process.stdout.write(`${renderReport("SOURCE (bun run src/cli.ts)", sourceTiers)}\n`);
  process.stdout.write(`\n[bench] Results written to ${RESULTS_PATH}\n`);

  process.exit(0);
}

if (import.meta.main) {
  void main().catch((err) => {
    process.stderr.write(`[bench] failed: ${err instanceof Error ? err.stack : String(err)}\n`);
    process.exit(1);
  });
}
