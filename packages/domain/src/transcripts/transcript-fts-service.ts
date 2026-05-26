/**
 * TranscriptFtsService
 *
 * Domain service for full-text search over agent transcripts using Postgres FTS
 * (to_tsquery / plainto_tsquery against the fts_text GENERATED column on
 * agent_transcript_turns).
 *
 * Also provides a getSession method that returns structured turns for a session,
 * optionally sliced by turn_index range.
 *
 * Result shape matches TranscriptTurnResult from transcript-similarity-service so
 * that consumers don't need to branch on which search ran. The `score` field is
 * populated with the ts_rank value (higher = more relevant, unlike cosine distance
 * where lower = more similar).
 *
 * @see mt#1352 — agent_transcript_turns rows + fts_text GENERATED column
 * @see mt#1355 — this file
 */

import { injectable } from "tsyringe";
import { sql, eq, and, gte, lte, asc, type SQL } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { agentTranscriptTurnsTable } from "../storage/schemas/agent-transcript-turns-schema";
import { agentTranscriptsTable } from "../storage/schemas/agent-transcripts-schema";
import { log } from "@minsky/shared/logger";
import { getErrorMessage } from "../errors/index";
import type {
  TranscriptTurnResult,
  TranscriptSessionMetadata,
} from "./transcript-similarity-service";

// ── Re-export for convenience ─────────────────────────────────────────────────

export type { TranscriptTurnResult, TranscriptSessionMetadata };

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * Options for TranscriptFtsService.searchText()
 */
export interface TranscriptFtsSearchOptions {
  /** Max results to return. Default: 10. */
  limit?: number;
  /** Filter by turn role: 'user' turns have non-null userText; 'assistant' turns have non-null assistantText. */
  role?: "user" | "assistant";
  /** Filter turns by session start time range. */
  dateRange?: { from?: Date; to?: Date };
  /** Filter to turns from a specific agent session. */
  sessionId?: string;
}

/**
 * Options for TranscriptFtsService.getSession()
 */
export interface TranscriptGetSessionOptions {
  /** Return only turns in this inclusive index range. */
  turnRange?: { start: number; end: number };
}

// ── Service ───────────────────────────────────────────────────────────────────

@injectable()
export class TranscriptFtsService {
  constructor(private readonly db: PostgresJsDatabase) {}

