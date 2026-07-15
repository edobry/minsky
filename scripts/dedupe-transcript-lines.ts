#!/usr/bin/env bun
/**
 * mt#2805 cleanup tool: dedupe `agent_transcripts.transcript` jsonb arrays
 * whose lines were duplicated by the mt#2789 concurrent-ingest race (two
 * ingest actors both reading a stale high-water-mark and both appending the
 * same batch via the pre-fix dedup-less `||` concat).
 *
 * Per row, removes array elements whose line `uuid` duplicates an EARLIER
 * element — keep first occurrence, preserve order. Elements without a string
 * `uuid` are NEVER removed (they can't be proven duplicates; mirrors the
 * merged mt#2789 write-path invariant). The `agent_transcript_attachments`
 * sibling table is never touched (PK'd by lineIndex + onConflictDoNothing,
 * so the race couldn't duplicate it).
 *
 * Dry-run by default (mutates nothing; prints affected rows + per-row
 * duplicate counts). Pass --execute to write. Pass --session <id> to bound
 * the run to a single agent_transcripts row (audited bounded execute /
 * targeted re-run). Per `operational-safety.mdc §Dry-run scope-match check`,
 * compare the dry-run magnitude against operator-approved scope before a
 * full-scope --execute; the full run is governed by mt#2805.
 *
 * Run:
 *   bun scripts/dedupe-transcript-lines.ts                             # dry-run, all rows
 *   bun scripts/dedupe-transcript-lines.ts --session <id>              # dry-run, one row
 *   bun scripts/dedupe-transcript-lines.ts --execute --session <id>    # bounded execute
 *   bun scripts/dedupe-transcript-lines.ts --execute                   # full execute (mt#2805, operator-approved)
 *
 * @see mt#2789 — write-path fix (uuid-deduped upsert) + diagnosis
 * @see mt#2805 — the governed bulk run
 * @see mt#2862 — this script
 */

