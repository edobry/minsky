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
 * (`scripts/backfill-agent-tool-call-projection.ts`), which can walk either
 * the FULL keyset (`fetchSessionIdPage`, ascending by id) or, via
 * `--pending-only`, ONLY the sessions with an outstanding deficit
 * (`fetchPendingSessionIdPage`, mt#3395) — the latter repairs the scattered
 * holes a killed batched run leaves behind without re-touching already
 * fully-projected sessions.
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
  /**
   * Turns skipped because `tool_calls` was non-null but NOT a jsonb array —
   * the double-encoded-string shape (mt#3360). Counted separately from
   * `turnsErrored` because this is a KNOWN, non-throwing shape mismatch
   * (equivalent to a `jsonb_typeof(tool_calls) <> 'array'` filter, applied
   * here in TS rather than SQL since the value is already in memory), not a
   * query/insert failure.
   */
  skippedNonArray: number;
  /**
   * Projection rows removed because the current derivation does not emit them
   * (mt#3978) — a turn that no longer exists, or an `ordinal` past the turn's
   * current tool-call count.
   *
   * Always reported, including at zero, for the same reason mt#3514 reports
   * `orphansDeleted`: an operator must be able to tell "the delete ran and
   * found nothing" from "the delete never ran" without querying the database.
   */
  orphansDeleted: number;
  /**
   * True when orphan removal could not be COMPLETED — the DELETE threw, or the
   * turn-row presence probe that gates it did. An ERROR outcome, not folded
   * into success: the session is left holding stale rows the upsert cannot
   * reach, which is the exact state this mechanism exists to remove.
   *
   * The probe failure counts here (rather than passing as a silent skip)
   * because otherwise it renders identically to a clean no-op — `orphansDeleted
   * = 0, orphanDeleteFailed = false` — which is precisely the ambiguity
   * `orphansDeleted` is reported-at-zero to avoid.
   */
  orphanDeleteFailed: boolean;
}

