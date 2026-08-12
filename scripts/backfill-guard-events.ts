#!/usr/bin/env bun
/**
 * Backfill script for the guard/calibration exhaust historical corpus
 * (mt#4035, mt#3334 phase 3) — this task's required wrapper for the
 * >10-record bulk mutation (operational-safety §Bulk shared-state mutations).
 *
 * Dry-run is the DEFAULT (CLAUDE.md §Operational Safety: Dry-Run First).
 * Pass --execute to actually write. Both passes run the SAME
 * `runGuardEventsIngestSweep` orchestration `guard-events.ingest` and the
 * cockpit sweep use — dry-run just swaps in no-op `insertBatch`/`writeHwm`
 * deps, so "what would be ingested" is computed by the real parsing/dedupe
 * logic, not a separate estimate that could drift from it.
 *
 * Scope-match check (operational-safety §Dry-run scope-match check):
 * --execute ALWAYS runs a dry-run pass first (against the untouched
 * on-disk HWM state) and compares its own actual per-stream row counts
 * against that pass. Divergence beyond ~2x is a STOP — the two passes
 * read the same HWM-to-EOF span, so they should see materially the same
 * pending backlog; if they diverge more than 2x, don't blindly proceed.
 *
 * Usage:
 *   bun scripts/backfill-guard-events.ts                                  # dry-run, all 40 streams
 *   bun scripts/backfill-guard-events.ts --stream=wall-of-text            # dry-run, one stream
 *   bun scripts/backfill-guard-events.ts --execute --stream=wall-of-text  # bounded execute (one stream)
 *   bun scripts/backfill-guard-events.ts --execute --limit=500            # bounded execute (all streams, capped)
 *
 * DO NOT run this --execute with no --stream/--limit against the full
 * historical corpus from an interactive dispatch — the fire-log alone is
 * 427,285 lines. Per this task's dispatch instructions, that full backfill
 * is the operator's post-merge step, run from main-agent context with the
 * env vars/time budget a full run needs; this script's own pre-merge
 * verification pass is deliberately bounded (one small stream, or --limit).
 *
 * @see packages/domain/src/guard-events/ingest-service.ts — the orchestration this drives
 * @see packages/domain/src/guard-events/ingest-runtime.ts — the real deps this reuses
 * @see docs/architecture/guard-calibration-stream-inventory.md — the stream set
 */

import "reflect-metadata";

import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type {
  GuardEventsIngestDeps,
  GuardEventsIngestSummary,
} from "@minsky/domain/guard-events/ingest-service";

interface CliArgs {
  execute: boolean;
  stream?: string;
  limit?: number;
}

function parseArgs(argv: string[]): CliArgs {
  const execute = argv.includes("--execute");
  const streamArg = argv.find((a) => a.startsWith("--stream="));
  const limitArg = argv.find((a) => a.startsWith("--limit="));
  const limit = limitArg ? Number.parseInt(limitArg.split("=")[1] ?? "", 10) : undefined;
  return {
    execute,
    stream: streamArg?.split("=")[1],
    limit: limit !== undefined && Number.isFinite(limit) ? limit : undefined,
  };
}

/** Mirrors scripts/backfill-agent-tool-call-projection.ts's bootstrapDb precedent. */
async function bootstrapDb(): Promise<PostgresJsDatabase> {
  const { initializeConfiguration, CustomConfigFactory } = await import(
    "@minsky/domain/configuration"
  );
  const { createCliContainer } = await import("../src/composition/cli");

  await initializeConfiguration(new CustomConfigFactory(), { workingDirectory: process.cwd() });

  const container = await createCliContainer();
  await container.initialize();

  const persistence = container.has("persistence") ? container.get("persistence") : undefined;

  interface SqlCapablePersistence {
    getDatabaseConnection: () => Promise<PostgresJsDatabase | null>;
  }
  const isSqlCapablePersistence = (p: unknown): p is SqlCapablePersistence =>
    !!p &&
    !!(p as { capabilities?: { sql?: boolean } }).capabilities?.sql &&
    typeof (p as { getDatabaseConnection?: unknown }).getDatabaseConnection === "function";

  if (!isSqlCapablePersistence(persistence)) {
    throw new Error("Backfill requires a SQL-capable persistence provider (Postgres).");
  }

  const connection = await persistence.getDatabaseConnection();
  if (!connection) {
    throw new Error("Backfill requires an initialized Postgres database connection.");
  }
  return connection;
}

