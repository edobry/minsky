/**
 * turn-writer — extraction half of the transcript pipeline (ADR-019).
 *
 * Materializes per-turn rows into `agent_transcript_turns` from a session's
 * `agent_transcripts.transcript` JSONB, WITHOUT generating embeddings. This is
 * the cheap, deterministic, API-free stage that makes a session FTS-searchable
 * (the `fts_text` GENERATED column populates automatically on the text-column
 * write). It runs on the ingest/capture path so a plain `transcripts ingest`
 * is FTS-ready with no embedding provider.
 *
 * Embedding is the separate, deferred stage owned by PerTurnEmbeddingPipeline,
 * which fills the `embedding` column on rows this module has already written.
 *
 * CRITICAL — embedding preservation: the upsert here writes text/metadata
 * columns only and MUST NOT touch the `embedding` column. A new row gets a NULL
 * embedding (filled later by the backfill); an existing row's embedding is left
 * intact (a capture-path text upsert over an already-embedded turn must not
 * clobber the vector). See ADR-019 §Consequences ("two writers on the same
 * rows").
 *
 * @see docs/architecture/adr-019-transcript-pipeline-staging.md
 * @see ./turn-extractor.ts — the pure extraction logic this reuses
 * @see ./per-turn-embedding-pipeline.ts — the embedding (vector-only) backfill
 * @see mt#2381 — this file
 */

import { sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import { agentTranscriptsTable } from "../storage/schemas/agent-transcripts-schema";
import { agentTranscriptTurnsTable } from "../storage/schemas/agent-transcript-turns-schema";
import { log } from "@minsky/shared/logger";
import { getErrorMessage } from "../errors/index";
import { extractTurns } from "./turn-extractor";
import type { RawTurnLine } from "./transcript-source";

/**
 * Extract per-turn rows from a session's transcript and upsert them into
 * `agent_transcript_turns` (text/metadata columns only — never `embedding`).
 *
 * Idempotent: existing rows are upserted on (agent_session_id, turn_index); the
 * `embedding` column is excluded from both the insert and the on-conflict SET,
 * so re-running preserves any embedding already present and re-materializing the
 * full transcript on each incremental append is safe.
 *
 * @param transcript - The session's full `agent_transcripts.transcript` JSONB
 *   (array of raw turn lines). Turn ordering / `turn_index` is assigned over the
 *   WHOLE transcript, so callers must pass the complete merged transcript, not
 *   an incremental slice.
 * @returns the number of turn rows written (upserted).
 */
export async function writeTurnsForTranscript(
  db: PostgresJsDatabase,
  agentSessionId: string,
  transcript: unknown
): Promise<number> {
  if (!Array.isArray(transcript) || transcript.length === 0) {
    return 0;
  }

  const turns = extractTurns(transcript as RawTurnLine[]);
  if (turns.length === 0) {
    return 0;
  }

  let written = 0;
  for (const turn of turns) {
    // NOTE: `embedding` is deliberately omitted — capture writes text only.
    // `fts_text` is GENERATED ALWAYS and must not be written either.
    const insertValues = {
      agentSessionId,
      turnIndex: turn.turnIndex,
      userText: turn.userText ?? undefined,
      assistantText: turn.assistantText ?? undefined,
      toolCalls: turn.toolCalls ? JSON.stringify(turn.toolCalls) : undefined,
      startedAt: turn.startedAt ?? undefined,
      endedAt: turn.endedAt ?? undefined,
      isSpawnBoundary: turn.isSpawnBoundary,
    };

    try {
      await db
        .insert(agentTranscriptTurnsTable)
        .values(insertValues)
        .onConflictDoUpdate({
          target: [agentTranscriptTurnsTable.agentSessionId, agentTranscriptTurnsTable.turnIndex],
          // `embedding` is intentionally NOT in this SET — preserve any vector
          // the backfill already filled (ADR-019 embedding-preservation invariant).
          set: {
            userText: sql`EXCLUDED.user_text`,
            assistantText: sql`EXCLUDED.assistant_text`,
            toolCalls: sql`EXCLUDED.tool_calls`,
            startedAt: sql`EXCLUDED.started_at`,
            endedAt: sql`EXCLUDED.ended_at`,
            isSpawnBoundary: sql`EXCLUDED.is_spawn_boundary`,
          },
        });
      written++;
    } catch (err) {
      log.warn(
        `writeTurnsForTranscript: failed to upsert turn ${agentSessionId}[${turn.turnIndex}]`,
        {
          error: getErrorMessage(err),
        }
      );
    }
  }

  return written;
}

/** Aggregate result of an extraction reconciliation sweep. */
export interface ExtractAllTurnsResult {
  transcriptsScanned: number;
  transcriptsProcessed: number;
  transcriptsSkipped: number;
  transcriptsErrored: number;
  turnsWritten: number;
}

/**
 * Extraction reconciliation: ensure every `agent_transcripts` row has its turns
 * materialized into `agent_transcript_turns`. This is the catch-up for sessions
 * that were ingested before extraction-on-capture existed (or whose turn rows
 * were otherwise lost). Idempotent (text-only upsert, embedding-preserving).
 *
 * The forward path (new captures) extracts via `writeTurnsForTranscript` inside
 * the ingest service; this sweep covers historical/already-ingested data. The
 * embedding backfill (PerTurnEmbeddingPipeline) stays vector-only and relies on
 * these rows existing — it does not re-extract (ADR-019).
 */
export async function extractTurnsForAllTranscripts(
  db: PostgresJsDatabase
): Promise<ExtractAllTurnsResult> {
  const result: ExtractAllTurnsResult = {
    transcriptsScanned: 0,
    transcriptsProcessed: 0,
    transcriptsSkipped: 0,
    transcriptsErrored: 0,
    turnsWritten: 0,
  };

  let rows: Array<{ agentSessionId: string; transcript: unknown }>;
  try {
    rows = await db
      .select({
        agentSessionId: agentTranscriptsTable.agentSessionId,
        transcript: agentTranscriptsTable.transcript,
      })
      .from(agentTranscriptsTable);
  } catch (err) {
    log.error("extractTurnsForAllTranscripts: failed to load transcripts", {
      error: getErrorMessage(err),
    });
    return result;
  }

  result.transcriptsScanned = rows.length;

  for (const row of rows) {
    try {
      const written = await writeTurnsForTranscript(db, row.agentSessionId, row.transcript);
      if (written === 0) {
        result.transcriptsSkipped++;
      } else {
        result.transcriptsProcessed++;
        result.turnsWritten += written;
      }
    } catch (err) {
      result.transcriptsErrored++;
      log.warn(`extractTurnsForAllTranscripts: failed for ${row.agentSessionId}`, {
        error: getErrorMessage(err),
      });
    }
  }

  log.info("extractTurnsForAllTranscripts: complete", { ...result });
  return result;
}
