/**
 * TranscriptFtsService
 *
 * Domain service for full-text search over agent transcripts using Postgres FTS
 * against the fts_text GENERATED column on agent_transcript_turns.
 *
 * Matching is mode-selected (mt#3713): `websearch` (default) supports quoted
 * phrases, `or`, and `-negation`; `plain` is the original plainto_tsquery
 * behavior; `exact` matches a literal substring. Query-shaping decisions that
 * do not need a database live in ./transcript-fts-search-query.
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
import { sql, eq, and, asc, type SQL } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { agentTranscriptTurnsTable } from "../storage/schemas/agent-transcript-turns-schema";
import { agentTranscriptsTable } from "../storage/schemas/agent-transcripts-schema";
import { log } from "@minsky/shared/logger";
import { getErrorMessage } from "../errors/index";
import { buildTurnDateRangeConditions } from "./transcript-search-filters";
import type { AgentSessionId } from "./transcript-source";
import {
  buildResumeHint,
  type TranscriptTurnResult,
  type TranscriptSessionMetadata,
} from "./transcript-similarity-service";
import {
  DEFAULT_FTS_SEARCH_MODE,
  TS_HEADLINE_OPTIONS,
  buildContainsPattern,
  buildLiteralSnippet,
  selectLiteralSnippetSource,
  tsQueryFunctionFor,
  type TranscriptFtsSearchMode,
} from "./transcript-fts-search-query";

// ── Re-export for convenience ─────────────────────────────────────────────────

export type { TranscriptTurnResult, TranscriptSessionMetadata };
export type { TranscriptFtsSearchMode };

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * Options for TranscriptFtsService.searchText()
 */
export interface TranscriptFtsSearchOptions {
  /** Max results to return. Default: 10. */
  limit?: number;
  /** Filter by turn role: 'user' turns have non-null userText; 'assistant' turns have non-null assistantText. */
  role?: "user" | "assistant";
  /**
   * Filter by who authored the turn's `userText` (mt#4289) — e.g. `"human"` for
   * operator speech only.
   *
   * `role: "user"` is NOT this filter and never was: it tests `user_text IS NOT
   * NULL`, which 8,245 harness-written rows also satisfy (43.5% of the
   * `user_text` population, measured against prod 2026-08-19). Searching for
   * something the operator said needs `originKind: "human"` as well.
   */
  originKind?: string;
  /** Filter turns by the turn's own start time range (agent_transcript_turns.started_at). */
  dateRange?: { from?: Date; to?: Date };
  /** Filter to turns from a specific agent session. */
  sessionId?: string;
  /**
   * How the query string is matched. Defaults to `websearch`, which supports
   * `"quoted phrase"` adjacency, `or`, and `-negation`. See
   * {@link TranscriptFtsSearchMode}.
   */
  mode?: TranscriptFtsSearchMode;
  /**
   * Restrict to turns whose parent session belongs to this project (mt#2417
   * Phase 1.4). Omit for an unscoped, all-projects read. Mirrors the scoping
   * `TranscriptSimilarityService` already applies.
   */
  projectId?: string;
}

/**
 * Options for TranscriptFtsService.getSession()
 */
export interface TranscriptGetSessionOptions {
  /** Return only turns in this inclusive index range. */
  turnRange?: { start: number; end: number };
  /**
   * Filter to turns by role (mt#2818): 'user' returns only turns with a
   * non-null userText; 'assistant' returns only turns with a non-null
   * assistantText. Mirrors the role filter already applied in searchText().
   */
  role?: "user" | "assistant";
}

/**
 * Score reported for `exact`-mode hits and for unranked `getSession` reads.
 *
 * Both match without computing relevance, so there is no ts_rank to report;
 * a constant keeps the result shape uniform across every search path.
 */