const emptyRunResult = (): ToolCallProjectionRunResult => ({
  turnsScanned: 0,
  toolCallsProjected: 0,
  turnsErrored: 0,
  skippedNonArray: 0,
  orphansDeleted: 0,
  orphanDeleteFailed: false,
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

    // mt#3360: filter on jsonb_typeof(tool_calls) = 'array' at the SQL level
    // (mirrors the same guard in scripts/backfill-agent-tool-call-projection.ts's
    // countPendingProjectionRows) rather than relying solely on an in-memory
    // Array.isArray check downstream — a handful of Apr-2026-ingested rows
    // store `tool_calls` as a jsonb STRING (double-encoded JSON of an
    // otherwise-valid array), a pre-mt#2381 write-path artifact (see
    // turn-writer.ts's comment). This query never called jsonb_array_length
    // so it never THREW on those rows, but it also never distinguished them
    // from a genuinely-empty turn; the separate skipped-count query below
    // makes that visible.
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
            sql`${agentTranscriptTurnsTable.toolCalls} IS NOT NULL`,
            sql`jsonb_typeof(${agentTranscriptTurnsTable.toolCalls}) = 'array'`
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
    result.skippedNonArray = await this.countSkippedNonArray(agentSessionId);

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

    // ── Orphan removal (mt#3978) ──────────────────────────────────────────
    // Skipped when any turn failed: the upsert half is already known-degraded,
    // and compounding it with a delete makes the session harder to reason
    // about, not easier. A later clean run removes the orphans. Same posture as
    // mt#3514's `erroredChunks > 0` skip.
    if (result.turnsErrored === 0) {
      const turnRowCount = await this.countTurnRows(agentSessionId);
      if (turnRowCount === null) {
        // The presence probe could not answer, so the delete must not run —
        // but reporting that as a clean no-op would hide it. See
        // `orphanDeleteFailed`'s doc comment.
        result.orphanDeleteFailed = true;
      } else if (turnRowCount > 0) {
        const outcome = await this.removeOrphanedRows(agentSessionId);
        result.orphansDeleted = outcome.deleted;
        result.orphanDeleteFailed = outcome.failed;
        if (outcome.deleted > 0) {
          log.warn(
            `ToolCallProjectionPipeline: removed ${outcome.deleted} orphaned projection row(s) ` +
              `for ${agentSessionId} — left by an earlier derivation whose turn boundaries or ` +
              `tool-call counts differed from this one`,
            { agentSessionId, orphansDeleted: outcome.deleted }
          );
        }
      }
    }

    return result;
  }

  /**
   * How many turn rows does this session have? `null` when the probe itself
   * failed — the caller must not treat that as zero.
   *
   * This gates the zero-yield safety guard (mt#3978), the analogue of mt#3514's
   * early return on a non-empty transcript that extracts to zero turns. A
   * session with turns but none carrying tool calls SHOULD have its projection
   * emptied — that is a correct derivation. A session with NO turn rows is a
   * different thing entirely: turns have not been extracted yet, or were wiped,
   * and deleting the projection there would destroy history on the strength of
   * an upstream gap rather than a derivation result.
   *
   * Fails CLOSED (no delete) rather than open: if this probe cannot answer, the
   * delete must not run — and the caller reports that as `orphanDeleteFailed`
   * rather than as a clean no-op.
   */
  private async countTurnRows(agentSessionId: string): Promise<number | null> {
    try {
      // The selected field is named for what it counts (rather than a generic
      // `n`) so this query is distinguishable from `countSkippedNonArray`'s —
      // they read the same table with the same shape, and only the projection
      // alias tells them apart at the call boundary.
      const rows = await this.db
        .select({ turnRowCount: sql<number>`count(*)::int` })
        .from(agentTranscriptTurnsTable)
        .where(eq(agentTranscriptTurnsTable.agentSessionId, agentSessionId));
      return Number((rows as Array<{ turnRowCount: number }>)?.[0]?.turnRowCount ?? 0);
    } catch (err) {
      log.warn(
        `ToolCallProjectionPipeline: failed to check turn-row presence for ${agentSessionId} — ` +
          `skipping orphan removal rather than risking a delete on an unknown state`,
        { error: getLoggableErrorSummary(err) }
      );
      return null;
    }
  }

  /**
   * Delete this session's projection rows that the CURRENT derivation does not
   * emit (mt#3978).
   *
   * **Why an anti-join and not mt#3514's index bound.** Turn rows are
   * contiguous `0..N-1`, so `turn_index >= N` identifies every orphan there.
   * Projection rows are SPARSE — only turns carrying tool calls have any — so
   * no single bound describes them. The predicate instead asks, per row,
   * whether a live turn still has a tool-call slot at that `(turn_index,
   * ordinal)`. That covers both orphan classes in one statement: a turn that
   * vanished entirely (measured 2026-08-11: 17,044 such rows across 199
   * conversations, all left behind when mt#3902 deleted stale turn rows), and
   * an `ordinal` past a surviving turn's current tool-call count — which the
   * corpus measurement could not even see.
   *
   * **Why an UNREADABLE turn is protected, not treated as empty (PR #2887 R1).**
   * A turn whose `tool_calls` is the double-encoded jsonb STRING shape (mt#3360)
   * satisfies neither half of the live-slot test — `jsonb_typeof` is not
   * `'array'` — so on the first predicate alone every projection row for that
   * turn reads as an orphan and is deleted. It is not one. A NULL `tool_calls`
   * is a derivation RESULT ("this turn has no tool calls", and its stale rows
   * should go); an unreadable one is an upstream DATA problem, and deleting
   * against it destroys history the current derivation simply cannot re-emit —
   * the same reasoning the zero-yield guard applies at session grain, applied
   * here at turn grain. The second NOT EXISTS holds those rows back.
   *
   * Deliberately turn-scoped rather than session-scoped: skipping the whole
   * session on one malformed turn would leave a 99-good-turn session
   * unreconcilable forever. This protects exactly the at-risk rows.
   *
   * **Why no advisory lock, unlike mt#3514.** That fix compared against a
   * SNAPSHOT count (`turns.length` read before the write), so a concurrent run
   * that extracted more turns could have its rows deleted as false orphans —
   * hence the lock. This predicate is evaluated by Postgres against the source
   * table AT DELETE TIME, so a row a concurrent writer just wrote for a live
   * turn satisfies the EXISTS and survives. The race the lock existed to
   * prevent is not reachable here.
   */
  private async removeOrphanedRows(
    agentSessionId: string
  ): Promise<{ deleted: number; failed: boolean }> {
    try {
      const deleted = await this.db
        .delete(agentToolCallProjectionTable)
        .where(
          and(
            eq(agentToolCallProjectionTable.agentSessionId, agentSessionId),
            sql`NOT EXISTS (
              SELECT 1
              FROM ${agentTranscriptTurnsTable} t
              WHERE t.agent_session_id = ${agentToolCallProjectionTable.agentSessionId}
                AND t.turn_index = ${agentToolCallProjectionTable.turnIndex}
                AND t.tool_calls IS NOT NULL
                AND jsonb_typeof(t.tool_calls) = 'array'
                AND ${agentToolCallProjectionTable.ordinal} < jsonb_array_length(t.tool_calls)
            )`,
            sql`NOT EXISTS (
              SELECT 1
              FROM ${agentTranscriptTurnsTable} t
              WHERE t.agent_session_id = ${agentToolCallProjectionTable.agentSessionId}
                AND t.turn_index = ${agentToolCallProjectionTable.turnIndex}
                AND t.tool_calls IS NOT NULL
                AND jsonb_typeof(t.tool_calls) <> 'array'
            )`
          )
        )
        .returning({ turnIndex: agentToolCallProjectionTable.turnIndex });

      return { deleted: deleted.length, failed: false };
    } catch (err) {
      log.warn(
        `ToolCallProjectionPipeline: failed to remove orphaned projection rows for ${agentSessionId}`,
        { error: getLoggableErrorSummary(err) }
      );
      return { deleted: 0, failed: true };
    }
  }

  /**
   * Count turns for this session with a non-null `tool_calls` that is NOT a
   * jsonb array (mt#3360) — the double-encoded-string shape. A SEPARATE
   * query rather than counting in-loop, because `runForSession`'s main
   * SELECT above now filters `jsonb_typeof(tool_calls) = 'array'` and so
   * never fetches these rows in the first place; this is the only way to
   * still report how many exist. Fails open (returns 0, logs) rather than
   * letting a diagnostic-only count crash the projection sweep.
   */
  private async countSkippedNonArray(agentSessionId: string): Promise<number> {
    try {
      const rows = await this.db
        .select({ n: sql<number>`count(*)::int` })
        .from(agentTranscriptTurnsTable)
        .where(
          and(
            eq(agentTranscriptTurnsTable.agentSessionId, agentSessionId),
            sql`${agentTranscriptTurnsTable.toolCalls} IS NOT NULL`,
            sql`jsonb_typeof(${agentTranscriptTurnsTable.toolCalls}) <> 'array'`
          )
        );
      return Number((rows as Array<{ n: number }>)?.[0]?.n ?? 0);
    } catch (err) {
      log.warn(
        `ToolCallProjectionPipeline: failed to count skipped-non-array turns for session ${agentSessionId}`,
        { error: getLoggableErrorSummary(err) }
      );
      return 0;
    }
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
  /** Aggregate of every session's `ToolCallProjectionRunResult.skippedNonArray` (mt#3360). */
  skippedNonArray: number;
  /**
   * Aggregate of every session's `ToolCallProjectionRunResult.orphansDeleted`
   * (mt#3978) — how many stale projection rows the sweep removed corpus-wide.
   *
   * This is the number a reconciliation run reports as its before/after
   * delta, so it is reported even at zero: a sweep that deleted nothing and a
   * sweep whose deletes never ran must be distinguishable from the output
   * alone.
   */
  orphansDeleted: number;
  /**
   * Sessions whose orphan removal could not be completed (mt#3978). Named to
   * match `ExtractAllTurnsResult.orphanDeletesFailed`, the same counter for
   * mt#3514's sibling mechanism.
   *
   * Not folded into `sessionsErrored`: those sessions' upserts succeeded, so
   * the sweep did not fail for them in the usual sense — they are simply still
   * holding stale rows the next run must retry.
   */
  orphanDeletesFailed: number;
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
 * Fetch one page of PENDING session ids — sessions whose expected projection
 * row count (`sum(jsonb_array_length(tool_calls))` over their array-typed
 * turns) exceeds their actual stored row count in
 * `agent_tool_call_projection` (mt#3395). Session-grain sibling of
 * `scripts/backfill-agent-tool-call-projection.ts`'s
 * `countPendingProjectionRows`: SAME guarded shape (jsonb_typeof(...) =
 * 'array' before jsonb_array_length; only the LENGTH of `tool_calls` is
 * touched, never its content, so no extra detoasting beyond what
 * `jsonb_array_length` itself requires) grouped by `agent_session_id` alone
 * instead of `(agent_session_id, turn_index)` — target SELECTION only needs
 * a per-session yes/no, not a per-turn deficit count.
 *
 * A killed batched sweep leaves scattered holes (some sessions committed,
 * others — typically the largest, slowest ones — lost mid-batch); resuming
 * with `--after-id` skips past them, and resuming without it re-walks the
 * whole completed prefix. This anti-join selects ONLY the holey sessions
 * directly, so `--pending-only` repairs them without re-touching the ~73%
 * of the corpus that already completed.
 *
 * Drop-in for `ProjectAllToolCallsOptions.fetchPage` — identical signature to
 * `fetchSessionIdPage` above, so the existing batched / resumable /
 * checkpointed sweep engine in `projectToolCallsForAllTranscripts` (and its
 * per-session processing via `ToolCallProjectionPipeline.runForSession`,
 * using the same pure helpers) needs NO changes to drive `--pending-only`
 * mode — only the id SOURCE changes.
 *
 * Keyset-paginated ascending by `agent_session_id`, scoped to `> afterId` in
 * BOTH source CTEs (not just the final result) so each page's aggregation
 * only scans the remaining id range rather than re-aggregating the whole
 * corpus on every batch call.
 */
export async function fetchPendingSessionIdPage(
  db: PostgresJsDatabase,
  afterId: string | null,
  batchSize: number
): Promise<Array<{ agentSessionId: string }>> {
  const rows = (await db.execute(sql`
    WITH expected AS (
      SELECT agent_session_id, sum(jsonb_array_length(tool_calls))::int AS expected_rows
      FROM agent_transcript_turns
      WHERE tool_calls IS NOT NULL
        AND jsonb_typeof(tool_calls) = 'array'
        ${afterId ? sql`AND agent_session_id > ${afterId}` : sql``}
      GROUP BY agent_session_id
    ),
    actual AS (
      SELECT agent_session_id, count(*)::int AS actual_rows
      FROM agent_tool_call_projection
      ${afterId ? sql`WHERE agent_session_id > ${afterId}` : sql``}
      GROUP BY agent_session_id
    )
    SELECT e.agent_session_id AS agent_session_id
    FROM expected e
    LEFT JOIN actual a ON a.agent_session_id = e.agent_session_id
    WHERE e.expected_rows > COALESCE(a.actual_rows, 0)
    ORDER BY e.agent_session_id ASC
    LIMIT ${batchSize}
  `)) as Array<{ agent_session_id: string }>;

  return rows.map((r) => ({ agentSessionId: r.agent_session_id }));
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
    skippedNonArray: 0,
    orphansDeleted: 0,
    orphanDeletesFailed: 0,
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
        result.skippedNonArray += sessionResult.skippedNonArray;
        result.orphansDeleted += sessionResult.orphansDeleted;
        if (sessionResult.orphanDeleteFailed) result.orphanDeletesFailed++;
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
