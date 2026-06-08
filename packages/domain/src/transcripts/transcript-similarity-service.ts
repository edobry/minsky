/**
 * TranscriptSimilarityService
 *
 * Domain service for embedding-based similarity search over agent transcripts.
 * Wraps the per-turn embedding similarity query (agent_transcript_turns.embedding)
 * and the session-level summary embedding query (agent_transcripts.summary_embedding).
 *
 * Mirrors the pattern of TaskSimilarityService but adapted to the transcript schema:
 * - No vector abstraction layer — queries Drizzle ORM directly against the pgvector columns.
 * - Each result includes parent-session metadata (started_at, model, message count,
 *   related_task_ids, related_pr_numbers, parent_agent_session_id for subagent links).
 *
 * @see mt#1352 — PerTurnEmbeddingPipeline (per-turn embeddings populated)
 * @see mt#1353 — SummaryPipeline (session-level summary_embedding populated)
 * @see mt#1354 — this file
 */

import { injectable } from "tsyringe";
import { sql, eq, and, ne, type SQL } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { EmbeddingService } from "../ai/embeddings/types";
import { agentTranscriptTurnsTable } from "../storage/schemas/agent-transcript-turns-schema";
import { agentTranscriptsTable } from "../storage/schemas/agent-transcripts-schema";
import { log } from "@minsky/shared/logger";
import { getErrorMessage } from "../errors/index";
import { buildTurnDateRangeConditions } from "./transcript-search-filters";

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * Parent session metadata attached to each turn result.
 * Fields match agent_transcripts columns; absent fields are null.
 */
export interface TranscriptSessionMetadata {
  agentSessionId: string;
  startedAt: Date | null;
  model: string | null;
  /** Total number of turns in the parent session (count from agent_transcript_turns). */
  messageCount: number;
  relatedTaskIds: string[] | null;
  relatedPrNumbers: string[] | null;
  /**
   * Non-null when this session was spawned as a subagent by a parent session.
   * Derived from minsky_session_links in future work; currently null (mt#1327 scope).
   */
  parentAgentSessionId: string | null;
}

/**
 * A single turn similarity result, including the embedding score and
 * parent-session metadata for context.
 */
export interface TranscriptTurnResult {
  agentSessionId: string;
  turnIndex: number;
  userText: string | null;
  assistantText: string | null;
  startedAt: Date | null;
  endedAt: Date | null;
  isSpawnBoundary: boolean | null;
  /** Cosine-distance score from pgvector (<=> operator). Lower = more similar. */
  score: number;
  sessionMetadata: TranscriptSessionMetadata;
}

/**
 * A single session similarity result (findSimilarSession).
 */
export interface TranscriptSessionResult {
  agentSessionId: string;
  startedAt: Date | null;
  model: string | null;
  summary: string | null;
  relatedTaskIds: string[] | null;
  relatedPrNumbers: string[] | null;
  /** Cosine-distance score from pgvector (<=> operator). Lower = more similar. */
  score: number;
  parentAgentSessionId: string | null;
}

/**
 * Options for TranscriptSimilarityService.search()
 */
export interface TranscriptSearchOptions {
  /** Max results to return. Default: 10. */
  limit?: number;
  /** Filter by turn role: 'user' turns have non-null userText; 'assistant' turns have non-null assistantText. */
  role?: "user" | "assistant";
  /** Filter turns by the turn's own start time range (agent_transcript_turns.started_at). */
  dateRange?: { from?: Date; to?: Date };
  /** Filter to turns from a specific agent session. */
  sessionId?: string;
}

/**
 * Options for TranscriptSimilarityService.findSimilarTurn()
 */
export interface FindSimilarTurnOptions {
  /** Max results to return. Default: 10. */
  limit?: number;
}

/**
 * Options for TranscriptSimilarityService.findSimilarSession()
 */
export interface FindSimilarSessionOptions {
  /** Max results to return. Default: 10. */
  limit?: number;
}

// ── Service ───────────────────────────────────────────────────────────────────

@injectable()
export class TranscriptSimilarityService {
  constructor(
    private readonly db: PostgresJsDatabase,
    private readonly embeddingService: EmbeddingService
  ) {}