// tsyringe (loaded transitively via the CLI container) requires the reflect
// polyfill before any DI import — same requirement as the sibling backfill
// scripts (mt#2768 finding).
import "reflect-metadata";
import { eq, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import { agentTranscriptsTable } from "@minsky/domain/storage/schemas/agent-transcripts-schema";
import { getErrorMessage } from "@minsky/domain/errors/index";

/** Canonical script DB bootstrap — mirrors scripts/backfill-minsky-session-links.ts. */
async function getDb(): Promise<PostgresJsDatabase> {
  const { initializeConfiguration, CustomConfigFactory } = await import(
    "@minsky/domain/configuration"
  );
  const { createCliContainer } = await import("../src/composition/cli");
  const { PersistenceProvider } = await import("@minsky/domain/persistence/types");

  await initializeConfiguration(new CustomConfigFactory(), {
    workingDirectory: process.cwd(),
  });

  const container = await createCliContainer();
  await container.initialize();

  const persistence = container.has("persistence") ? container.get("persistence") : undefined;
  if (!persistence || !(persistence instanceof PersistenceProvider)) {
    throw new Error("Dedupe requires a SQL-capable persistence provider (Postgres).");
  }
  if (!persistence.capabilities.sql || typeof persistence.getDatabaseConnection !== "function") {
    throw new Error("Dedupe requires a SQL-capable persistence provider (Postgres).");
  }

  const connection = await persistence.getDatabaseConnection();
  if (!connection) {
    throw new Error("Dedupe requires an initialized Postgres database connection.");
  }
  return connection as PostgresJsDatabase;
}

export interface TranscriptLine {
  uuid?: unknown;
  [key: string]: unknown;
}

export interface DedupeResult {
  /** Deduped array (first occurrence kept, order preserved). */
  deduped: TranscriptLine[];
  /** Number of removed elements. */
  removed: number;
}

/**
 * Remove elements whose string `uuid` duplicates an earlier element's.
 * Elements with a missing/non-string uuid are always kept.
 */
export function dedupeByLineUuid(lines: TranscriptLine[]): DedupeResult {
  const seen = new Set<string>();
  const deduped: TranscriptLine[] = [];
  let removed = 0;
  for (const line of lines) {
    const uuid = typeof line?.uuid === "string" ? line.uuid : null;
    if (uuid !== null) {
      if (seen.has(uuid)) {
        removed++;
        continue;
      }
      seen.add(uuid);
    }
    deduped.push(line);
  }
  return { deduped, removed };
}

function parseArgs(argv: string[]): { execute: boolean; session: string | null } {
  const execute = argv.includes("--execute");
  const sessionIdx = argv.indexOf("--session");
  const session =
    sessionIdx !== -1 && argv[sessionIdx + 1] && !argv[sessionIdx + 1].startsWith("--")
      ? argv[sessionIdx + 1]
      : null;
  if (sessionIdx !== -1 && session === null) {
    throw new Error("--session requires an agentSessionId argument");
  }
  return { execute, session };
}

async function main() {
  const { execute, session } = parseArgs(process.argv.slice(2));

  let db: PostgresJsDatabase;
  try {
    db = await getDb();
  } catch (err) {
    console.error("SKIP: failed to initialize DB connection.");
    console.error(getErrorMessage(err));
    process.exit(0);
  }

  // Fetch ids first, then each transcript individually — a single select of
  // every multi-MB transcript jsonb exceeds practical response limits.
  const idRows = session
    ? [{ agentSessionId: session }]
    : await db
        .select({ agentSessionId: agentTranscriptsTable.agentSessionId })
        .from(agentTranscriptsTable);

  let scanned = 0;
  let affected = 0;
  let totalRemoved = 0;
  let written = 0;
  let errored = 0;
  const affectedDetails: Array<{ id: string; lines: number; removed: number }> = [];

  for (const { agentSessionId } of idRows) {
    scanned++;
    let row: { agentSessionId: string; transcript: unknown } | undefined;
    try {
      const fetched = await db
        .select({
          agentSessionId: agentTranscriptsTable.agentSessionId,
          transcript: agentTranscriptsTable.transcript,
        })
        .from(agentTranscriptsTable)
        .where(eq(agentTranscriptsTable.agentSessionId, agentSessionId))
        .limit(1);
      row = fetched[0];
    } catch (err) {
      errored++;
      console.error(`  READ FAILED ${agentSessionId}: ${getErrorMessage(err)}`);
      continue;
    }
    if (!row) continue;
    const transcript = Array.isArray(row.transcript) ? (row.transcript as TranscriptLine[]) : null;
    if (!transcript || transcript.length === 0) continue;

    const { deduped, removed } = dedupeByLineUuid(transcript);
    if (removed === 0) continue;

    affected++;
    totalRemoved += removed;
    affectedDetails.push({ id: row.agentSessionId, lines: transcript.length, removed });

    if (execute) {
      try {
        await db
          .update(agentTranscriptsTable)
          .set({ transcript: sql`${JSON.stringify(deduped)}::jsonb` })
          .where(eq(agentTranscriptsTable.agentSessionId, row.agentSessionId));
        written++;
      } catch (err) {
        errored++;
        console.error(`  WRITE FAILED ${row.agentSessionId}: ${getErrorMessage(err)}`);
      }
    }
  }

  const mode = execute ? "EXECUTE" : "DRY-RUN";
  const scope = session ? `session=${session}` : "all rows";
  console.log(`[${mode}] transcript line-uuid dedupe (mt#2805) — ${scope}`);
  console.log(`  rows scanned:            ${scanned}`);
  console.log(`  rows with duplicates:    ${affected}`);
  console.log(`  duplicate lines total:   ${totalRemoved}`);
  if (execute) {
    console.log(`  rows rewritten:          ${written}`);
    console.log(`  write errors:            ${errored}`);
  }
  if (affectedDetails.length > 0) {
    console.log("");
    for (const d of affectedDetails.sort((a, b) => b.removed - a.removed)) {
      console.log(`  ${d.id}  lines=${d.lines}  duplicates=${d.removed}`);
    }
  }
  if (!execute && affected > 0) {
    console.log("");
    console.log("No writes performed. Re-run with --execute after operator scope approval.");
  }
  process.exit(errored > 0 ? 1 : 0);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(getErrorMessage(err));
    process.exit(1);
  });
}
