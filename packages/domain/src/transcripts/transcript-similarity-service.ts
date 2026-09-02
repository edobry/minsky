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
 * ## Why these queries use `<->` (L2) and not `<=>` (cosine) — mt#4344
 *
 * pgvector can only use an index whose operator class matches the query's
 * operator. `idx_agent_transcript_turns_embedding` is built
 * `USING hnsw (embedding vector_l2_ops)` — the same opclass every other vector
 * namespace in this database uses, and the same one the shared
 * `postgres-vector-storage.ts` hardcodes (`<->`, `:209`/`:212`). This file
 * originally hand-wrote `<=>`, so the planner ignored the index entirely: a
 * 1,044 MB HNSW index served ZERO queries across the table's whole lifetime
 * (`pg_stat_user_indexes.idx_scan = 0`, lifetime counters) while every semantic
 * search sequentially scanned ~135k rows.
 *
 * The swap is safe because the stored vectors are **unit-normalized**, for
 * which `‖a−b‖² = 2 − 2·cos(a,b)`, i.e. L2 distance is a strictly increasing
 * function of cosine distance — the two induce the SAME neighbour ordering.
 * Measured twice, independently: mt#450 (2026-08-04) over all 3,556 task
 * vectors, where ranking by `<->` and by `<=>` gave an identical top-10; and
 * mt#4344 (2026-08-19) over 500 sampled transcript embeddings, whose squared
 * norms ran 0.9987–1.0013 (avg 1.000058). mt#450 also records that a
 * whole-corpus rank comparison shows far-tail near-tie reordering — thousands
 * of differing ranks that never touch the top-k. That is noise, not a defect;
 * do not re-derive it.
 *
 * **Two consequences to carry.** (1) The score VALUE changed even though the
 * ORDER did not: under unit normalization `L2 = sqrt(2 · cosine_distance)`, so
 * the numbers this service returns are ~1.41x their old scale near 1.0. There
 * is no threshold or display consumer of that score today (audited mt#4344),
 * which is why no conversion shipped with the operator change — but any future
 * threshold must be expressed in L2, not cosine. (2) The normalization is an
 * observed property of the current embedding provider, not a schema invariant.
 * If a provider ever emits unnormalized vectors, L2 and cosine diverge for
 * real and this comment stops being true.
 *
 * The operator↔opclass correspondence is now checked mechanically for every
 * vector namespace by `storage/vector/operator-class-alignment.ts`.
 *
 * ## Why this file does not route through `postgres-vector-storage.ts`
 *
 * Every other vector namespace does, which is why every other one stayed
 * aligned — so the bypass is the root cause and is worth justifying rather
 * than merely noting. That layer's `search` is single-table, single-id and
 * equality-filter-only: it selects `${idColumn} AS id` plus a score, builds
 * `WHERE key = $n` against ONE table, and returns `{id, score}`. Transcript
 * search needs four things it cannot express — a JOIN to `agent_transcripts`
 * for `projectId` scoping and parent-session metadata (mt#2417); a composite
 * `(agent_session_id, turn_index)` identity rather than one id column;
 * `IS NOT NULL` role predicates rather than equality; and a date window bound
 * to the TURN's `started_at`, not the parent session's (mt#2319).
 *
 * Adopting it therefore means EXTENDING it (join support, composite ids,
 * richer predicates), not switching a call site. That work is owned by
 * **mt#2331**, which already owns transcripts adopting the canonical
 * persistence pattern; mt#4344 deliberately did not attempt it. Until then the
 * alignment check above is what keeps this hand-written SQL from diverging
 * again — it is the substitute for the shared layer's structural guarantee,
 * not an argument that the bypass is fine.
 *
 * @see mt#1352 — PerTurnEmbeddingPipeline (per-turn embeddings populated)
 * @see mt#1353 — SummaryPipeline (session-level summary_embedding populated)
 * @see mt#1354 — this file
 * @see mt#4344 — operator/opclass mismatch that made the index unusable
 * @see mt#450 — the corroborating measurement on the tasks corpus
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
import { toDisplaySnippet } from "./text-snippet";
import type { AgentSessionId } from "./transcript-source";

/**
 * The handle drizzle hands a `db.transaction()` callback (mt#4919).
 *
 * Derived from `PostgresJsDatabase` rather than imported, because drizzle does
 * not export the transaction type under a stable public name — deriving it
 * keeps this correct across drizzle upgrades instead of pinning a path into its
 * internals.
 */
type TransactionScope = Parameters<Parameters<PostgresJsDatabase["transaction"]>[0]>[0];

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
  /**
   * Who authored `userText` (mt#4289) — `"human"` for operator speech, a
   * harness kind (`compact_summary`, `harness_meta`, `task_notification`, …)
   * for a `user`-role line Claude Code generated. Null when the turn carries no
   * `userText`.
   *
   * Read this before treating a `role: "user"` hit as something the operator
   * said: measured against prod 2026-08-19, 43.5% of turns carrying `userText`
   * are harness-written. `originKind` on the search options filters on it
   * server-side.
   */
  userOrigin: string | null;
  assistantText: string | null;
  startedAt: Date | null;
  endedAt: Date | null;
  isSpawnBoundary: boolean | null;
  /**
   * L2 (Euclidean) distance score from pgvector, via the `<->` operator that
   * matches the table's `vector_l2_ops` HNSW index (mt#4344). Lower = more
   * similar. On unit-normalized vectors this equals `sqrt(2 · cosine_distance)`
   * and ranks identically to cosine — see this module's header.
   *
   * **Producer-dependent.** `TranscriptFtsService` reuses this same result type
   * and fills this field with Postgres `ts_rank` instead, where HIGHER is more
   * relevant (it says so at its own module header). The two scales are not
   * comparable and never were; do not write a threshold against this field
   * without knowing which service produced the row.
   */
  score: number;
  sessionMetadata: TranscriptSessionMetadata;
  /**
   * Ready-to-run resume hint for this turn's conversation (mt#2523) — the
   * exact command an operator can paste to resume the harness conversation
   * this turn belongs to. Derived purely from `agentSessionId`; kept as a
   * field (not left for callers to compose) so every search surface (CLI,
   * MCP, cockpit) renders the identical string.
   */
  resumeHint: string;
  /**
   * Bounded excerpt for this hit.
   *
   * **Producer-dependent, like `score` above.** `TranscriptFtsService` fills it
   * from Postgres `ts_headline` — an excerpt cut AROUND the match, with matched
   * spans delimited by `[` and `]` (mt#3713). `TranscriptSimilarityService`
   * fills it with the turn's LEADING text, stripped and truncated (mt#4917),
   * because a vector match has no matched terms to cut around. Both are bounded
   * and both are safe to display; only the FTS one marks matches.
   *
   * Still absent on whole-session reads (`getSession`), which do not search.
   *
   * Additive to the pre-mt#3713 shape at the SERVICE layer: `userText` /
   * `assistantText` are still returned in full here, so the cockpit's
   * conversation-search route — which calls this service directly — is
   * unaffected. The MCP/CLI COMMANDS are what drop the full text, under the
   * default `snippet` projection (`transcript-search-projection.ts`, mt#4917).
   */
  snippet?: string;
}

/**
 * Single-quote a path for safe use in a shell command.
 *
 * A recorded `cwd` is arbitrary filesystem text — it can contain spaces, and in
 * principle a quote. Wrapping in single quotes neutralises everything except a
 * single quote itself, which is closed/escaped/reopened in the usual way.
 */
function shellQuote(path: string): string {
  return `'${path.replaceAll("'", `'\\''`)}'`;
}

/**
 * Build the ready-to-run resume hint for a harness conversation (mt#2523,
 * corrected by mt#3440). Single source of truth so CLI/MCP output and the
 * cockpit search surface never drift on the exact command string.
 *
 * **The `cd` is load-bearing, not cosmetic.** Claude Code keys its transcript
 * directory off the working directory, so `claude --resume <id>` run anywhere
 * other than the conversation's original `cwd` fails with
 * `No conversation found with session ID: <id>` — which reads as "the
 * conversation is gone" rather than "you are in the wrong directory."
 * Reproduced against the live binary (mt#3440 `## Planning Audit`): the same id
 * fails from `/tmp` and succeeds from its recorded cwd, same machine, same
 * minute. The same requirement is documented at `driven-session-host.ts`'s
 * `missingCwdReason`.
 *
 * When `cwd` is unknown (52 of 2,061 rows at time of writing), the hint says so
 * inline rather than emitting a bare command that will silently fail from
 * wherever the operator happens to be standing.
 *
 * **On embedding an absolute path in a rendered string** (PR #2489 review): the
 * path is what makes the command work — there is no directory-independent form
 * of `claude --resume`. It is also not newly exposed by this function: the same
 * `agent_transcripts.cwd` is already served to the same local surface by
 * `routes/conversations.ts` (the Overview tab's `conversationMeta`) and
 * `routes/session-film.ts`, and the cockpit binds loopback behind a token +
 * Host-allowlist. If conversation data ever becomes multi-tenant or
 * remotely-served, the path belongs in that review — not this one function.
 */
export function buildResumeHint(conversationId: string, cwd?: string | null): string {
  const resume = `claude --resume ${conversationId}`;
  if (!cwd) {
    return `${resume}  # run from the conversation's original directory (not recorded)`;
  }
  return `cd ${shellQuote(cwd)} && ${resume}`;
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
  /**
   * L2 (Euclidean) distance score from pgvector, via the `<->` operator that
   * matches the table's `vector_l2_ops` HNSW index (mt#4344). Lower = more
   * similar. On unit-normalized vectors this equals `sqrt(2 · cosine_distance)`
   * and ranks identically to cosine — see this module's header.
   */
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
  /**
   * Filter by who authored the turn's `userText` (mt#4289) — e.g. `"human"` for
   * operator speech only. Mirrors `TranscriptFtsSearchOptions.originKind`, so
   * the two search surfaces answer the same question the same way.
   *
   * A separate axis from `role`: `role: "user"` tests `user_text IS NOT NULL`,
   * which 8,245 harness-written rows also satisfy (43.5% of that population,
   * measured against prod 2026-08-19).
   */
  originKind?: string;
  /** Filter turns by the turn's own start time range (agent_transcript_turns.started_at). */
  dateRange?: { from?: Date; to?: Date };
  /** Filter to turns from a specific agent session. */
  sessionId?: string;
  /**
   * Project scoping (mt#2417, Phase 1.4). A `projects.id` uuid restricts
   * results to transcripts whose `agent_transcripts.project_id` matches;
   * `undefined`/omitted returns unscoped (all-projects) results — same
   * "unidentified -> ALL_PROJECTS" fail-open convention as ADR-021.
   */
  projectId?: string;
}

/**
 * Options for TranscriptSimilarityService.findSimilarTurn()
 */
export interface FindSimilarTurnOptions {
  /** Max results to return. Default: 10. */
  limit?: number;
  /** Project scoping (mt#2417, Phase 1.4) — see TranscriptSearchOptions.projectId. */
  projectId?: string;
  /**
   * Filter by who authored the turn's `userText` (mt#4289) — see
   * `TranscriptSearchOptions.originKind`. Applies to the NEIGHBOURS returned,
   * not to the seed: the seed is addressed by id, so its own provenance is the
   * caller's to inspect on the result, while "find me operator turns like this
   * one" is the question this filter answers.
   */
  originKind?: string;
}

/**
 * Options for TranscriptSimilarityService.findSimilarSession()
 */
export interface FindSimilarSessionOptions {
  /** Max results to return. Default: 10. */
  limit?: number;
  /** Project scoping (mt#2417, Phase 1.4) — see TranscriptSearchOptions.projectId. */
  projectId?: string;
}

/**
 * Characters of leading text kept in a semantic hit's {@link TranscriptTurnResult.snippet}.
 *
 * Sized to land in the same neighbourhood as the FTS side's `ts_headline`
 * output so the two search surfaces read alike, rather than picked round:
 * `TS_HEADLINE_OPTIONS` (`transcript-fts-search-query.ts`) is
 * `MaxFragments=2, MaxWords=28`, i.e. up to ~56 words, which at English's ~6
 * characters per word plus the fragment delimiter is ~350-400 characters.
 */
const SEMANTIC_SNIPPET_MAX_CHARS = 400;

/**
 * Build the display excerpt for a SEMANTIC hit (mt#4917).
 *
 * The FTS side gets its `snippet` from Postgres `ts_headline`, which cuts
 * around the matched lexemes. There is no equivalent here and there cannot be:
 * a vector match has no matched terms to cut around — the query's words may not
 * appear in the hit at all, which is the entire point of semantic search. So
 * this takes the LEADING text instead, run through the same harness-markup and
 * markdown stripping the cockpit's conversation labels use, and truncated on a
 * word boundary.
 *
 * Prefers `userText` when both sides are present, matching
 * `selectLiteralSnippetSource`'s convention on the FTS side so a caller reading
 * both surfaces sees the same side of the turn quoted.
 *
 * Note this is additive: `userText` / `assistantText` are still returned in
 * full by this service. The command layer is what drops them
 * (`transcript-search-projection.ts`), and it does so precisely BECAUSE this
 * field now exists on both surfaces.
 */
function buildSemanticSnippet(userText: string | null, assistantText: string | null): string {
  // Falls through on a present-but-EMPTY user side, which is deliberately not
  // what `deriveTurnRole` does with the same value: an empty string is a real
  // role signal (the row matched a `user_text IS NOT NULL` filter) and a
  // useless display excerpt. The two questions get different answers.
  const source = userText !== null && userText !== "" ? userText : assistantText;
  return toDisplaySnippet(source, SEMANTIC_SNIPPET_MAX_CHARS);
}

// ── Service ───────────────────────────────────────────────────────────────────

@injectable()
export class TranscriptSimilarityService {
  constructor(
    private readonly db: PostgresJsDatabase,
    private readonly embeddingService: EmbeddingService
  ) {}

  /**
   * Run a vector-ordered query with pgvector's iterative index scan enabled
   * (mt#4919).
   *
   * ## The defect this fixes
   *
   * pgvector applies a `WHERE` filter AFTER the HNSW index is scanned, and the
   * scan yields only `hnsw.ef_search` candidates (default 40). A selective
   * filter therefore removes most of them and the query returns FEWER rows than
   * the `LIMIT` asked for — silently, with nothing in the result to distinguish
   * that from a genuinely small corpus. pgvector's README states it directly:
   * "If a condition matches 10% of rows, with HNSW and the default
   * `hnsw.ef_search` of 40, only 4 rows will match on average."
   *
   * Measured against prod 2026-09-02, `LIMIT 20` on the repo project:
   * `role: "user"` (~12.7% selective) returned **10**, and adding
   * `originKind: "human"` (~6%) returned **7**. Deterministic, not flaky.
   *
   * ## Why iterative_scan and not a bigger ef_search
   *
   * Both were measured. `ef_search = 100` returns the full 20 at 12.7%
   * selectivity but only **15** at 6% — a fixed budget is a guess against an
   * unknown selectivity, and the next filter combination is another guess.
   * `iterative_scan` returned the full 20 at both, at no cost worth naming
   * (83-95 ms against 158 ms for the default).
   *
   * `strict_order` rather than `relaxed_order`: both returned the full page,
   * and strict preserves exact distance ordering, which a ranked search surface
   * should not silently give up.
   *
   * ## Why this DEVIATES from ADR-013, deliberately
   *
   * ADR-013 prescribes an application-layer adaptive over-fetch for filtered
   * vector search, implemented in `TaskSimilarityService.searchByText`. **Do
   * not "restore consistency" by reproducing that here.** ADR-013's own text
   * describes its widen as "the application-layer equivalent of pgvector 0.8's
   * bounded iterative scan" — an emulation of exactly this setting. It needed
   * the emulation because its filter was a MUTABLE DENORMALIZED column
   * (`tasks_embeddings.status`) that had drifted from its source of truth, so
   * the filter had to move out of the index for correctness and the recall fix
   * rode along. No such constraint exists here: `role`, `project_id`,
   * `user_origin` and `started_at` are real columns on the joined tables, with
   * no denormalized copy to drift. The database ships the mechanism ADR-013 was
   * imitating (`pg_extension` reports vector **0.8.0**, the release that
   * introduced it), so the emulation buys nothing.
   *
   * ## Why a transaction
   *
   * `SET LOCAL` is scoped to the surrounding transaction and reverts on commit,
   * so it cannot leak to another caller sharing this pooled connection. A bare
   * `SET` would; a database- or role-level default would additionally change
   * every OTHER vector search in the system, including the `tasks_embeddings`
   * path that deliberately does its own thing.
   */
  private async withIterativeScan<T>(
    run: (tx: TransactionScope) => Promise<T> | PromiseLike<T>
  ): Promise<T> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL hnsw.iterative_scan = strict_order`);
      return run(tx);
    });
  }

  /**
   * Embed the query text and return the nearest-neighbor turns by L2 distance
   * (`<->`, matching the table's vector_l2_ops index — see module header).
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

    // Build the pgvector L2-distance expression. `<->` (not `<=>`) so the
    // planner can use idx_agent_transcript_turns_embedding, which is
    // vector_l2_ops — see this module's header (mt#4344).
    const embeddingLiteral = `'[${queryEmbedding.join(",")}]'`;
    const distanceExpr = sql`${agentTranscriptTurnsTable.embedding} <-> ${sql.raw(embeddingLiteral)}::vector`;

    // Build WHERE conditions.
    const conditions: SQL[] = [];

    // Only include turns that have an embedding.
    conditions.push(sql`${agentTranscriptTurnsTable.embedding} IS NOT NULL`);

    if (opts.role === "user") {
      conditions.push(sql`${agentTranscriptTurnsTable.userText} IS NOT NULL`);
    } else if (opts.role === "assistant") {
      conditions.push(sql`${agentTranscriptTurnsTable.assistantText} IS NOT NULL`);
    }

    // mt#4289: a separate axis from `role` — see TranscriptSearchOptions.
    // Mirrors TranscriptFtsService so a caller does not get operator-only
    // results from one search surface and the unfiltered mix from the other.
    if (opts.originKind) {
      conditions.push(eq(agentTranscriptTurnsTable.userOrigin, opts.originKind));
    }

    if (opts.sessionId) {
      conditions.push(eq(agentTranscriptTurnsTable.agentSessionId, opts.sessionId));
    }

    // Project scoping (mt#2417, Phase 1.4): filter via the JOIN'd parent
    // session's project_id. Omitted -> unscoped (all-projects), same
    // fail-open convention as ADR-021's other scoped read sites.
    if (opts.projectId) {
      conditions.push(eq(agentTranscriptsTable.projectId, opts.projectId));
    }

    // Date window binds the TURN's started_at (not the parent session's) — see
    // buildTurnDateRangeConditions / mt#2319.
    conditions.push(...buildTurnDateRangeConditions(opts.dateRange));

    // Query: JOIN agent_transcript_turns to agent_transcripts, ORDER BY L2 distance.
    try {
      // mt#4919: iterative scan, or a selective filter silently returns fewer
      // rows than `limit`. See withIterativeScan for the measurements.
      const rows = await this.withIterativeScan((tx) =>
        tx
          .select({
            agentSessionId: agentTranscriptTurnsTable.agentSessionId,
            turnIndex: agentTranscriptTurnsTable.turnIndex,
            userText: agentTranscriptTurnsTable.userText,
            userOrigin: agentTranscriptTurnsTable.userOrigin,
            assistantText: agentTranscriptTurnsTable.assistantText,
            startedAt: agentTranscriptTurnsTable.startedAt,
            endedAt: agentTranscriptTurnsTable.endedAt,
            isSpawnBoundary: agentTranscriptTurnsTable.isSpawnBoundary,
            score: distanceExpr,
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
          .where(conditions.length > 0 ? and(...conditions) : undefined)
          .orderBy(distanceExpr)
          .limit(limit)
      );

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
        score: typeof row.score === "number" ? row.score : Number(row.score),
        // mt#4917: semantic hits carried no `snippet` at all, so a caller had
        // no bounded way to read a hit and the command layer had nothing to
        // project onto. See buildSemanticSnippet for why this is leading text
        // rather than a match-centred excerpt.
        snippet: buildSemanticSnippet(row.userText, row.assistantText),
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

    // `<->` matches the vector_l2_ops index — see this module's header (mt#4344).
    const embeddingLiteral = `'[${(seedRow.embedding as number[]).join(",")}]'`;
    const distanceExpr = sql`${agentTranscriptTurnsTable.embedding} <-> ${sql.raw(embeddingLiteral)}::vector`;

    // Exclude the seed turn itself.
    const conditions: SQL[] = [
      sql`${agentTranscriptTurnsTable.embedding} IS NOT NULL`,
      sql`NOT (${agentTranscriptTurnsTable.agentSessionId} = ${agentSessionId} AND ${agentTranscriptTurnsTable.turnIndex} = ${turnIndex})`,
    ];
    // Project scoping (mt#2417, Phase 1.4) — see search()'s equivalent filter.
    if (opts.projectId) {
      conditions.push(eq(agentTranscriptsTable.projectId, opts.projectId));
    }
    // mt#4289 — see search()'s equivalent filter and FindSimilarTurnOptions.
    if (opts.originKind) {
      conditions.push(eq(agentTranscriptTurnsTable.userOrigin, opts.originKind));
    }

    try {
      // mt#4919: same reason as search() — this method filters too (session
      // exclusion, role, originKind), so it has the same recall exposure.
      const rows = await this.withIterativeScan((tx) =>
        tx
          .select({
            agentSessionId: agentTranscriptTurnsTable.agentSessionId,
            turnIndex: agentTranscriptTurnsTable.turnIndex,
            userText: agentTranscriptTurnsTable.userText,
            userOrigin: agentTranscriptTurnsTable.userOrigin,
            assistantText: agentTranscriptTurnsTable.assistantText,
            startedAt: agentTranscriptTurnsTable.startedAt,
            endedAt: agentTranscriptTurnsTable.endedAt,
            isSpawnBoundary: agentTranscriptTurnsTable.isSpawnBoundary,
            score: distanceExpr,
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
          .orderBy(distanceExpr)
          .limit(limit)
      );

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
        resumeHint: buildResumeHint(row.agentSessionId, row.sessionCwd),
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
    sessionId: AgentSessionId,
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

    // `agent_transcripts.summary_embedding` has NO hnsw index at all, so this
    // query is a sequential scan either way (mt#4344 §Out of scope — noted, not
    // fixed here). `<->` regardless, so the whole file speaks one metric and
    // the alignment check has a single expectation per file.
    const embeddingLiteral = `'[${(seedRow.summaryEmbedding as number[]).join(",")}]'`;
    // NOT wrapped in withIterativeScan, and that is a checked finding rather
    // than an oversight (mt#4919): `agent_transcripts.summary_embedding` has NO
    // ANN index — verified against prod, the only HNSW index on this cluster is
    // `idx_agent_transcript_turns_embedding`. This ORDER BY is therefore an
    // exact sequential scan, which cannot under-return, and `iterative_scan`
    // would have nothing to act on. If a summary-embedding HNSW index is ever
    // added, this call site needs the wrapper.
    const distanceExpr = sql`${agentTranscriptsTable.summaryEmbedding} <-> ${sql.raw(embeddingLiteral)}::vector`;

    // Project scoping (mt#2417, Phase 1.4) — see search()'s equivalent filter.
    const scopeConditions: SQL[] = [
      sql`${agentTranscriptsTable.summaryEmbedding} IS NOT NULL`,
      ne(agentTranscriptsTable.agentSessionId, sessionId),
    ];
    if (opts.projectId) {
      scopeConditions.push(eq(agentTranscriptsTable.projectId, opts.projectId));
    }

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
        .where(and(...scopeConditions))
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
