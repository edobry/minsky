#!/usr/bin/env bun
/**
 * mt#1588 spike — latency benchmark for memory enrichment middleware.
 *
 * Measures the overhead of `enrichToolResponse` (memory_search + format) on
 * an allowlisted tool call. Compares against a kill-switched baseline run
 * on the same code path.
 *
 * Methodology (per the planning craft-level defaults in the spec):
 * - N=100 sequential calls of `enrichToolResponse("tasks.get", {taskId},
 *   memoryService)` against a populated memory DB
 * - Baseline: same N=100 calls with `MINSKY_MCP_MEMORY_ENRICHMENT=0`
 *   (middleware short-circuits to null without calling search)
 * - Reports p50 / p95 / p99 / total / mean
 *
 * Usage:
 *   bun scripts/benchmark-mcp-memory-enrichment.ts
 *   bun scripts/benchmark-mcp-memory-enrichment.ts --n=200
 *   bun scripts/benchmark-mcp-memory-enrichment.ts --task=mt#1012
 *
 * Exits non-zero if the MemoryService cannot be constructed (no Postgres,
 * no embedding service) — the benchmark intentionally requires a populated
 * DB to produce meaningful signal-to-noise observations for the spike report.
 *
 * @see mt#1588 — this spike
 */

import { enrichToolResponse } from "../src/mcp/middleware/memory-enrichment";
import type { MemoryServiceSurface } from "@minsky/domain/memory/memory-service";
import "reflect-metadata";

/**
 * Vector dimension for the memory embeddings store. See the analogous comment
 * + TODO in `src/commands/mcp/start-command.ts` (PR #974 R2 BLOCKING). Hoisted
 * to a constant so the benchmark stays in sync with the spike wiring; both
 * sites collapse to a single derived dimension once mt#1626 lands.
 */
const MEMORY_EMBEDDING_DIMENSION = 1536;

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

interface BenchmarkArgs {
  n: number;
  taskId: string;
}

function parseArgs(argv: string[]): BenchmarkArgs {
  const args: BenchmarkArgs = { n: 100, taskId: "mt#1012" };
  for (const arg of argv.slice(2)) {
    const [k, v] = arg.split("=");
    if (k === "--n") args.n = Number.parseInt(v, 10);
    else if (k === "--task") args.taskId = v;
  }
  if (!Number.isFinite(args.n) || args.n < 1) {
    throw new Error(`Invalid --n: ${args.n}`);
  }
  return args;
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

interface Stats {
  n: number;
  totalMs: number;
  meanMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  minMs: number;
  maxMs: number;
}

function computeStats(samples: number[]): Stats {
  const sorted = [...samples].sort((a, b) => a - b);
  const total = samples.reduce((sum, x) => sum + x, 0);
  // Nearest-rank percentile: index = ceil(p * n) - 1, clamped into [0, n-1].
  // Replaces the prior `Math.floor(sorted.length * p)` form which had an
  // off-by-one bias for small N (PR #974 R1 NON-BLOCKING).
  const pct = (p: number): number => {
    if (sorted.length === 0) return 0;
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1));
    return sorted[idx];
  };
  return {
    n: samples.length,
    totalMs: total,
    meanMs: total / samples.length,
    p50Ms: pct(0.5),
    p95Ms: pct(0.95),
    p99Ms: pct(0.99),
    minMs: sorted[0],
    maxMs: sorted[sorted.length - 1],
  };
}