function printSummary(label: string, summary: GuardEventsIngestSummary): void {
  console.log(`\n${label}`);
  console.log("stream".padEnd(38), "read".padStart(8), "skipped", "truncated", "error");
  for (const s of summary.perStream) {
    console.log(
      s.stream.padEnd(38),
      String(s.read).padStart(8),
      s.skippedNoFile ? "no-file" : "-",
      s.truncated ? "yes" : "-",
      s.error ?? ""
    );
  }
  console.log(`totalRead=${summary.totalRead} totalErrors=${summary.totalErrors}`);
}

const SCOPE_MATCH_MAX_RATIO = 2;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const db = await bootstrapDb();

  const { buildGuardEventsIngestDeps } = await import("@minsky/domain/guard-events/ingest-runtime");
  const { runGuardEventsIngestSweep } = await import("@minsky/domain/guard-events/ingest-service");

  // No --limit (the full-corpus dry-run case) reads to EOF for every stream —
  // dry-run must report the REAL pending count, not a tick-bounded sample.
  const maxRecordsPerStreamPerTick = args.limit ?? Number.MAX_SAFE_INTEGER;
  const realDeps = buildGuardEventsIngestDeps(db, { maxRecordsPerStreamPerTick });

  const streams = args.stream
    ? realDeps.streams.filter((s) => s.stream === args.stream)
    : realDeps.streams;
  if (args.stream && streams.length === 0) {
    throw new Error(
      `Unknown stream: ${args.stream}. See docs/architecture/guard-calibration-stream-inventory.md for the valid set.`
    );
  }

  const dryRunDeps: GuardEventsIngestDeps = {
    ...realDeps,
    streams,
    insertBatch: async () => {
      // dry-run: never writes
    },
    writeHwm: () => {
      // dry-run: never advances the cursor
    },
  };

  const dryRunSummary = await runGuardEventsIngestSweep(dryRunDeps);
  printSummary(
    args.execute
      ? "DRY-RUN (scope-match baseline, no writes)"
      : "DRY-RUN (pass --execute to apply)",
    dryRunSummary
  );

  if (!args.execute) {
    console.log("\nNo changes made. Pass --execute to apply.");
    return;
  }

  const executeDeps: GuardEventsIngestDeps = { ...realDeps, streams };
  const executeSummary = await runGuardEventsIngestSweep(executeDeps);
  printSummary("EXECUTE (writes applied)", executeSummary);

  // Scope-match check (operational-safety §Dry-run scope-match check).
  const dryByStream = new Map(dryRunSummary.perStream.map((s) => [s.stream, s.read]));
  let stopped = false;
  for (const s of executeSummary.perStream) {
    const expected = dryByStream.get(s.stream) ?? 0;
    if (expected > 0 && s.read > expected * SCOPE_MATCH_MAX_RATIO) {
      console.error(
        `SCOPE-MATCH STOP: stream '${s.stream}' executed ${s.read} rows vs a dry-run baseline of ` +
          `${expected} (>${SCOPE_MATCH_MAX_RATIO}x divergence). This can happen if the source file grew ` +
          `a lot between the dry-run and execute passes — re-run and compare before trusting the result.`
      );
      stopped = true;
    }
  }
  if (stopped) {
    process.exitCode = 1;
    return;
  }

  if (executeSummary.totalErrors > 0) {
    console.error(`${executeSummary.totalErrors} stream(s) errored — see per-stream output above.`);
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  await main();
}
