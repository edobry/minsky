/**
 * ToolCallProjectionPipeline
 *
 * Post-pass orchestrator — same architecture as `AgentSpawnsPipeline`
 * (mt#1327) — that reads `agent_transcript_turns.tool_calls` for a session
 * and upserts one row per `tool_use` block into `agent_tool_call_projection`:
 * the shared, cheap, ordered read surface for the EngProd miner (mt#3330)
 * and mt#1120's supervision analysis.
 *
 * `runForSession` is called inline from `AgentTranscriptIngestService`
 * right after spawn extraction (mirroring mt#3109's placement), so every
 * ingest path — transcripts_ingest, the MCP boot sweep, the SessionEnd hook,
 * and the cadence sweep — writes projection rows with no per-consumer
 * duplication (all four funnel through `ingestSession`).
 * `projectToolCallsForAllTranscripts` drives the same per-session logic in a
 * batched, resumable sweep for the one-time backfill
 * (`scripts/backfill-agent-tool-call-projection.ts`).
 *
 * Idempotent: upserts on (agent_session_id, turn_index, ordinal).
 *
 * @see mt#3329 — this file
 * @see agent-tool-call-projection-schema.ts — destination table
 * @see agent-spawns-pipeline.ts — architectural precedent
 * @see turn-writer.ts — source table (agent_transcript_turns) + the
 *   fetchTranscriptPage / keyset-pagination convention this mirrors
 */

