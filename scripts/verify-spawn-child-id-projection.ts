#!/usr/bin/env bun
/**
 * mt#3962 verification: prove the Agent result's child id survives the round
 * trip — raw transcript → turn extraction → `tool_calls` → the spawns pipeline's
 * resolution — against REAL stored data.
 *
 * Why this exists rather than only unit tests: the unit tests assert the
 * extractor's behavior on hand-built fixtures, which cannot tell you the real
 * records have the shape the fixtures claim. This reads actual transcripts and
 * reports what the projection would produce, so the fixture's shape assumption
 * is checked against production rather than assumed (mem#704: a probe that
 * cannot fail is not verification — this one fails loudly if `toolUseResult`
 * turns out not to carry `agentId`, or if the id form does not match a stored
 * transcript).
 *
 * Read-only by default and always: this script never writes. The actual
 * backfill is `scripts/backfill-agent-transcript-turns.ts --execute` (which
 * re-extracts every transcript, rewriting `tool_calls` with the projected id),
 * followed by a spawns-extract pass.
 *
 * Usage:
 *   bun scripts/verify-spawn-child-id-projection.ts            # sample 40 conversations
 *   bun scripts/verify-spawn-child-id-projection.ts --limit 5  # bound the sample
 *
 * Exit codes: 0 = the projection resolves at least one spawn that is unresolved
 * today; 1 = it resolves none (the mechanism is not delivering); 0 with a SKIP
 * notice when Postgres is unavailable.
 *
 * @see mt#3962 — this script's task
 * @see mt#3702 — the refusal rule this unblocks
 */
import "reflect-metadata";
import { sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { SqlCapablePersistenceProvider } from "@minsky/domain/persistence/types";
// collectChildAgentSessionIds already returns ids in the transcript-side
// (`agent-`-prefixed) form, so this script compares them to
// `agent_transcripts.agent_session_id` directly rather than re-normalizing.
import { collectChildAgentSessionIds } from "@minsky/domain/transcripts/turn-extractor";
import { parseIntFlag } from "./clear-ambiguous-spawn-links";
import { getLoggableErrorSummary } from "@minsky/domain/errors/index";

const DEFAULT_SAMPLE = 40;

interface TranscriptRow {
  agent_session_id: string;
  transcript: unknown;
}

interface ProjectionReport {
  conversationsSampled: number;
  conversationsCarryingResultIds: number;
  callsWithAChildId: number;
  childTranscriptIngested: number;
  wouldResolveAnUnresolvedRow: number;
  multiSpawnTurnsResolvingToDistinctChildren: number;
}

async function getDb(): Promise<PostgresJsDatabase> {
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
    throw new Error("This verification requires a SQL-capable persistence provider (Postgres).");
  }
  const sqlProvider = persistence as SqlCapablePersistenceProvider;
  const connection = await sqlProvider.getDatabaseConnection();
  if (!connection)
    throw new Error("This verification requires an initialized Postgres connection.");
  return connection as PostgresJsDatabase;
}

/** Conversations that dispatched agents whose child is still unresolved today. */
async function fetchSampleTranscripts(
  db: PostgresJsDatabase,
  limit: number
): Promise<TranscriptRow[]> {
  const rows = await db.execute(sql`
    SELECT t.agent_session_id, t.transcript
    FROM agent_transcripts t
    WHERE t.agent_session_id IN (
      SELECT DISTINCT parent_agent_session_id
      FROM agent_spawns
      WHERE parent_tool_use_id IS NOT NULL AND child_agent_session_id IS NULL
    )
    ORDER BY t.agent_session_id
    LIMIT ${limit}::bigint
  `);
  return Array.from(rows as Iterable<TranscriptRow>);
}