const EXACT_MATCH_SCORE = 1.0;

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
   *   - dateRange: filter via the turn's own started_at (agent_transcript_turns.started_at)
   *   - sessionId: restrict to a single agent session
   */
  async searchText(
    query: string,
    opts: TranscriptFtsSearchOptions = {}
  ): Promise<TranscriptTurnResult[]> {
    const limit = opts.limit ?? 10;
    const mode = opts.mode ?? DEFAULT_FTS_SEARCH_MODE;

    // The parser is chosen by mode; `exact` still names one because it uses the
    // resulting tsquery as an index-accelerated prefilter (see below).
    const tsQueryExpr = sql.raw(`${tsQueryFunctionFor(mode)}('english', `);
    const buildTsQuery = (): SQL => sql`${tsQueryExpr}${query})`;

    // ts_rank returns a float between 0 and 1 (higher = more relevant). It is
    // meaningless for `exact`, which matches by substring, so that mode orders
    // by recency instead and reports a constant score.
    const rankExpr = sql<number>`ts_rank(${agentTranscriptTurnsTable.ftsText}, ${buildTsQuery()})`;

    // Build WHERE conditions.
    const conditions: SQL[] = [];

    if (mode === "exact") {
      // Gate the substring test behind the GIN-indexed tsvector so `exact` runs
      // at interactive latency: measured 462ms with this prefilter versus
      // 6,129ms for a bare ILIKE over the 267k-row / 174MB corpus (mt#3713).
      //
      // A query whose lexemes are not present as indexed terms would be missed,
      // so the prefilter is skipped entirely when the query tokenizes to an
      // EMPTY tsquery (pure punctuation or stopwords) — that case falls back to
      // the unaccelerated scan rather than silently returning nothing.
      conditions.push(
        sql`(${buildTsQuery()}::text = '' OR ${agentTranscriptTurnsTable.ftsText} @@ ${buildTsQuery()})`
      );
      conditions.push(
        sql`${this.concatenatedTurnText()} ILIKE ${buildContainsPattern(query)} ESCAPE '\\'`
      );
    } else {
      // Only return turns that actually match the FTS query.
      conditions.push(sql`${agentTranscriptTurnsTable.ftsText} @@ ${buildTsQuery()}`);
    }

    if (opts.role === "user") {
      conditions.push(sql`${agentTranscriptTurnsTable.userText} IS NOT NULL`);
    } else if (opts.role === "assistant") {
      conditions.push(sql`${agentTranscriptTurnsTable.assistantText} IS NOT NULL`);
    }

    // mt#4289: a separate axis from `role` — see TranscriptFtsSearchOptions.
    if (opts.originKind) {
      conditions.push(eq(agentTranscriptTurnsTable.userOrigin, opts.originKind));
    }

    if (opts.sessionId) {
      conditions.push(eq(agentTranscriptTurnsTable.agentSessionId, opts.sessionId));
    }

    if (opts.projectId) {
      conditions.push(eq(agentTranscriptsTable.projectId, opts.projectId));
    }

    // Date window binds the TURN's started_at (not the parent session's) — see
    // buildTurnDateRangeConditions / mt#2319.
    conditions.push(...buildTurnDateRangeConditions(opts.dateRange));

    // `exact` bypasses tokenization, so ts_headline (which highlights tsquery
    // lexemes) is the wrong tool for it — that mode's snippet is cut around the
    // literal in TypeScript after the rows come back.
    const snippetExpr =
      mode === "exact"
        ? sql<string | null>`NULL`
        : sql<
            string | null
          >`ts_headline('english', ${this.concatenatedTurnText()}, ${buildTsQuery()}, ${TS_HEADLINE_OPTIONS})`;

    // Ordering by ts_rank is what dominates this query's cost — it cannot use
    // the GIN index and must read every matching row's tsvector. Computing the
    // headline inline adds no measurable time on top of it (mt#3713: 6,681ms
    // with the headline vs 7,600ms without, on a 20,488-match query).
    const orderByExpr = sql`${rankExpr} DESC`;

    try {
      const rows = await this.db
        .select({
          agentSessionId: agentTranscriptTurnsTable.agentSessionId,
          turnIndex: agentTranscriptTurnsTable.turnIndex,
          userText: agentTranscriptTurnsTable.userText,
          userOrigin: agentTranscriptTurnsTable.userOrigin,
          assistantText: agentTranscriptTurnsTable.assistantText,
          startedAt: agentTranscriptTurnsTable.startedAt,
          endedAt: agentTranscriptTurnsTable.endedAt,
          isSpawnBoundary: agentTranscriptTurnsTable.isSpawnBoundary,
          score: rankExpr,
          snippet: snippetExpr,
          sessionStartedAt: agentTranscriptsTable.startedAt,
          sessionModel: agentTranscriptsTable.model,
          sessionCwd: agentTranscriptsTable.cwd,
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
          mode === "exact"
            ? sql`${agentTranscriptTurnsTable.startedAt} DESC NULLS LAST`
            : orderByExpr
        )
        .limit(limit);

      // Fetch per-session message counts in bulk.
      const sessionIds = [...new Set(rows.map((r) => r.agentSessionId))];
      const messageCounts = await this.getMessageCounts(sessionIds);

      return rows.map((row) => ({
        agentSessionId: row.agentSessionId,
        turnIndex: row.turnIndex,
        userText: row.userText,
        userOrigin: row.userOrigin,
        assistantText: row.assistantText,
        startedAt: row.startedAt,
        endedAt: row.endedAt,
        isSpawnBoundary: row.isSpawnBoundary,
        // ts_rank does not apply to a substring match; `exact` reports the same
        // sentinel getSession() uses for its unranked reads.
        score:
          mode === "exact"
            ? EXACT_MATCH_SCORE
            : typeof row.score === "number"
              ? row.score
              : Number(row.score),
        snippet:
          mode === "exact"
            ? buildLiteralSnippet(
                selectLiteralSnippetSource(row.userText, row.assistantText, query),
                query
              )
            : (row.snippet ?? ""),
        sessionMetadata: {
          agentSessionId: row.agentSessionId,
          startedAt: row.sessionStartedAt,
          model: row.sessionModel,
          messageCount: messageCounts.get(row.agentSessionId) ?? 0,
          relatedTaskIds: row.relatedTaskIds,
          relatedPrNumbers: row.relatedPrNumbers,
          parentAgentSessionId: null, // mt#1327 scope; not yet populated
        },
        resumeHint: buildResumeHint(row.agentSessionId, row.sessionCwd),
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
    sessionId: AgentSessionId,
    opts: TranscriptGetSessionOptions = {}
  ): Promise<TranscriptTurnResult[]> {
    const conditions: SQL[] = [eq(agentTranscriptTurnsTable.agentSessionId, sessionId)];

    if (opts.turnRange) {
      conditions.push(
        sql`${agentTranscriptTurnsTable.turnIndex} >= ${opts.turnRange.start}`,
        sql`${agentTranscriptTurnsTable.turnIndex} <= ${opts.turnRange.end}`
      );
    }

    if (opts.role === "user") {
      conditions.push(sql`${agentTranscriptTurnsTable.userText} IS NOT NULL`);
    } else if (opts.role === "assistant") {
      conditions.push(sql`${agentTranscriptTurnsTable.assistantText} IS NOT NULL`);
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
          userOrigin: agentTranscriptTurnsTable.userOrigin,
          assistantText: agentTranscriptTurnsTable.assistantText,
          startedAt: agentTranscriptTurnsTable.startedAt,
          endedAt: agentTranscriptTurnsTable.endedAt,
          isSpawnBoundary: agentTranscriptTurnsTable.isSpawnBoundary,
          sessionStartedAt: agentTranscriptsTable.startedAt,
          sessionModel: agentTranscriptsTable.model,
          sessionCwd: agentTranscriptsTable.cwd,
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
        userOrigin: row.userOrigin,
        assistantText: row.assistantText,
        startedAt: row.startedAt,
        endedAt: row.endedAt,
        isSpawnBoundary: row.isSpawnBoundary,
        // getSession results don't have a relevance score; use the shared sentinel.
        score: EXACT_MATCH_SCORE,
        sessionMetadata: {
          agentSessionId: row.agentSessionId,
          startedAt: row.sessionStartedAt,
          model: row.sessionModel,
          messageCount,
          relatedTaskIds: row.relatedTaskIds,
          relatedPrNumbers: row.relatedPrNumbers,
          parentAgentSessionId: null, // mt#1327 scope
        },
        resumeHint: buildResumeHint(row.agentSessionId, row.sessionCwd),
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
   * The turn's user and assistant text as one value.
   *
   * Mirrors the expression the `fts_text` GENERATED column is built from
   * (migration 0027), so a substring test and a snippet see exactly the text
   * the index was derived from.
   */
  private concatenatedTurnText(): SQL {
    return sql`(coalesce(${agentTranscriptTurnsTable.userText}, '') || ' ' || coalesce(${agentTranscriptTurnsTable.assistantText}, ''))`;
  }

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