import { eq, and, gt, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import { agentTranscriptTurnsTable } from "../storage/schemas/agent-transcript-turns-schema";
import { agentTranscriptsTable } from "../storage/schemas/agent-transcripts-schema";
import { agentToolCallProjectionTable } from "../storage/schemas/agent-tool-call-projection-schema";
import { parseToolName, computeArgFingerprint } from "./tool-call-projection-fields";
import { log } from "@minsky/shared/logger";
import { getLoggableErrorSummary } from "../errors/index";
import type { ConversationId } from "../ids";

// ── Types ─────────────────────────────────────────────────────────────────────

interface ToolUseBlock {
  type?: string;
  name?: string;
  input?: unknown;
  [key: string]: unknown;
}

interface TurnRow {
  turnIndex: number;
  toolCalls: unknown;
  startedAt: Date | null;
  endedAt: Date | null;
}

/** Result of projecting tool calls for one session. */
export interface ToolCallProjectionRunResult {
  /** Turns scanned that had a non-null tool_calls column. */
  turnsScanned: number;
  /** tool_use blocks upserted into agent_tool_call_projection. */
  toolCallsProjected: number;
  /** Turns whose projection failed (query or insert error) — logged, not thrown. */
  turnsErrored: number;
}

const emptyRunResult = (): ToolCallProjectionRunResult => ({
  turnsScanned: 0,
  toolCallsProjected: 0,
  turnsErrored: 0,
});

// ── Pipeline ──────────────────────────────────────────────────────────────────

export class ToolCallProjectionPipeline {
  constructor(private readonly db: PostgresJsDatabase) {}

  /**
   * Project tool calls for a single session. Used both by the incremental
   * ingest path (one session at a time) and by the batched full-corpus sweep
   * below (one session per iteration).
   */
  async runForSession(agentSessionId: string): Promise<ToolCallProjectionRunResult> {
    const result = emptyRunResult();

    let rows: TurnRow[];
    try {
      rows = await this.db
        .select({
          turnIndex: agentTranscriptTurnsTable.turnIndex,
          toolCalls: agentTranscriptTurnsTable.toolCalls,
          startedAt: agentTranscriptTurnsTable.startedAt,
          endedAt: agentTranscriptTurnsTable.endedAt,
        })
        .from(agentTranscriptTurnsTable)
        .where(
          and(
            eq(agentTranscriptTurnsTable.agentSessionId, agentSessionId),
            sql`${agentTranscriptTurnsTable.toolCalls} IS NOT NULL`
          )
        );
    } catch (err) {
      log.error(`ToolCallProjectionPipeline: failed to load turns for session ${agentSessionId}`, {
        error: getLoggableErrorSummary(err),
      });
      return result;
    }

    // Defensive: an awaited query is expected to resolve to an array (real
    // drizzle always does). Guarding here — rather than letting a malformed
    // result throw an unguarded TypeError out of the `for...of` loop below —
    // matches AgentSpawnsPipeline's fail-open posture for its own query
    // failures: never let a derived-table writer crash the shared ingest path.
    if (!Array.isArray(rows)) {
      log.error(
        `ToolCallProjectionPipeline: turns query for session ${agentSessionId} did not return an array`
      );
      return result;
    }

    result.turnsScanned = rows.length;

    for (const row of rows) {
      try {
        const written = await this.projectTurn(
          agentSessionId,
          row.turnIndex,
          row.toolCalls,
          row.startedAt,
          row.endedAt
        );
        result.toolCallsProjected += written;
      } catch (err) {
        result.turnsErrored++;
        log.warn(
          `ToolCallProjectionPipeline: failed to project turn ${agentSessionId}[${row.turnIndex}]`,
          { error: getLoggableErrorSummary(err) }
        );
      }
    }

    return result;
  }

  /**
   * Extract tool_use blocks from one turn's `tool_calls` jsonb (already an
   * array of ONLY tool_use blocks per `turn-extractor.ts`'s `extractToolCalls`)
   * and upsert one projection row per block, in array order (`ordinal`).
   */
  private async projectTurn(
    agentSessionId: string,
    turnIndex: number,
    toolCalls: unknown,
    startedAt: Date | null,
    endedAt: Date | null
  ): Promise<number> {
    if (!Array.isArray(toolCalls) || toolCalls.length === 0) return 0;

    const timestamp = endedAt ?? startedAt ?? null;

    const values = (toolCalls as ToolUseBlock[])
      .map((block, ordinal) => {
        if (!block || typeof block.name !== "string" || block.name.length === 0) return null;
        const { server, name } = parseToolName(block.name);
        return {
          agentSessionId,
          turnIndex,
          ordinal,
          toolName: name,
          server: server ?? undefined,
          argFingerprint: computeArgFingerprint(block.input),
          timestamp: timestamp ?? undefined,
        };
      })
      .filter((v): v is NonNullable<typeof v> => v !== null);

    if (values.length === 0) return 0;

    await this.db
      .insert(agentToolCallProjectionTable)
      .values(values)
      .onConflictDoUpdate({
        target: [
          agentToolCallProjectionTable.agentSessionId,
          agentToolCallProjectionTable.turnIndex,
          agentToolCallProjectionTable.ordinal,
        ],
        set: {
          toolName: sql`EXCLUDED.tool_name`,
          server: sql`EXCLUDED.server`,
          argFingerprint: sql`EXCLUDED.arg_fingerprint`,
          timestamp: sql`EXCLUDED.timestamp`,
        },
      });

    return values.length;
  }
}

// ── Batched full-corpus sweep (backfill) ─────────────────────────────────────

/** Aggregate result of a batched projection sweep across many sessions. */
export interface ProjectAllToolCallsResult {
  sessionsScanned: number;
  sessionsProcessed: number;
  sessionsErrored: number;
  turnsScanned: number;
  toolCallsProjected: number;
}

/** Default page size — mirrors turn-writer.ts's DEFAULT_EXTRACT_ALL_BATCH_SIZE. */
export const DEFAULT_PROJECT_ALL_BATCH_SIZE = 100;

export interface ProjectAllToolCallsOptions {
  /** Rows fetched per batch, keyset-paginated by agent_session_id ascending. */
  batchSize?: number;
  /** Resume a previous run: skip all sessions with agent_session_id <= this value. */
  afterId?: string;
  /** Injectable page fetcher — production default is fetchSessionIdPage. Test seam. */
  fetchPage?: (
    db: PostgresJsDatabase,
    afterId: string | null,
    batchSize: number
  ) => Promise<Array<{ agentSessionId: string }>>;
  /** Called after each batch with the running aggregate + last session id seen — a resumable checkpoint. */
  onBatchComplete?: (
    partial: Readonly<ProjectAllToolCallsResult>,
    lastId: string
  ) => void | Promise<void>;
}

/**
 * Fetch one keyset-paginated page of `agent_transcripts` session ids, ordered
 * ascending by `agent_session_id` (the table's primary key — no new index
 * required). Mirrors `turn-writer.ts`'s `fetchTranscriptPage`, but selects
 * only the id column — this sweep never needs the (potentially large) raw
 * `transcript` jsonb, since its per-session work reads from
 * `agent_transcript_turns` instead.
 */
export async function fetchSessionIdPage(
  db: PostgresJsDatabase,
  afterId: string | null,
  batchSize: number
): Promise<Array<{ agentSessionId: string }>> {
  const query = db
    .select({ agentSessionId: agentTranscriptsTable.agentSessionId })
    .from(agentTranscriptsTable)
    .orderBy(agentTranscriptsTable.agentSessionId)
    .limit(batchSize);

  const rows = afterId
    ? await query.where(gt(agentTranscriptsTable.agentSessionId, afterId as ConversationId))
    : await query;
  return rows;
}

/**
 * Batched, resumable, idempotent full-corpus tool-call projection sweep — the
 * engine behind the one-time backfill (mt#3329 spec point 4). Iterates
 * `agent_transcripts` session ids in keyset-paginated pages (so memory stays
 * flat regardless of corpus size, matching `extractTurnsForAllTranscripts`'s
 * precedent) and calls `ToolCallProjectionPipeline.runForSession` once per
 * session. Safe to re-run or resume via `afterId`: every write is an upsert.
 */
export async function projectToolCallsForAllTranscripts(
  db: PostgresJsDatabase,
  options: ProjectAllToolCallsOptions = {}
): Promise<ProjectAllToolCallsResult> {
  const batchSize = options.batchSize ?? DEFAULT_PROJECT_ALL_BATCH_SIZE;
  const fetchPage = options.fetchPage ?? fetchSessionIdPage;
  const pipeline = new ToolCallProjectionPipeline(db);

  const result: ProjectAllToolCallsResult = {
    sessionsScanned: 0,
    sessionsProcessed: 0,
    sessionsErrored: 0,
    turnsScanned: 0,
    toolCallsProjected: 0,
  };

  let cursor: string | null = options.afterId ?? null;

  for (;;) {
    let rows: Array<{ agentSessionId: string }>;
    try {
      rows = await fetchPage(db, cursor, batchSize);
    } catch (err) {
      log.error("projectToolCallsForAllTranscripts: failed to load a session-id batch", {
        error: getLoggableErrorSummary(err),
        cursor,
      });
      break;
    }

    if (rows.length === 0) break;

    result.sessionsScanned += rows.length;
    let lastId: string | undefined;

    for (const row of rows) {
      lastId = row.agentSessionId;
      try {
        const sessionResult = await pipeline.runForSession(row.agentSessionId);
        result.turnsScanned += sessionResult.turnsScanned;
        result.toolCallsProjected += sessionResult.toolCallsProjected;
        if (sessionResult.turnsErrored > 0) {
          result.sessionsErrored++;
        } else {
          result.sessionsProcessed++;
        }
      } catch (err) {
        result.sessionsErrored++;
        log.warn(`projectToolCallsForAllTranscripts: failed for ${row.agentSessionId}`, {
          error: getLoggableErrorSummary(err),
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

  log.info("projectToolCallsForAllTranscripts: complete", { ...result });
  return result;
}
