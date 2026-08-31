#!/usr/bin/env bun
/**
 * Backfill pre-cutover guard telemetry from the repo working tree — mt#4826.
 *
 * ## What this recovers
 *
 * mt#4748 (2026-08-30) re-rooted calibration/evaluation telemetry from the repo working tree to
 * the project-keyed state dir. mt#4804 then registered 27 streams that were missing from the
 * ingest manifest. Registering them backfilled the streams' STATE-DIR files — everything written
 * after the cutover — and left the pre-cutover records untouched, because `resolveStreamPath`
 * resolves these families to the state dir and the ingest never looks at the working tree.
 *
 * Measured 2026-08-31: the two locations hold DISJOINT spans meeting at mt#4748's merge (repo
 * tree ends `2026-08-30T19:42:55Z`, state dir starts `19:44:39Z`). 107,828 lines — 107,787 unique
 * — sit only in the working tree.
 *
 * ## Why it reuses the sweep instead of reimplementing it
 *
 * `GuardEventsIngestDeps` is fully injectable, so the whole shipped pipeline — tail reading, JSONL
 * parsing, promoted-field extraction, dedupe-key computation, batched `ON CONFLICT DO NOTHING`
 * insert, project-id resolution — runs unchanged. This script overrides exactly three seams:
 *
 *  1. `resolvePath` → the WORKING-TREE path instead of the state-dir path.
 *  2. `readHwm` → always `{}`, so every stream starts at byte offset 0.
 *  3. `writeHwm` → a no-op, so the real high-water-mark file is never touched.
 *
 * That last pair is what makes this safe to run beside live detectors. The real HWM keeps pointing
 * into the state-dir files at the offset the normal sweep left it; this run neither reads nor
 * advances it. A merge into the state-dir file would NOT have this property — the ingest tails by
 * byte offset, so prepending puts the stored offset mid-block and appending races the writers.
 *
 * Re-running is safe: `computeDedupeKey` is `sha256(stream + "\n" + line)`, purely content-based
 * with no offset or file identity in it, so a second run inserts nothing.
 *
 * ## Usage
 *
 *   bun scripts/backfill-precutover-telemetry.ts                      # dry run (default)
 *   bun scripts/backfill-precutover-telemetry.ts --only <stream> --limit 5 --execute
 *   bun scripts/backfill-precutover-telemetry.ts --execute            # full backfill
 *
 * Authorized by ask#11117 ("Ingest the 5 too") — full registration of this population, including
 * the 2,336 text-bearing records across 5 streams.
 *
 * @see mt#4826 — this task
 * @see mt#4804 — registered the streams; backfilled only the post-cutover tail
 * @see mt#4777 — blocked on this: its files are NOT redundant until these records land
 */

import "reflect-metadata";

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { SqlCapablePersistenceProvider } from "@minsky/domain/persistence/types";
import type {
  GuardEventsIngestDeps,
  GuardEventsIngestSummary,
} from "@minsky/domain/guard-events/ingest-service";
import type { GuardEventStreamSource } from "@minsky/domain/guard-events/stream-sources";

/** Families that ever lived in the working tree. Others were always state-dir or flat. */
const LEGACY_FAMILIES = new Set(["calibration", "evaluation"]);

/** Where the pre-cutover files still are, relative to the repo root. */
const LEGACY_DIR = ".minsky";

interface Options {
  execute: boolean;
  only: string | null;
  limit: number | null;
}

function parseArgs(argv: string[]): Options {
  const execute = argv.includes("--execute");
  const onlyIdx = argv.indexOf("--only");
  const limitIdx = argv.indexOf("--limit");
  const only = onlyIdx >= 0 ? (argv[onlyIdx + 1] ?? null) : null;
  const rawLimit = limitIdx >= 0 ? (argv[limitIdx + 1] ?? null) : null;
  const limit = rawLimit === null ? null : Number.parseInt(rawLimit, 10);
  if (limit !== null && (!Number.isFinite(limit) || limit <= 0)) {
    throw new Error(`--limit expects a positive integer, got: ${String(rawLimit)}`);
  }
  return { execute, only, limit };
}