  /**
   * Embed the query text and return the nearest-neighbor turns by cosine distance.
   *
   * Applies optional WHERE filters:
   *   - role: 'user' → user_text IS NOT NULL; 'assistant' → assistant_text IS NOT NULL
   *   - dateRange: filter via the turn's own started_at (agent_transcript_turns.started_at)
   *   - sessionId: restrict to a single agent session
   *
   * Each result includes parent-session metadata.
   */
  async search(query: string, opts: TranscriptSearchOptions = {}): Promise<TranscriptTurnResult[]> {
    const limit = opts.limit ?? 10;

    // Generate embedding for the query text.
    let queryEmbedding: number[];
    try {
      queryEmbedding = await this.embeddingService.generateEmbedding(query);
    } catch (err) {
      throw new Error(
        `TranscriptSimilarityService.search: failed to embed query: ${getErrorMessage(err)}`,
        { cause: err }
      );
    }

    // Build the pgvector cosine-distance expression.
    const embeddingLiteral = `'[${queryEmbedding.join(",")}]'`;
    const distanceExpr = sql`${agentTranscriptTurnsTable.embedding} <=> ${sql.raw(embeddingLiteral)}::vector`;

    // Build WHERE conditions.
    const conditions: SQL[] = [];

    // Only include turns that have an embedding.
    conditions.push(sql`${agentTranscriptTurnsTable.embedding} IS NOT NULL`);

    if (opts.role === "user") {
      conditions.push(sql`${agentTranscriptTurnsTable.userText} IS NOT NULL`);
    } else if (opts.role === "assistant") {
      conditions.push(sql`${agentTranscriptTurnsTable.assistantText} IS NOT NULL`);
    }

    if (opts.sessionId) {
      conditions.push(eq(agentTranscriptTurnsTable.agentSessionId, opts.sessionId));
    }

    // Date window binds the TURN's started_at (not the parent session's) — see
    // buildTurnDateRangeConditions / mt#2319.
    conditions.push(...buildTurnDateRangeConditions(opts.dateRange));

    // Query: JOIN agent_transcript_turns to agent_transcripts, ORDER BY cosine distance.
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
          score: distanceExpr,
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
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(distanceExpr)
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
      throw new Error(`TranscriptSimilarityService.search: query failed: ${getErrorMessage(err)}`, {
        cause: err,
      });
    }
  }

  /**
   * Find turns similar to a known turn (by agentSessionId + turnIndex composite key).
   * The seed turn is excluded from results.
   */
  async findSimilarTurn(
    turnId: string,
    opts: FindSimilarTurnOptions = {}
  ): Promise<TranscriptTurnResult[]> {
    const limit = opts.limit ?? 10;

    // Parse turnId: expected format "<agentSessionId>:<turnIndex>"
    const separatorIdx = turnId.lastIndexOf(":");
    if (separatorIdx < 0) {
      throw new Error(
        `TranscriptSimilarityService.findSimilarTurn: invalid turnId format "${turnId}". ` +
          'Expected "<agentSessionId>:<turnIndex>".'
      );
    }
    const agentSessionId = turnId.slice(0, separatorIdx);
    const turnIndexStr = turnId.slice(separatorIdx + 1);
    const turnIndex = parseInt(turnIndexStr, 10);
    if (isNaN(turnIndex)) {
      throw new Error(
        `TranscriptSimilarityService.findSimilarTurn: invalid turnIndex "${turnIndexStr}" in turnId "${turnId}".`
      );
    }

    // Fetch the seed turn's embedding.
    let seedRows: Array<{ embedding: number[] | null }>;
    try {
      seedRows = await this.db
        .select({ embedding: agentTranscriptTurnsTable.embedding })
        .from(agentTranscriptTurnsTable)
        .where(
          and(
            eq(agentTranscriptTurnsTable.agentSessionId, agentSessionId),
            eq(agentTranscriptTurnsTable.turnIndex, turnIndex)
          )
        )
        .limit(1);
    } catch (err) {
      throw new Error(
        `TranscriptSimilarityService.findSimilarTurn: failed to load seed turn: ${getErrorMessage(err)}`,
        { cause: err }
      );
    }

    const seedRow = seedRows[0];
    if (!seedRow) {
      throw new Error(`TranscriptSimilarityService.findSimilarTurn: turn not found: ${turnId}`);
    }
    if (!seedRow.embedding) {
      throw new Error(
        `TranscriptSimilarityService.findSimilarTurn: seed turn "${turnId}" has no embedding. ` +
          "Run transcripts.index-embeddings first."
      );
    }

    const embeddingLiteral = `'[${(seedRow.embedding as number[]).join(",")}]'`;
    const distanceExpr = sql`${agentTranscriptTurnsTable.embedding} <=> ${sql.raw(embeddingLiteral)}::vector`;

    // Exclude the seed turn itself.
    const conditions = [
      sql`${agentTranscriptTurnsTable.embedding} IS NOT NULL`,
      sql`NOT (${agentTranscriptTurnsTable.agentSessionId} = ${agentSessionId} AND ${agentTranscriptTurnsTable.turnIndex} = ${turnIndex})`,
    ];

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
          score: distanceExpr,
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
        .orderBy(distanceExpr)
        .limit(limit);

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
          parentAgentSessionId: null,
        },
      }));
    } catch (err) {
      throw new Error(
        `TranscriptSimilarityService.findSimilarTurn: query failed: ${getErrorMessage(err)}`,
        { cause: err }
      );
    }
  }

  /**
   * Find sessions similar to a given session, using the session-level summary embedding.
   * The seed session is excluded from results.
   */
  async findSimilarSession(
    sessionId: string,
    opts: FindSimilarSessionOptions = {}
  ): Promise<TranscriptSessionResult[]> {
    const limit = opts.limit ?? 10;

    // Fetch seed session's summary_embedding.
    let seedRows: Array<{ summaryEmbedding: number[] | null }>;
    try {
      seedRows = await this.db
        .select({ summaryEmbedding: agentTranscriptsTable.summaryEmbedding })
        .from(agentTranscriptsTable)
        .where(eq(agentTranscriptsTable.agentSessionId, sessionId))
        .limit(1);
    } catch (err) {
      throw new Error(
        `TranscriptSimilarityService.findSimilarSession: failed to load seed session: ${getErrorMessage(err)}`,
        { cause: err }
      );
    }

    const seedRow = seedRows[0];
    if (!seedRow) {
      throw new Error(
        `TranscriptSimilarityService.findSimilarSession: session not found: ${sessionId}`
      );
    }
    if (!seedRow.summaryEmbedding) {
      throw new Error(
        `TranscriptSimilarityService.findSimilarSession: session "${sessionId}" has no summary_embedding. ` +
          "Run transcripts.index-embeddings first."
      );
    }

    const embeddingLiteral = `'[${(seedRow.summaryEmbedding as number[]).join(",")}]'`;
    const distanceExpr = sql`${agentTranscriptsTable.summaryEmbedding} <=> ${sql.raw(embeddingLiteral)}::vector`;

    try {
      const rows = await this.db
        .select({
          agentSessionId: agentTranscriptsTable.agentSessionId,
          startedAt: agentTranscriptsTable.startedAt,
          model: agentTranscriptsTable.model,
          summary: agentTranscriptsTable.summary,
          relatedTaskIds: agentTranscriptsTable.relatedTaskIds,
          relatedPrNumbers: agentTranscriptsTable.relatedPrNumbers,
          score: distanceExpr,
        })
        .from(agentTranscriptsTable)
        .where(
          and(
            sql`${agentTranscriptsTable.summaryEmbedding} IS NOT NULL`,
            ne(agentTranscriptsTable.agentSessionId, sessionId)
          )
        )
        .orderBy(distanceExpr)
        .limit(limit);

      return rows.map((row) => ({
        agentSessionId: row.agentSessionId,
        startedAt: row.startedAt,
        model: row.model,
        summary: row.summary,
        relatedTaskIds: row.relatedTaskIds,
        relatedPrNumbers: row.relatedPrNumbers,
        score: typeof row.score === "number" ? row.score : Number(row.score),
        parentAgentSessionId: null, // mt#1327 scope
      }));
    } catch (err) {
      throw new Error(
        `TranscriptSimilarityService.findSimilarSession: query failed: ${getErrorMessage(err)}`,
        { cause: err }
      );
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
          sql`${agentTranscriptTurnsTable.agentSessionId} = ANY(${sql.raw(`ARRAY[${sessionIds.map((id) => `'${id.replace(/'/g, "''")}'`).join(",")}]`)})`
        )
        .groupBy(agentTranscriptTurnsTable.agentSessionId);

      return new Map(countRows.map((r) => [r.agentSessionId, r.count]));
    } catch (err) {
      log.warn(
        `TranscriptSimilarityService.getMessageCounts: failed to fetch counts: ${getErrorMessage(err)}`
      );
      return new Map();
    }
  }
}
