/**
 * Shared date-window filtering and coverage assessment for transcript search.
 *
 * Both TranscriptFtsService (FTS) and TranscriptSimilarityService (semantic)
 * apply a `from`/`to` date window and both want to signal coverage gaps when a
 * window contains sessions that have not yet been indexed into
 * agent_transcript_turns. This module is the single source of truth for both,
 * so the two services cannot drift on which column the window binds (the mt#2319
 * bug: the window used to bind the PARENT session's started_at instead of the
 * turn's own started_at).
 *
 * Why the turn's started_at, not the session's:
 *   Minsky sessions are long-running (hours/days). A turn that happened inside
 *   the requested window can belong to a session that *started* before it. The
 *   per-turn agent_transcript_turns.started_at is the timestamp of the turn
 *   itself; filtering on it returns the turns that actually fall in the window.
 *   Filtering on agent_transcripts.started_at (the session start) silently drops
 *   in-window turns from sessions that started earlier — measured at ~57% of
 *   turns falling on a different calendar day than their session start.
 *
 * @see mt#2319 — the date-window correctness bug this module fixes
 * @see mt#2234 — owns making recent turns *present* (watcher/sweep + embedding
 *   backfill); this module owns only query correctness + coverage transparency
 */

import { sql, gte, lte, and, type SQL } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { agentTranscriptTurnsTable } from "../storage/schemas/agent-transcript-turns-schema";
import { agentTranscriptsTable } from "../storage/schemas/agent-transcripts-schema";
import { log } from "@minsky/shared/logger";
import { getErrorMessage } from "../errors/index";
// Type-only import (erased at compile time → no runtime cycle with the services
// that import this module's value exports).
import type { TranscriptTurnResult } from "./transcript-similarity-service";

/** A `from`/`to` date window. Either bound may be omitted. */
export interface TranscriptDateRange {
  from?: Date;
  to?: Date;
}

/**
 * Coverage signal for a date-windowed transcript search.
 *
 * `unindexedSessionsInWindow` is the count of sessions whose start falls in the
 * requested window but which have NO rows in agent_transcript_turns yet — i.e.
 * sessions that exist in the ingest substrate (agent_transcripts) but have not
 * been indexed into the searchable per-turn table. Their turns cannot appear in
 * results regardless of query, so a bare `[]` would read as "no matches" when
 * the honest answer is "this window is not fully indexed yet."
 */
export interface TranscriptWindowCoverage {
  /** Count of in-window sessions with zero indexed turns. */
  unindexedSessionsInWindow: number;
  /** Human-readable explanation, present only when the count is > 0. */
  note?: string;
}

/**
 * Response shape for the transcript search tools (`transcripts.search` and
 * `transcripts.search-text`). `results` is the ranked turns; `coverage` is
 * present only when a date window is supplied AND in-window sessions are not
 * yet indexed, so an empty/short `results` is not misread as "no matches"
 * (mt#2319 SC#4).
 */
export interface TranscriptSearchResponse {
  results: TranscriptTurnResult[];
  coverage?: TranscriptWindowCoverage;
}

/**
 * Build the WHERE conditions for a `from`/`to` window, bound to the TURN's
 * own started_at (agent_transcript_turns.started_at) — NOT the parent session's.
 *
 * Returns an empty array when no bound is supplied (no filtering).
 */
export function buildTurnDateRangeConditions(dateRange?: TranscriptDateRange): SQL[] {
  const conditions: SQL[] = [];
  if (!dateRange) return conditions;
  if (dateRange.from) {
    conditions.push(gte(agentTranscriptTurnsTable.startedAt, dateRange.from));
  }
  if (dateRange.to) {
    conditions.push(lte(agentTranscriptTurnsTable.startedAt, dateRange.to));
  }
  return conditions;
}

/**
 * Assess how many sessions whose start falls in the requested window have not
 * yet been indexed into agent_transcript_turns.
 *
 * Note the deliberate asymmetry with {@link buildTurnDateRangeConditions}: the
 * search filter binds the TURN's started_at (turns are present, filter by their
 * own time), but the coverage check binds the SESSION's started_at — an
 * un-indexed session has zero turn rows, so it has no turn timestamp to filter
 * on; its session start is the only timestamp available to locate it in the
 * window.
 *
 * Returns `{ unindexedSessionsInWindow: 0 }` on any error (coverage is an
 * informational signal and must never fail the search).
 */
export async function assessWindowCoverage(
  db: PostgresJsDatabase,
  dateRange?: TranscriptDateRange
): Promise<TranscriptWindowCoverage> {
  // No window → nothing to assess (un-windowed searches don't make a
  // "this window is incomplete" claim).
  if (!dateRange || (!dateRange.from && !dateRange.to)) {
    return { unindexedSessionsInWindow: 0 };
  }

  const conditions: SQL[] = [];
  if (dateRange.from) {
    conditions.push(gte(agentTranscriptsTable.startedAt, dateRange.from));
  }
  if (dateRange.to) {
    conditions.push(lte(agentTranscriptsTable.startedAt, dateRange.to));
  }
  // Sessions with no indexed turns: correlated NOT EXISTS against the turns table.
  conditions.push(
    sql`NOT EXISTS (SELECT 1 FROM ${agentTranscriptTurnsTable} WHERE ${agentTranscriptTurnsTable.agentSessionId} = ${agentTranscriptsTable.agentSessionId})`
  );

  try {
    const rows = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(agentTranscriptsTable)
      .where(and(...conditions));

    const raw = rows[0]?.count ?? 0;
    const count = typeof raw === "number" ? raw : Number(raw);
    if (!count || count <= 0) {
      return { unindexedSessionsInWindow: 0 };
    }
    return {
      unindexedSessionsInWindow: count,
      note:
        `${count} session(s) started in this window are not yet indexed into ` +
        `agent_transcript_turns and cannot appear in results. They become ` +
        `searchable after \`transcripts index-embeddings\` runs (owned by mt#2234).`,
    };
  } catch (err) {
    log.warn(`assessWindowCoverage: coverage check failed: ${getErrorMessage(err)}`);
    return { unindexedSessionsInWindow: 0 };
  }
}