export async function buildProjectionReport(
  db: PostgresJsDatabase,
  limit: number
): Promise<ProjectionReport> {
  const transcripts = await fetchSampleTranscripts(db, limit);

  const report: ProjectionReport = {
    conversationsSampled: transcripts.length,
    conversationsCarryingResultIds: 0,
    callsWithAChildId: 0,
    childTranscriptIngested: 0,
    wouldResolveAnUnresolvedRow: 0,
    multiSpawnTurnsResolvingToDistinctChildren: 0,
  };

  for (const row of transcripts) {
    const lines = Array.isArray(row.transcript) ? row.transcript : [];
    const childIds = collectChildAgentSessionIds(lines as never);
    if (childIds.size === 0) continue;

    report.conversationsCarryingResultIds++;
    report.callsWithAChildId += childIds.size;

    for (const [toolUseId, childId] of childIds) {
      const checks = await db.execute(sql`
        SELECT
          EXISTS (SELECT 1 FROM agent_transcripts WHERE agent_session_id = ${childId}) AS child_ingested,
          EXISTS (
            SELECT 1 FROM agent_spawns
             WHERE parent_agent_session_id = ${row.agent_session_id}
               AND parent_tool_use_id = ${toolUseId}
               AND child_agent_session_id IS NULL
          ) AS row_unresolved
      `);
      const check = Array.from(
        checks as Iterable<{ child_ingested: boolean; row_unresolved: boolean }>
      )[0];
      if (check?.child_ingested) report.childTranscriptIngested++;
      if (check?.child_ingested && check?.row_unresolved) report.wouldResolveAnUnresolvedRow++;
    }

    // The 0-of-159 case: a turn dispatching several agents whose results name
    // DIFFERENT children. Counting it here proves the projection separates
    // siblings, which no margin on the cwd-time heuristic can do.
    //
    // Which calls share a turn is read from `agent_spawns` rather than
    // re-derived from the raw lines. Re-deriving would mean reimplementing
    // extractTurns's pairing — and doing it wrong: one model turn can span
    // several assistant LINES (mt#3883), so counting Agent calls per line
    // splits a genuine sibling pair across two "turns" and reports 0 for a
    // conversation that has them. The spawns table already carries the
    // authoritative grouping.
    const multiSpawnTurns = await db.execute(sql`
      SELECT parent_turn_index,
             array_agg(parent_tool_use_id) FILTER (WHERE parent_tool_use_id IS NOT NULL) AS tool_use_ids
      FROM agent_spawns
      WHERE parent_agent_session_id = ${row.agent_session_id}
      GROUP BY parent_turn_index
      HAVING count(*) > 1
    `);

    for (const turn of Array.from(multiSpawnTurns as Iterable<{ tool_use_ids: string[] | null }>)) {
      const children = new Set(
        (turn.tool_use_ids ?? [])
          .map((id) => childIds.get(id))
          .filter((child): child is string => Boolean(child))
      );
      if (children.size > 1) report.multiSpawnTurnsResolvingToDistinctChildren++;
    }
  }

  return report;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const limit = parseIntFlag(argv, "--limit", 1) ?? DEFAULT_SAMPLE;

  let db: PostgresJsDatabase;
  try {
    db = await getDb();
  } catch (err) {
    console.error("SKIP: Postgres not available in this environment.");
    console.error(getLoggableErrorSummary(err));
    process.exit(0);
  }

  const report = await buildProjectionReport(db, limit);

  console.log(`Conversations sampled:                        ${report.conversationsSampled}`);
  console.log(
    `  …carrying Agent result ids:                 ${report.conversationsCarryingResultIds}`
  );
  console.log(`Agent calls with a projected child id:        ${report.callsWithAChildId}`);
  console.log(`  …whose child transcript is ingested:        ${report.childTranscriptIngested}`);
  console.log(
    `  …that would resolve a row unresolved today: ${report.wouldResolveAnUnresolvedRow}`
  );
  console.log(
    `Multi-spawn turns resolving to DISTINCT children: ${report.multiSpawnTurnsResolvingToDistinctChildren}`
  );
  console.log(`  (this figure is 0 for the entire corpus today — mt#3962's premise)`);

  if (report.wouldResolveAnUnresolvedRow === 0) {
    console.error(
      "\nFAILED: the projection resolves nothing on this sample. Either the result ids are " +
        "absent from stored transcripts, or the id form does not match a stored conversation."
    );
    process.exit(1);
  }

  console.log("\nOK: the projection resolves spawns the current pipeline leaves unresolved.");
  process.exit(0);
}

if (import.meta.main) {
  void main();
}
