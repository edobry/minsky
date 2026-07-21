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

import { gt, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import { agentTranscriptsTable } from "../storage/schemas/agent-transcripts-schema";
import { agentTranscriptTurnsTable } from "../storage/schemas/agent-transcript-turns-schema";
import { log } from "@minsky/shared/logger";
import { getErrorMessage } from "../errors/index";
import { extractTurns } from "./turn-extractor";
import type { RawTurnLine } from "./transcript-source";
import type { ConversationId } from "../ids";

/** Result of a single-transcript extraction attempt (mt#2457 SC3). */
export interface WriteTurnsResult {
  /** Number of turn rows written (upserted). */
  written: number;
  /**
   * True when `transcript` was a non-empty array (real content) but
   * extraction yielded zero turns — an extractor-shape mismatch or upstream
   * parsing bug, NOT the "genuinely empty/absent transcript" case (which
   * returns `written: 0, nonEmptyYieldedZero: false`). Before mt#2457 this
   * distinction was invisible: both cases silently produced `written: 0` and
   * the caller (`extractTurnsForAllTranscripts`'s `transcriptsSkipped++`, or
   * the forward ingest path's discarded return value) had no way to tell a
   * real failure from "nothing to do."
   */
  nonEmptyYieldedZero: boolean;
}

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
 * @returns `{ written, nonEmptyYieldedZero }` — see `WriteTurnsResult`.
 */
export async function writeTurnsForTranscript(
  db: PostgresJsDatabase,
  agentSessionId: string,
  transcript: unknown
): Promise<WriteTurnsResult> {
  if (!Array.isArray(transcript) || transcript.length === 0) {
    return { written: 0, nonEmptyYieldedZero: false };
  }

  const turns = extractTurns(transcript as RawTurnLine[]);
  if (turns.length === 0) {
    // mt#2457 SC3: a non-empty transcript that extracts to zero turns is a
    // loud failure signal — the extractor didn't recognize this era's/shape's
    // JSONB, which is indistinguishable from a genuinely-empty session unless
    // we say so explicitly. Never silently swallow this.
    log.warn(
      `writeTurnsForTranscript: non-empty transcript (${transcript.length} raw lines) yielded ` +
        `zero turns for session ${agentSessionId} — possible extractor-shape mismatch`,
      { agentSessionId, transcriptLines: transcript.length }
    );
    return { written: 0, nonEmptyYieldedZero: true };
  }

  // mt#2457 perf: upsert in bulk, chunked, rather than one round-trip per
  // turn. A handful of legacy sessions run into the thousands of turns (up
  // to ~4,511 raw lines observed in the 2026-07-20 corpus measurement) —
  // per-turn serial round-trips to a remote Postgres made even a single such
  // session take on the order of a minute, which is what actually made the
  // full-corpus backfill impractical (not just the outer unbatched SELECT).
  // CHUNK_SIZE keeps each statement's bind-parameter count (8 columns/row)
  // comfortably under Postgres's ~65535 parameter limit for any plausible
  // session size, while collapsing thousands of round-trips into a handful.
  const CHUNK_SIZE = 500;
  let written = 0;
  for (let i = 0; i < turns.length; i += CHUNK_SIZE) {
    const chunk = turns.slice(i, i + CHUNK_SIZE);
    // NOTE: `embedding` is deliberately omitted — capture writes text only.
    // `fts_text` is GENERATED ALWAYS and must not be written either.
    const insertValues = chunk.map((turn) => ({
      agentSessionId,
      turnIndex: turn.turnIndex,
      userText: turn.userText ?? undefined,
      assistantText: turn.assistantText ?? undefined,
      // Pass the array directly — `tool_calls` is a jsonb column and Drizzle
      // serializes the value. JSON.stringify here would DOUBLE-encode it (store a
      // quoted JSON string, jsonb_typeof = 'string'), which breaks downstream
      // `Array.isArray(tool_calls)` checks (agent-spawns-pipeline.findAgentToolCall).
      // (Pre-mt#2381 rows are double-encoded; extractTurnsForAllTranscripts
      // re-materializes and corrects them on the next index-embeddings --all.)
      toolCalls: turn.toolCalls ?? undefined,
      startedAt: turn.startedAt ?? undefined,
      endedAt: turn.endedAt ?? undefined,
      isSpawnBoundary: turn.isSpawnBoundary,
    }));

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
      written += chunk.length;
    } catch (err) {
      log.warn(
        `writeTurnsForTranscript: failed to upsert a chunk of ${chunk.length} turns for ` +
          `${agentSessionId} (turns ${chunk[0]?.turnIndex}-${chunk[chunk.length - 1]?.turnIndex})`,
        {
          error: getErrorMessage(err),
        }
      );
    }
  }

  return { written, nonEmptyYieldedZero: false };
}

/** Aggregate result of an extraction reconciliation sweep. */
export interface ExtractAllTurnsResult {
  transcriptsScanned: number;
  transcriptsProcessed: number;
  transcriptsSkipped: number;
  transcriptsErrored: number;
  turnsWritten: number;
  /**
   * mt#2457 SC3: count of non-empty transcripts that yielded zero turns — a
   * subset of `transcriptsSkipped` that signals an extraction failure (not a
   * genuinely-empty-session skip). Non-zero here means something needs
   * investigating; it should not happen in steady state.
   */
  nonEmptyYieldedZero: number;
}