function formatStats(label: string, stats: Stats): string {
  return [
    `${label}:`,
    `  n=${stats.n}`,
    `  total: ${stats.totalMs.toFixed(1)}ms`,
    `  mean: ${stats.meanMs.toFixed(2)}ms`,
    `  p50: ${stats.p50Ms.toFixed(2)}ms`,
    `  p95: ${stats.p95Ms.toFixed(2)}ms`,
    `  p99: ${stats.p99Ms.toFixed(2)}ms`,
    `  min: ${stats.minMs.toFixed(2)}ms`,
    `  max: ${stats.maxMs.toFixed(2)}ms`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Memory service construction
// ---------------------------------------------------------------------------

/**
 * Build a real MemoryService against the configured Postgres backend.
 * Mirrors `scripts/import-claude-code-memory.ts:buildMemoryService` — uses
 * `createCliContainer` to share the production wire-up rather than reaching
 * into the persistence factory directly.
 */
async function buildMemoryService(): Promise<MemoryServiceSurface> {
  const { initializeConfiguration, CustomConfigFactory } = await import(
    "@minsky/domain/configuration"
  );
  const { createCliContainer } = await import("../src/composition/cli");
  const { PersistenceProvider } = await import("@minsky/domain/persistence/types");
  const { createEmbeddingServiceFromConfig } = await import(
    "@minsky/domain/ai/embedding-service-factory"
  );
  const { createVectorStorageForDomain } = await import(
    "@minsky/domain/storage/vector/vector-storage-factory"
  );
  const { MemoryService } = await import("@minsky/domain/memory");
  type MemoryServiceDb = import("@minsky/domain/memory/memory-service").MemoryServiceDb;

  await initializeConfiguration(new CustomConfigFactory(), {
    workingDirectory: process.cwd(),
  });

  const container = await createCliContainer();
  await container.initialize();

  const persistence = container.has("persistence") ? container.get("persistence") : undefined;
  if (!persistence) {
    throw new Error(
      "Benchmark requires a persistence provider — set up Minsky with Postgres first."
    );
  }
  if (!(persistence instanceof PersistenceProvider)) {
    throw new Error(
      "Benchmark requires a PersistenceProvider instance; got incompatible DI binding."
    );
  }
  if (!persistence.capabilities.sql || typeof persistence.getDatabaseConnection !== "function") {
    throw new Error(
      `Benchmark requires a SQL-capable persistence provider (Postgres). Got: ${JSON.stringify(
        persistence.capabilities
      )}`
    );
  }
  const connection = await persistence.getDatabaseConnection();
  if (!connection) {
    throw new Error("Benchmark requires an initialized Postgres connection; got null.");
  }

  const embeddingService = await createEmbeddingServiceFromConfig();
  const vectorStorage = await createVectorStorageForDomain(
    "memory",
    MEMORY_EMBEDDING_DIMENSION,
    persistence
  );

  return new MemoryService({
    db: connection as MemoryServiceDb,
    vectorStorage,
    embeddingService,
  });
}

// ---------------------------------------------------------------------------
// Benchmark runner
// ---------------------------------------------------------------------------

async function runBenchmark(label: string, n: number, fn: () => Promise<unknown>): Promise<Stats> {
  // Warm-up: discard the first 3 samples to absorb JIT + connection-pool warmup.
  for (let i = 0; i < 3; i++) {
    await fn();
  }
  const samples: number[] = [];
  for (let i = 0; i < n; i++) {
    const start = performance.now();
    await fn();
    samples.push(performance.now() - start);
  }
  const stats = computeStats(samples);
  console.log(formatStats(label, stats));
  return stats;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const argsRecord = { taskId: args.taskId };

  console.log("[mt#1588] memory enrichment benchmark");
  console.log(`  n=${args.n}, taskId=${args.taskId}`);
  console.log("  warm-up: 3 discarded samples per condition");
  console.log();

  let memoryService: MemoryServiceSurface;
  try {
    memoryService = await buildMemoryService();
  } catch (err) {
    console.error(
      "[mt#1588] failed to construct MemoryService — benchmark requires Postgres + embedding service:"
    );
    console.error(`  ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  // Sanity check: do at least one search to confirm the DB is populated.
  console.log("[mt#1588] sanity check — first search:");
  const firstResult = await memoryService.search(`tasks.get ${args.taskId}`, {
    limit: 3,
  });
  console.log(
    `  backend=${firstResult.backend}, degraded=${firstResult.degraded}, results=${firstResult.results.length}`
  );
  if (firstResult.degraded || firstResult.results.length === 0) {
    console.error(
      "[mt#1588] memory DB returned no usable results — benchmark would not be meaningful."
    );
    process.exit(2);
  }
  console.log();

  // Baseline: opt-in disabled (default state). Measures the (negligible)
  // cost of the env-var check + allowlist check + early return on the same
  // code path. PR #974 R1 inverted the env-var polarity: default OFF, opt-in
  // via MINSKY_MCP_MEMORY_ENRICHMENT=1.
  delete process.env.MINSKY_MCP_MEMORY_ENRICHMENT;
  const baseline = await runBenchmark("Baseline (opt-in disabled — default)", args.n, () =>
    enrichToolResponse("tasks.get", argsRecord, memoryService)
  );
  console.log();

  // Enriched: explicit opt-in via MINSKY_MCP_MEMORY_ENRICHMENT=1. Full
  // middleware path including memory_search + format.
  process.env.MINSKY_MCP_MEMORY_ENRICHMENT = "1";
  const enriched = await runBenchmark("Enriched (MINSKY_MCP_MEMORY_ENRICHMENT=1)", args.n, () =>
    enrichToolResponse("tasks.get", argsRecord, memoryService)
  );
  console.log();

  // Overhead summary — what enrichment adds on top of the baseline path.
  const overheadP50 = enriched.p50Ms - baseline.p50Ms;
  const overheadP95 = enriched.p95Ms - baseline.p95Ms;
  console.log("Overhead (enriched - baseline):");
  console.log(`  p50: +${overheadP50.toFixed(2)}ms`);
  console.log(`  p95: +${overheadP95.toFixed(2)}ms`);
  console.log();

  // Emit JSON to stdout for downstream consumption (Notion spike report).
  console.log("---JSON---");
  console.log(
    JSON.stringify(
      {
        n: args.n,
        taskId: args.taskId,
        baseline,
        enriched,
        overhead: { p50Ms: overheadP50, p95Ms: overheadP95 },
        memorySanity: {
          backend: firstResult.backend,
          degraded: firstResult.degraded,
          resultCount: firstResult.results.length,
        },
        timestamp: new Date().toISOString(),
      },
      null,
      2
    )
  );
}

void main().catch((err) => {
  console.error("[mt#1588] benchmark failed:", err);
  process.exit(1);
});