  /**
   * Full-text search over agent transcript turns using Postgres FTS.
   *
   * Uses plainto_tsquery so plain-language queries are automatically tokenized.
   * Results are ranked by ts_rank (higher = more relevant) and returned as
   * TranscriptTurnResult so the shape matches the embedding-search results.
   *
   * Applies optional WHERE filters:
   *   - role: 'user' → user_text IS NOT NULL; 'assistant' → assistant_text IS NOT NULL
   *   - dateRange: filter via parent session's started_at
   *   - sessionId: restrict to a single agent session
   */
  async searchText(
    query: string,
    opts: TranscriptFtsSearchOptions = {}
  ): Promise<TranscriptTurnResult[]> {
    const limit = opts.limit ?? 10;

    // Use plainto_tsquery for natural-language queries (no syntax required).
    // ts_rank returns a float between 0 and 1 (higher = more relevant).
    const tsQueryExpr = sql`plainto_tsquery('english', ${query})`;
    const rankExpr = sql<number>`ts_rank(${agentTranscriptTurnsTable.ftsText}, plainto_tsquery('english', ${query}))`;

    // Build WHERE conditions.
    const conditions: SQL[] = [];

    // Only return turns that actually match the FTS query.
    conditions.push(sql`${agentTranscriptTurnsTable.ftsText} @@ ${tsQueryExpr}`);

    if (opts.role === "user") {
      conditions.push(sql`${agentTranscriptTurnsTable.userText} IS NOT NULL`);
    } else if (opts.role === "assistant") {
      conditions.push(sql`${agentTranscriptTurnsTable.assistantText} IS NOT NULL`);
    }

    if (opts.sessionId) {
      conditions.push(eq(agentTranscriptTurnsTable.agentSessionId, opts.sessionId));
    }

    if (opts.dateRange?.from || opts.dateRange?.to) {
      if (opts.dateRange.from) {
        conditions.push(gte(agentTranscriptsTable.startedAt, opts.dateRange.from));
      }
      if (opts.dateRange.to) {
        conditions.push(lte(agentTranscriptsTable.startedAt, opts.dateRange.to));
      }
    }

    try {
      const rows = await this.db
        .select({
          agentSessionId: agentTranscriptTurnsTable.agentSessionId,
          turnIndex: agentTranscriptTurnsTable.turnIndex,
          userText: agentTranscriptTurnsTable.userText,
          assistantText: agentTranscriptTurnsTable.assistantText,
          startedAt: agentTranscriptTurnsTable.startedAt,
          endedAt: agentTranscriptTurnsTable.endedAt,
          isSpawnBoundary: agentTranscriptTurnsTable.isSpawnBoundary,
          score: rankExpr,
          sessionStartedAt: agentTranscriptsTable.startedAt,
          sessionModel: agentTranscriptsTable.model,
          relatedTaskIds: agentTranscriptsTable.relatedTaskIds,
          relatedPrNumbers: agentTranscriptsTable.relatedPrNumbers,
        })
        .from(agentTranscriptTurnsTable)
        .innerJoin(
          agentTranscriptsTable,
          eq(agentTranscriptTurnsTable.agentSessionId, agentTranscriptsTable.agentSessionId)
        )
        .where(and(...conditions))
        .orderBy(
          sql`ts_rank(${agentTranscriptTurnsTable.ftsText}, plainto_tsquery('english', ${query})) DESC`
        )
        .limit(limit);

      // Fetch per-session message counts in bulk.
      const sessionIds = [...new Set(rows.map((r) => r.agentSessionId))];
      const messageCounts = await this.getMessageCounts(sessionIds);

      return rows.map((row) => ({
        agentSessionId: row.agentSessionId,
        turnIndex: row.turnIndex,
        userText: row.userText,
        assistantText: row.assistantText,
        startedAt: row.startedAt,
        endedAt: row.endedAt,
        isSpawnBoundary: row.isSpawnBoundary,
        score: typeof row.score === "number" ? row.score : Number(row.score),
        sessionMetadata: {
          agentSessionId: row.agentSessionId,
          startedAt: row.sessionStartedAt,
          model: row.sessionModel,
          messageCount: messageCounts.get(row.agentSessionId) ?? 0,
          relatedTaskIds: row.relatedTaskIds,
          relatedPrNumbers: row.relatedPrNumbers,
          parentAgentSessionId: null, // mt#1327 scope; not yet populated
        },
      }));
    } catch (err) {
      throw new Error(`TranscriptFtsService.searchText: query failed: ${getErrorMessage(err)}`, {
        cause: err,
      });
    }
  }