/** One page of `(agentSessionId, transcript)` rows for the reconciliation sweep. */
export type TranscriptPageRow = { agentSessionId: string; transcript: unknown };

/**
 * Fetches one keyset-paginated page of `agent_transcripts` rows, ordered by
 * `agent_session_id` (the table's primary key — no new index required).
 * Exposed as an injectable seam (`ExtractAllTurnsOptions.fetchPage`) so
 * `extractTurnsForAllTranscripts`'s batching/resumability logic is testable
 * without mocking the drizzle query-builder chain.
 */
export async function fetchTranscriptPage(
  db: PostgresJsDatabase,
  afterId: string | null,
  batchSize: number
): Promise<TranscriptPageRow[]> {
  const query = db
    .select({
      agentSessionId: agentTranscriptsTable.agentSessionId,
      transcript: agentTranscriptsTable.transcript,
    })
    .from(agentTranscriptsTable)
    .orderBy(agentTranscriptsTable.agentSessionId)
    .limit(batchSize);

  return afterId
    ? query.where(gt(agentTranscriptsTable.agentSessionId, afterId as ConversationId))
    : query;
}

/** Default page size for the batched reconciliation sweep (mt#2457 perf constraint). */
export const DEFAULT_EXTRACT_ALL_BATCH_SIZE = 100;

export interface ExtractAllTurnsOptions {
  /**
   * Rows fetched per batch, keyset-paginated by `agent_session_id` ascending.
   * The unbatched full-corpus load this replaces did not complete in 280s
   * locally against ~1,584 large-JSONB rows (mt#2457 perf constraint) — a
   * bounded page size keeps memory and per-query latency flat regardless of
   * corpus size. Defaults to `DEFAULT_EXTRACT_ALL_BATCH_SIZE`.
   */
  batchSize?: number;
  /**
   * Resume a previous run: skip all rows with `agent_session_id <=` this
   * value. Combine with `onBatchComplete` to make a long backfill resumable
   * after an interruption.
   */
  afterId?: string;
  /**
   * Injectable page fetcher. Production default is `fetchTranscriptPage`
   * (real Postgres keyset pagination); tests can supply an in-memory fake.
   */
  fetchPage?: (
    db: PostgresJsDatabase,
    afterId: string | null,
    batchSize: number
  ) => Promise<TranscriptPageRow[]>;
  /**
   * Called after each batch is processed with the running aggregate result
   * and the last `agentSessionId` seen in that batch — a checkpoint a caller
   * (e.g. a backfill script) can persist so the sweep is resumable via
   * `afterId` if interrupted.
   */
  onBatchComplete?: (
    partial: Readonly<ExtractAllTurnsResult>,
    lastId: string
  ) => void | Promise<void>;
}

/**
 * Extraction reconciliation: ensure every `agent_transcripts` row has its turns
 * materialized into `agent_transcript_turns`. This is the catch-up for sessions
 * that were ingested before extraction-on-capture existed (or whose turn rows
 * were otherwise lost). Idempotent (text-only upsert, embedding-preserving).
 *
 * Batched/bounded/resumable (mt#2457): rows are fetched in keyset-paginated
 * pages instead of one unbounded full-corpus `SELECT *`, so the sweep's memory
 * and per-query latency stay flat as the corpus grows, and a long run can be
 * checkpointed (`onBatchComplete`) and resumed (`afterId`).
 *
 * The forward path (new captures) extracts via `writeTurnsForTranscript` inside
 * the ingest service; this sweep covers historical/already-ingested data. The
 * embedding backfill (PerTurnEmbeddingPipeline) stays vector-only and relies on
 * these rows existing — it does not re-extract (ADR-019).
 */
export async function extractTurnsForAllTranscripts(
  db: PostgresJsDatabase,
  options: ExtractAllTurnsOptions = {}
): Promise<ExtractAllTurnsResult> {
  const batchSize = options.batchSize ?? DEFAULT_EXTRACT_ALL_BATCH_SIZE;
  const fetchPage = options.fetchPage ?? fetchTranscriptPage;

  const result: ExtractAllTurnsResult = {
    transcriptsScanned: 0,
    transcriptsProcessed: 0,
    transcriptsSkipped: 0,
    transcriptsErrored: 0,
    turnsWritten: 0,
    nonEmptyYieldedZero: 0,
  };

  let cursor: string | null = options.afterId ?? null;

  for (;;) {
    let rows: TranscriptPageRow[];
    try {
      rows = await fetchPage(db, cursor, batchSize);
    } catch (err) {
      log.error("extractTurnsForAllTranscripts: failed to load a transcript batch", {
        error: getErrorMessage(err),
        cursor,
      });
      break;
    }

    if (rows.length === 0) break;

    result.transcriptsScanned += rows.length;
    let lastId: string | undefined;

    for (const row of rows) {
      lastId = row.agentSessionId;
      try {
        const { written, nonEmptyYieldedZero } = await writeTurnsForTranscript(
          db,
          row.agentSessionId,
          row.transcript
        );
        if (written === 0) {
          result.transcriptsSkipped++;
          if (nonEmptyYieldedZero) {
            result.nonEmptyYieldedZero++;
          }
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

    if (lastId !== undefined) {
      cursor = lastId;
      if (options.onBatchComplete) {
        await options.onBatchComplete({ ...result }, cursor);
      }
    }

    if (rows.length < batchSize) break; // last page
  }

  log.info("extractTurnsForAllTranscripts: complete", { ...result });
  return result;
}