async function getDb() {
  const { initializeConfiguration, CustomConfigFactory } = await import(
    "@minsky/domain/configuration"
  );
  const { createCliContainer } = await import("../src/composition/cli");
  const { PersistenceProvider } = await import("@minsky/domain/persistence/types");

  await initializeConfiguration(new CustomConfigFactory(), { workingDirectory: process.cwd() });

  const container = await createCliContainer();
  await container.initialize();

  const persistence = container.has("persistence") ? container.get("persistence") : undefined;
  if (!persistence || !(persistence instanceof PersistenceProvider)) {
    throw new Error("This backfill requires a SQL-capable persistence provider (Postgres).");
  }
  if (!persistence.capabilities.sql || typeof persistence.getDatabaseConnection !== "function") {
    throw new Error("This backfill requires a SQL-capable persistence provider (Postgres).");
  }

  const connection = await (persistence as SqlCapablePersistenceProvider).getDatabaseConnection();
  if (!connection) {
    throw new Error("This backfill requires an initialized Postgres database connection.");
  }
  return connection;
}

/** The pre-cutover path for a stream — `.minsky/<relativePath>`, repo-rooted. */
export function legacyPathFor(repoRoot: string, source: GuardEventStreamSource): string {
  return join(repoRoot, LEGACY_DIR, source.relativePath);
}

/**
 * Streams that have a pre-cutover file to recover.
 *
 * Filters on BOTH family and file existence: a manifest row whose legacy file is absent has
 * nothing to backfill, and the state-dir copy is already handled by the normal sweep.
 */
export function selectLegacyStreams(
  streams: readonly GuardEventStreamSource[],
  repoRoot: string,
  only: string | null,
  fileExists: (p: string) => boolean = existsSync
): GuardEventStreamSource[] {
  return streams.filter((s) => {
    if (!LEGACY_FAMILIES.has(s.family)) return false;
    if (only !== null && s.stream !== only) return false;
    return fileExists(legacyPathFor(repoRoot, s));
  });
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const repoRoot = process.cwd();

  const { buildGuardEventsIngestDeps } = await import("@minsky/domain/guard-events/ingest-runtime");
  const { runGuardEventsIngestSweep } = await import("@minsky/domain/guard-events/ingest-service");
  const { GUARD_EVENT_STREAM_SOURCES } = await import("@minsky/domain/guard-events/stream-sources");

  const streams = selectLegacyStreams(GUARD_EVENT_STREAM_SOURCES, repoRoot, opts.only);
  if (streams.length === 0) {
    console.log("No pre-cutover files found — nothing to backfill.");
    return;
  }

  const totalLines = streams.reduce((n, s) => {
    const p = legacyPathFor(repoRoot, s);
    return (
      n +
      readFileSync(p, "utf-8")
        .split("\n")
        .filter((l) => l.length > 0).length
    );
  }, 0);

  console.log(
    `${opts.execute ? "EXECUTE" : "DRY RUN"} — ${streams.length} stream(s), ${totalLines} line(s)`
  );
  if (opts.only) console.log(`  scoped to stream: ${opts.only}`);
  if (opts.limit) console.log(`  capped at ${opts.limit} record(s) per stream`);

  const db = await getDb();
  const real = buildGuardEventsIngestDeps(db as never, {
    repoRoot,
    // Uncapped by default: the largest stream holds 36,174 records and the shipped
    // per-tick default is 20,000, which would silently truncate it to a partial backfill.
    maxRecordsPerStreamPerTick: opts.limit ?? Number.MAX_SAFE_INTEGER,
  });

  let plannedRows = 0;
  const deps: GuardEventsIngestDeps = {
    ...real,
    streams,
    // (1) read the pre-cutover location, not the state dir
    resolvePath: (source) => legacyPathFor(repoRoot, source),
    // (2) always start at offset 0 — these streams have never been read from here
    readHwm: () => ({}),
    // (3) never touch the real HWM: it belongs to the state-dir files the live sweep owns
    writeHwm: () => {},
    insertBatch: async (rows) => {
      plannedRows += rows.length;
      if (!opts.execute) return 0;
      return real.insertBatch(rows);
    },
  };

  const summary: GuardEventsIngestSummary = await runGuardEventsIngestSweep(deps);

  for (const s of summary.perStream) {
    if (s.error) {
      console.error(`  ERROR ${s.stream}: ${s.error}`);
      continue;
    }
    const suffix = s.truncated ? "  [TRUNCATED]" : "";
    console.log(`  ${s.stream}: read ${s.read}, inserted ${s.inserted}${suffix}`);
  }

  console.log("---");
  console.log(
    `streams=${summary.streamsChecked} read=${summary.totalRead} ` +
      `${opts.execute ? `inserted=${summary.totalInserted}` : `wouldInsert=${plannedRows}`} ` +
      `errors=${summary.totalErrors}`
  );

  if (!opts.execute) {
    console.log("\nDry run — nothing was written. Re-run with --execute to apply.");
  }

  if (summary.totalErrors > 0) process.exitCode = 1;
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.stack : String(err));
    process.exitCode = 1;
  });
}