  /**
   * Return structured turns for a session, ordered by turn_index.
   *
   * Optionally sliced to a turn_index range [start, end] (inclusive).
   * Each turn includes parent-session metadata (same shape as searchText results).
   *
   * Throws if the session is not found.
   */
  async getSession(
    sessionId: string,
    opts: TranscriptGetSessionOptions = {}
  ): Promise<TranscriptTurnResult[]> {
    const conditions: SQL[] = [eq(agentTranscriptTurnsTable.agentSessionId, sessionId)];

    if (opts.turnRange) {
      conditions.push(
        sql`${agentTranscriptTurnsTable.turnIndex} >= ${opts.turnRange.start}`,
        sql`${agentTranscriptTurnsTable.turnIndex} <= ${opts.turnRange.end}`
      );
    }

    try {
      // First verify the session exists.
      const sessionRows = await this.db
        .select({ agentSessionId: agentTranscriptsTable.agentSessionId })
        .from(agentTranscriptsTable)
        .where(eq(agentTranscriptsTable.agentSessionId, sessionId))
        .limit(1);

      if (sessionRows.length === 0) {
        throw new Error(`TranscriptFtsService.getSession: session not found: ${sessionId}`);
      }

      const rows = await this.db
        .select({
          agentSessionId: agentTranscriptTurnsTable.agentSessionId,
          turnIndex: agentTranscriptTurnsTable.turnIndex,
          userText: agentTranscriptTurnsTable.userText,
          assistantText: agentTranscriptTurnsTable.assistantText,
          startedAt: agentTranscriptTurnsTable.startedAt,
          endedAt: agentTranscriptTurnsTable.endedAt,
          isSpawnBoundary: agentTranscriptTurnsTable.isSpawnBoundary,
          sessionStartedAt: agentTranscriptsTable.startedAt,
          sessionModel: agentTranscriptsTable.model,
          relatedTaskIds: agentTranscriptsTable.relatedTaskIds,
          relatedPrNumbers: agentTranscriptsTable.relatedPrNumbers,
        })
        .from(agentTranscriptTurnsTable)
        .innerJoin(
          agentTranscriptsTable,
          eq(agentTranscriptTurnsTable.agentSessionId, agentTranscriptsTable.agentSessionId)
        )
        .where(and(...conditions))
        .orderBy(asc(agentTranscriptTurnsTable.turnIndex));

      const messageCount = await this.getSessionMessageCount(sessionId);

      return rows.map((row) => ({
        agentSessionId: row.agentSessionId,
        turnIndex: row.turnIndex,
        userText: row.userText,
        assistantText: row.assistantText,
        startedAt: row.startedAt,
        endedAt: row.endedAt,
        isSpawnBoundary: row.isSpawnBoundary,
        // getSession results don't have a relevance score; use 1.0 as sentinel.
        score: 1.0,
        sessionMetadata: {
          agentSessionId: row.agentSessionId,
          startedAt: row.sessionStartedAt,
          model: row.sessionModel,
          messageCount,
          relatedTaskIds: row.relatedTaskIds,
          relatedPrNumbers: row.relatedPrNumbers,
          parentAgentSessionId: null, // mt#1327 scope
        },
      }));
    } catch (err) {
      // Re-throw the "session not found" error as-is; wrap everything else.
      if (err instanceof Error && err.message.includes("session not found")) {
        throw err;
      }
      throw new Error(`TranscriptFtsService.getSession: query failed: ${getErrorMessage(err)}`, {
        cause: err,
      });
    }
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  /**
   * Fetch the turn count for each of the given agent session IDs in a single query.
   */
  private async getMessageCounts(sessionIds: string[]): Promise<Map<string, number>> {
    if (sessionIds.length === 0) return new Map();

    try {
      const countRows = await this.db
        .select({
          agentSessionId: agentTranscriptTurnsTable.agentSessionId,
          count: sql<number>`count(*)::int`,
        })
        .from(agentTranscriptTurnsTable)
        .where(
          sql`${agentTranscriptTurnsTable.agentSessionId} = ANY(${sql.raw(
            `ARRAY[${sessionIds.map((id) => `'${id.replace(/'/g, "''")}'`).join(",")}]`
          )})`
        )
        .groupBy(agentTranscriptTurnsTable.agentSessionId);

      return new Map(countRows.map((r) => [r.agentSessionId, r.count]));
    } catch (err) {
      log.warn(
        `TranscriptFtsService.getMessageCounts: failed to fetch counts: ${getErrorMessage(err)}`
      );
      return new Map();
    }
  }

  /**
   * Fetch the total turn count for a single session.
   */
  private async getSessionMessageCount(sessionId: string): Promise<number> {
    const counts = await this.getMessageCounts([sessionId]);
    return counts.get(sessionId) ?? 0;
  }
}
