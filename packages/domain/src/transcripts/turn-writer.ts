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
 * CRITICAL — embedding preservation, CONDITIONAL since mt#3883: the upsert here
 * never COMPUTES an embedding. A new row gets a NULL embedding (filled later by
 * the backfill); an existing row keeps its vector ONLY while its text is
 * unchanged, and has it NULLED when the text changes — so a turn boundary that
 * moves cannot leave a vector describing content the row no longer holds. See
 * ADR-019 §Consequences ("two writers on the same rows"), and the SET clause
 * below for why unconditional preservation turned into a corruption vector the
 * moment extraction stopped producing identical boundaries.
 *
 * @see docs/architecture/adr-019-transcript-pipeline-staging.md
 * @see ./turn-extractor.ts — the pure extraction logic this reuses
 * @see ./per-turn-embedding-pipeline.ts — the embedding (vector-only) backfill
 * @see mt#2381 — this file
 */

import { and, eq, gt, gte, sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import { agentTranscriptsTable } from "../storage/schemas/agent-transcripts-schema";
import { agentTranscriptTurnsTable } from "../storage/schemas/agent-transcript-turns-schema";
import { log } from "@minsky/shared/logger";
import { getLoggableErrorSummary } from "../errors/index";
import { extractTurns } from "./turn-extractor";
import type { RawTurnLine } from "./transcript-source";
import type { ConversationId } from "../ids";

/** Result of a single-transcript extraction attempt (mt#2457 SC3). */
export interface WriteTurnsResult {
  /**
   * Number of turns the EXTRACTOR produced for this transcript — the count the
   * orphan DELETE's `turn_index >= N` bound is taken from.
   *
   * Distinct from `written` (mt#3911). Conflating the two is not cosmetic: the
   * `index-embeddings` CLI printed `written` under the label `extracted=`, so a
   * session that extracted 604 turns and wrote only 104 of them reported
   * `extracted=104` — a 17%-complete write rendered as an ordinary success, and
   * the reason a one-command diagnosis instead took a full session.
   */
  extracted: number;
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
  /**
   * Number of bulk-insert chunks that failed to upsert (0 = every chunk
   * succeeded). Non-zero means `written` UNDER-counts `turns.length` — a
   * partial or total write failure that callers must count as an error, not
   * fold into a "skipped" bucket (mt#2457 R1 review: chunk failures were
   * previously swallowed, so a transcript with a failed write was
   * indistinguishable from one with nothing to write).
   */
  erroredChunks: number;
  /**
   * Number of ORPHANED rows deleted for this session (mt#3514) — rows at a
   * `turn_index` this extraction did not emit, left behind by an earlier
   * extraction that produced a different turn count.
   *
   * Before mt#3514 nothing ever deleted a turn row: the write was a pure
   * upsert on `(agent_session_id, turn_index)`, so it only ever overwrote the
   * indexes the CURRENT extraction happened to produce. Any index a previous
   * run wrote but this one does not re-emit survived untouched, carrying its
   * stale content forever. Measured 2026-08-08: 107 orphaned
   * `(session, tool_use_id)` pairs across 27 conversations, 104 of them with
   * byte-identical text to their live twin, at index spreads up to 704.
   */
  orphansDeleted: number;
  /**
   * True when the orphan-removal DELETE itself threw. Treated as an ERROR
   * outcome (see `classifyWriteOutcome`), not folded into success: a write
   * that upserted cleanly but could not remove stale rows has left the
   * session in exactly the inconsistent state this mechanism exists to
   * prevent, and reporting it as "processed" would make the defect invisible
   * again.
   */
  orphanDeleteFailed: boolean;
  /**
   * How many times a chunk was SPLIT and retried after exceeding the server's
   * `statement_timeout` (mt#3911). Zero in steady state. A non-zero value means
   * the write completed but the default chunk size is running close to the
   * timeout for this corpus — the early-warning signal that was missing when a
   * 500-row chunk silently failed outright.
   */
  chunkSplits: number;
}

/**
 * Injectable warn/error sink for turn-writer's logging (mt#3628). Defaults to
 * the real shared logger; tests inject a plain recording function instead of
 * patching `log` with `spyOn` — the winston output itself is already silenced
 * under the test harness (`tests/setup.ts` sets `TEST_LOGGER_SILENCED_FLAG`;
 * see `logger.ts`'s `isTestHarnessConsoleSilent()`), so a spy buys nothing a
 * plain fake doesn't.
 */
export interface TurnWriterLogSink {
  warn: (message: string, meta?: Record<string, unknown>) => void;
  error: (message: string, meta?: Record<string, unknown>) => void;
}

const defaultLogSink: TurnWriterLogSink = { warn: log.warn, error: log.error };

/**
 * Extract per-turn rows from a session's transcript and upsert them into
 * `agent_transcript_turns`. This never COMPUTES an embedding — that stays the
 * backfill's job — but since mt#3883 it does INVALIDATE one (see below).
 *
 * Idempotent: existing rows are upserted on (agent_session_id, turn_index). The
 * `embedding` column is excluded from the INSERT values, so a new row starts
 * NULL. On conflict it is set conditionally: preserved when the row's
 * `user_text`/`assistant_text` are unchanged, NULLED when they changed. So
 * re-materializing the full transcript on each incremental append is still safe
 * and still cheap — an unchanged row keeps its vector — while a turn whose
 * boundary MOVED (mt#3883) does not keep a vector describing text it no longer
 * holds.
 *
 * @param transcript - The session's full `agent_transcripts.transcript` JSONB
 *   (array of raw turn lines). Turn ordering / `turn_index` is assigned over the
 *   WHOLE transcript, so callers must pass the complete merged transcript, not
 *   an incremental slice.
 * @returns `{ written, nonEmptyYieldedZero, erroredChunks }` — see `WriteTurnsResult`.
 */
export async function writeTurnsForTranscript(
  db: PostgresJsDatabase,
  agentSessionId: string,
  transcript: unknown,
  logSink: TurnWriterLogSink = defaultLogSink
): Promise<WriteTurnsResult> {
  if (!Array.isArray(transcript) || transcript.length === 0) {
    return {
      extracted: 0,
      written: 0,
      nonEmptyYieldedZero: false,
      erroredChunks: 0,
      orphansDeleted: 0,
      orphanDeleteFailed: false,
      chunkSplits: 0,
    };
  }

  const turns = extractTurns(transcript as RawTurnLine[]);
  if (turns.length === 0) {
    // mt#2457 SC3: a non-empty transcript that extracts to zero turns is a
    // loud failure signal — the extractor didn't recognize this era's/shape's
    // JSONB, which is indistinguishable from a genuinely-empty session unless
    // we say so explicitly. Never silently swallow this.
    logSink.warn(
      `writeTurnsForTranscript: non-empty transcript (${transcript.length} raw lines) yielded ` +
        `zero turns for session ${agentSessionId} — possible extractor-shape mismatch`,
      { agentSessionId, transcriptLines: transcript.length }
    );
    // mt#3514 SAFETY: return BEFORE the orphan-removal delete below. A
    // non-empty transcript that extracts to zero turns is a suspected
    // EXTRACTOR regression, not evidence that the session has no turns — and
    // "delete every row this extraction did not emit" would, at zero turns,
    // wipe the session's entire turn history. The delete must never run on
    // this path; that is why it lives after this early return rather than
    // being guarded by a condition someone could later reorder.
    return {
      extracted: 0,
      written: 0,
      nonEmptyYieldedZero: true,
      erroredChunks: 0,
      orphansDeleted: 0,
      orphanDeleteFailed: false,
      chunkSplits: 0,
    };
  }

  // ── Serialization (mt#3514, PR #2736 R1) ───────────────────────────────
  // The upsert and the orphan DELETE must not interleave with ANOTHER writer
  // for the same session. Three callers can overlap in practice — the ingest
  // service (running continuously in the cockpit daemon), the
  // `index-embeddings --all` sweep, and `index-embeddings --session` — so a
  // concurrent run that extracts MORE turns could write rows at indexes this
  // run then deletes as "orphans." That is data loss, not a stale-row cleanup.
  //
  // Extends the session-scoped advisory-lock convention already used by
  // `withDrivenSessionResumeLock` (driven-session-registry-store.ts): a
  // TRANSACTION-scoped lock, because this runs on a pooled postgres-js
  // connection where a session-scoped acquire/release pair could land on
  // different connections. Blocking (`pg_advisory_xact_lock`) rather than
  // `try` — a second writer must WAIT its turn, not skip its write.
  //
  // Per-chunk SAVEPOINTs (drizzle's nested `transaction`) preserve mt#2457's
  // partial-write tolerance: without them a single failed chunk would poison
  // the whole transaction, turning a partial write into a total rollback and
  // silently changing `erroredChunks` semantics.
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(${TURN_WRITE_LOCK_NAMESPACE}, hashtext(${agentSessionId}))`
    );
    return writeTurnsLocked(tx, agentSessionId, turns, transcript, logSink);
  });
}

/** Advisory-lock namespace for per-session turn writes (mt#3514). */
const TURN_WRITE_LOCK_NAMESPACE = 3_514_001;

/** A half-open range of `turns` to send as one bulk-upsert statement. */
interface ChunkRange {
  start: number;
  size: number;
}

/**
 * Rows per bulk-upsert statement.
 *
 * **Sized against the statement TIMEOUT, not the bind-parameter ceiling
 * (mt#3911).** The previous value of 500 was justified solely by Postgres's
 * ~65535 bind-parameter limit (8 columns/row = 4,000 params, a wide margin) —
 * a ceiling this write never comes close to. The binding constraint is time:
 * an `ON CONFLICT DO UPDATE` that changes `user_text`/`assistant_text` cannot
 * be a HOT update, so every row's new tuple version is re-inserted into the
 * GIN `fts_text` index and the HNSW `embedding` index.
 *
 * Measured against prod 2026-08-10 (`statement_timeout` = 30s):
 *
 * | rows | session with embeddings | session without |
 * | ---- | ----------------------- | --------------- |
 * | 100  | 9.5–17.5s               | 2.4–6.6s        |
 * | 250  | 20.5–24.8s              | —               |
 * | 500  | FAILS at 31.2s          | —               |
 *
 * So ~100ms/row with embeddings, ~35ms/row without. 100 rows leaves real
 * headroom under 30s; 250 does not. Sessions >= 500 turns were the ones that
 * produced a 500-row chunk at all, and every one of them was silently writing
 * only a fraction of its turns.
 */
export const DEFAULT_TURN_CHUNK_SIZE = 100;

/**
 * Floor for the split-and-retry above. A chunk at or below this size is not
 * split further — if 10 rows cannot be written inside the statement timeout,
 * the problem is not chunk sizing, and bisecting to 1 would turn one slow
 * failure into ten.
 */
export const MIN_TURN_CHUNK_SIZE = 10;

/** Postgres SQLSTATE for a statement cancelled by `statement_timeout`. */
const PG_QUERY_CANCELED = "57014";

/**
 * True when `err` (or anything in its `cause` chain) is a Postgres
 * statement-timeout cancellation.
 *
 * Checks the SQLSTATE first because it is exact; falls back to the message
 * because drizzle wraps the driver error and the code is not always preserved
 * on the outer object — the observed mt#3911 failure surfaced the driver
 * message `canceling statement due to statement timeout` on `err.cause` with
 * no `code` on the wrapper.
 */
export function isStatementTimeout(err: unknown): boolean {
  for (let cursor: unknown = err, depth = 0; cursor && depth < 5; depth++) {
    const code = (cursor as { code?: unknown }).code;
    if (code === PG_QUERY_CANCELED) return true;
    const message = (cursor as { message?: unknown }).message;
    if (typeof message === "string" && message.includes("canceling statement due to statement")) {
      return true;
    }
    cursor = (cursor as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Single source of truth for the turn upsert's `ON CONFLICT DO UPDATE`
 * (mt#4345): the columns it writes DIRECTLY from `EXCLUDED` — every SET-block
 * entry except `embedding`, whose value is a `CASE` DERIVED from `userText`/
 * `assistantText` rather than a straight passthrough (mt#3883's invalidation
 * invariant, unrelated to this list).
 *
 * Both the SET clause and the skip-if-unchanged `setWhere` predicate below are
 * BUILT FROM this array (`turnUpsertDirectSet` / `buildTurnUpsertSkipIfUnchangedWhere`)
 * rather than hand-duplicated — so a column added here and forgotten in the
 * other place is not a possible bug, and a column added to the real upsert
 * without going through this array is not possible either, since this is the
 * only place either function reads from. `turn-writer.test.ts` asserts this
 * list's shape directly (exact key/column-name set, `IS DISTINCT FROM`
 * throughout) without needing a live Postgres — the ACTUAL skip behavior
 * still requires one, and is covered by
 * `scripts/verify-turn-write-skip-if-unchanged.ts`.
 */
/**
 * The exact key set `TurnUpsertDirectSetFields` (below) declares — a
 * literal-string union, not `string`, so that a `key` here TypeScript cannot
 * place in that interface is a COMPILE error, not just a failing test. This
 * is what makes `turnUpsertDirectSet` below assignment-safe with zero casts:
 * a `Record<TurnUpsertDirectSetKey, SQL>` indexed access is a normal keyed
 * property write, not a generic-string index that TypeScript can't verify.
 */
type TurnUpsertDirectSetKey =
  | "userText"
  | "userOrigin"
  | "assistantText"
  | "toolCalls"
  | "startedAt"
  | "endedAt"
  | "isSpawnBoundary";

export const TURN_UPSERT_DIRECT_SET_COLUMNS: ReadonlyArray<{
  readonly key: TurnUpsertDirectSetKey;
  readonly column: AnyPgColumn;
  readonly sqlName: string;
}> = [
  { key: "userText", column: agentTranscriptTurnsTable.userText, sqlName: "user_text" },
  // mt#4289, merged in on rebase (PR #3176): a change in provenance with
  // identical text does not invalidate a vector, which describes the TEXT —
  // so `userOrigin` is a direct-set column here (and correctly absent from
  // the embedding CASE at the call site) but must still participate in the
  // skip-if-unchanged predicate below, since `extractTurnsForAllTranscripts`
  // depends on a re-run rewriting `user_origin` on every row even when the
  // text is unchanged.
  { key: "userOrigin", column: agentTranscriptTurnsTable.userOrigin, sqlName: "user_origin" },
  {
    key: "assistantText",
    column: agentTranscriptTurnsTable.assistantText,
    sqlName: "assistant_text",
  },
  { key: "toolCalls", column: agentTranscriptTurnsTable.toolCalls, sqlName: "tool_calls" },
  { key: "startedAt", column: agentTranscriptTurnsTable.startedAt, sqlName: "started_at" },
  { key: "endedAt", column: agentTranscriptTurnsTable.endedAt, sqlName: "ended_at" },
  {
    key: "isSpawnBoundary",
    column: agentTranscriptTurnsTable.isSpawnBoundary,
    sqlName: "is_spawn_boundary",
  },
];

/**
 * The subset of `agent_transcript_turns`' insertable columns this upsert's
 * SET clause writes directly from `EXCLUDED` — i.e. every key
 * `TURN_UPSERT_DIRECT_SET_COLUMNS` names. A local, narrow mirror of
 * drizzle's `PgUpdateSetSource<typeof agentTranscriptTurnsTable>` (which is
 * not itself importable without a deep, non-`exports`-mapped path into
 * `drizzle-orm/pg-core/query-builders/update`) — structurally compatible
 * with it because both are optional-`SQL`-valued records over the same
 * table's column keys, so no cast is needed where this is spread into the
 * real `set:` object at the call site.
 */
type TurnUpsertDirectSetFields = Partial<Record<TurnUpsertDirectSetKey, SQL>>;

/**
 * The SET clause's direct-from-EXCLUDED entries, built from
 * `TURN_UPSERT_DIRECT_SET_COLUMNS`. The caller adds the one remaining entry
 * (`embedding`'s CASE expression) separately — see the call site for why
 * that column is not part of this list.
 *
 * Builds with a plain loop over a `TurnUpsertDirectSetFields`-typed
 * accumulator — no type assertion anywhere: `key` is typed
 * `TurnUpsertDirectSetKey`, a literal-string union, so `result[key] = ...` is
 * an ordinary keyed property write TypeScript can verify directly, not a
 * generic string index it has to be told to trust.
 */
function turnUpsertDirectSet(): TurnUpsertDirectSetFields {
  const result: TurnUpsertDirectSetFields = {};
  for (const { key, sqlName } of TURN_UPSERT_DIRECT_SET_COLUMNS) {
    result[key] = sql.raw(`EXCLUDED.${sqlName}`);
  }
  return result;
}

/**
 * Skip-if-unchanged predicate (mt#4345) for the turn upsert's `setWhere`:
 * without it, EVERY conflicting row is rewritten on every re-ingest, even
 * when nothing about it changed — 19.2M updates against 327k live rows in
 * prod, ~59 rewrites/row. An UPDATE that writes back identical bytes still
 * produces a new row version (a dead tuple autovacuum must later reclaim)
 * and, because the indexed `embedding` column sits in the SET list, cannot
 * take the HOT-update fast path — so it also churns the GIN `fts_text` index
 * and the HNSW `embedding` index on every write.
 *
 * Compares every column `turnUpsertDirectSet` writes — i.e. NOT `embedding`,
 * whose SET value is itself derived from `userText`/`assistantText` (see the
 * CASE at the call site), so comparing those two source columns already
 * covers whether the derived value would change. If none of the compared
 * columns differ, `DO UPDATE` fires no-op — Postgres skips the write, and a
 * WHERE-false row never touches an index.
 *
 * MUST be `IS DISTINCT FROM`, never `<>`: every column here is nullable (a
 * tool-only turn has no `assistant_text`), and SQL's `<>` returns NULL — not
 * TRUE — when either side is NULL, so `NULL <> NULL` is NULL rather than
 * "these are not the same." A predicate built from `<>` would therefore never
 * evaluate the whole OR chain to TRUE on any row carrying a NULL in a changed
 * column, silently turning this guard into a no-op for the common case. `IS
 * DISTINCT FROM` treats NULL as a comparable value (`NULL IS DISTINCT FROM
 * NULL` is FALSE; `NULL IS DISTINCT FROM 'x'` is TRUE) — exactly the "did
 * this column's value change" semantics wanted here.
 *
 * Every SET column is included, not just the text pair the embedding CASE
 * reads — `is_spawn_boundary` flipping with identical text is a real change
 * (mt#4345's spec counter-case) that a text-only predicate would silently
 * drop. Pure and DB-free: `turn-writer.test.ts` renders this via drizzle's
 * `PgDialect.sqlToQuery` and asserts the rendered text names every column and
 * uses `IS DISTINCT FROM` throughout — the shape seam the reviewer asked for
 * on PR #3176. What it cannot assert without a live Postgres is that the
 * predicate actually SKIPS the write; that is
 * `scripts/verify-turn-write-skip-if-unchanged.ts`'s job.
 */
export function buildTurnUpsertSkipIfUnchangedWhere(): SQL {
  const clauses = TURN_UPSERT_DIRECT_SET_COLUMNS.map(
    ({ column, sqlName }) => sql`${column} IS DISTINCT FROM ${sql.raw(`EXCLUDED.${sqlName}`)}`
  );
  return sql.join(clauses, sql` OR `);
}

/**
 * The upsert + orphan-removal body, running inside the caller's transaction
 * with the session's advisory lock already held. Split out so the locking and
 * the write logic are separately readable; not exported — the lock is not
 * optional.
 */
async function writeTurnsLocked(
  tx: PostgresJsDatabase,
  agentSessionId: string,
  turns: ReturnType<typeof extractTurns>,
  transcript: unknown[],
  logSink: TurnWriterLogSink
): Promise<WriteTurnsResult> {
  const db = tx;
  // mt#2457 perf: upsert in bulk, chunked, rather than one round-trip per
  // turn. A handful of legacy sessions run into the thousands of turns (up
  // to ~4,511 raw lines observed in the 2026-07-20 corpus measurement) —
  // per-turn serial round-trips to a remote Postgres made even a single such
  // session take on the order of a minute, which is what actually made the
  // full-corpus backfill impractical (not just the outer unbatched SELECT).
  // The chunk size is bounded by TIME, not by the bind-parameter ceiling — see
  // DEFAULT_TURN_CHUNK_SIZE. Ranges are held in a work queue rather than walked
  // by a `for` stride so that a chunk which exceeds the server's
  // `statement_timeout` can be SPLIT and retried instead of abandoned (mt#3911).
  const pending: ChunkRange[] = [];
  for (let start = 0; start < turns.length; start += DEFAULT_TURN_CHUNK_SIZE) {
    pending.push({ start, size: Math.min(DEFAULT_TURN_CHUNK_SIZE, turns.length - start) });
  }

  let written = 0;
  let erroredChunks = 0;
  let chunkSplits = 0;

  while (pending.length > 0) {
    const range = pending.shift() as ChunkRange;
    const chunk = turns.slice(range.start, range.start + range.size);
    // NOTE: `embedding` is deliberately omitted from the INSERT VALUES — a new
    // row starts NULL and the backfill fills it. The on-conflict SET below is a
    // different matter: since mt#3883 it nulls a vector whose text changed.
    // `fts_text` is GENERATED ALWAYS and must not be written either.
    const insertValues = chunk.map((turn) => ({
      agentSessionId,
      turnIndex: turn.turnIndex,
      userText: turn.userText ?? undefined,
      // mt#4289: who authored `user_text`. Written on the SAME statement as the
      // text it describes — a separate pass would let the two disagree, and a
      // row whose text says one thing and whose provenance says another is
      // worse than one carrying no provenance at all.
      userOrigin: turn.userOrigin ?? undefined,
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
      // SAVEPOINT per chunk (mt#3514): inside the outer transaction a failed
      // statement would otherwise abort everything, so a single bad chunk
      // would roll back chunks that already succeeded — silently converting
      // mt#2457's tolerated PARTIAL write into a total loss.
      await db.transaction(async (sp) => {
        await sp
          .insert(agentTranscriptTurnsTable)
          .values(insertValues)
          .onConflictDoUpdate({
            target: [agentTranscriptTurnsTable.agentSessionId, agentTranscriptTurnsTable.turnIndex],
            // ADR-019's embedding-preservation invariant, made CONDITIONAL on the
            // text being unchanged (mt#3883).
            //
            // Preserving unconditionally was correct only while turn boundaries
            // were stable. Once a boundary moves — which is exactly what the
            // mt#3883 fusion fix does, for 23.3% of conversations — turn N's TEXT
            // is overwritten by a different turn's content while turn N's VECTOR
            // is kept. The row then has an embedding describing text it no longer
            // holds, and semantic search returns it for the wrong query. Nothing
            // downstream can notice: the row is present, well-formed, and
            // non-null, so it fails as a confident wrong answer rather than an
            // error.
            //
            // The invariant that was actually meant is "do not clobber a vector
            // that still describes this row." Comparing the two columns
            // `buildEmbedText` reads (per-turn-embedding-pipeline.ts: user_text +
            // assistant_text, NOT tool_calls) expresses that directly: identical
            // text keeps the vector, changed text nulls it so the embedding
            // backfill refills it on its next pass.
            set: {
              // Every direct-from-EXCLUDED entry, built from the single source
              // of truth above — see `turnUpsertDirectSet`'s doc comment. This
              // now includes `userOrigin` (mt#4289, merged in here on rebase):
              // listed as a direct-set column and NOT in the embedding CASE
              // below, because a change in provenance with identical text does
              // not invalidate a vector, which describes the TEXT. That is also
              // why `userOrigin` must flow through the skip-if-unchanged
              // predicate too, not just the SET clause — the existing
              // `extractTurnsForAllTranscripts` sweep depends on a re-run
              // rewriting `user_origin` on every row even when the text is
              // unchanged; a guard that only compared text would have silently
              // skipped that write once mt#4345 shipped.
              ...turnUpsertDirectSet(),
              // `embedding` is the one SET entry NOT in that list: its value is
              // DERIVED from userText/assistantText rather than a straight
              // EXCLUDED passthrough — see `buildTurnUpsertSkipIfUnchangedWhere`'s
              // doc comment for why that derivation means comparing the two
              // source text columns already covers this one.
              embedding: sql`CASE WHEN ${agentTranscriptTurnsTable.userText} IS DISTINCT FROM EXCLUDED.user_text OR ${agentTranscriptTurnsTable.assistantText} IS DISTINCT FROM EXCLUDED.assistant_text THEN NULL ELSE ${agentTranscriptTurnsTable.embedding} END`,
            },
            // Skip-if-unchanged guard (mt#4345) — see
            // `buildTurnUpsertSkipIfUnchangedWhere`'s doc comment for the full
            // rationale (HOT-update mechanism, the `IS DISTINCT FROM` vs `<>`
            // trap, and why `is_spawn_boundary` is included alongside text).
            setWhere: buildTurnUpsertSkipIfUnchangedWhere(),
          });
      });
      written += chunk.length;
    } catch (err) {
      // mt#3911: a chunk that blew the server's `statement_timeout` is a
      // SIZING failure, not a data failure — the same rows succeed when sent
      // in smaller statements. Split and retry rather than abandoning them,
      // because abandoning them also costs the session its orphan removal
      // below (which is skipped whenever `erroredChunks > 0`).
      //
      // Deliberately narrow: ONLY a timeout is retried. Any other error is
      // counted immediately and NOT split — a deterministic failure (the
      // U+0000 class of mem#750 is the live example: unrepresentable in
      // Postgres text, so it fails identically forever) would otherwise be
      // bisected all the way down to the floor, turning one fast failure into
      // a long series of slow ones.
      if (isStatementTimeout(err) && range.size > MIN_TURN_CHUNK_SIZE) {
        const head = Math.ceil(range.size / 2);
        pending.unshift(
          { start: range.start, size: head },
          { start: range.start + head, size: range.size - head }
        );
        chunkSplits++;
        logSink.warn(
          `writeTurnsForTranscript: chunk of ${chunk.length} turns for ${agentSessionId} ` +
            `exceeded the statement timeout — splitting into ${head} + ${range.size - head} ` +
            `and retrying`,
          { agentSessionId, chunkSize: chunk.length, startIndex: range.start }
        );
        continue;
      }
      // mt#2457 R1 review: a failed chunk must be counted as an error, not
      // silently swallowed — otherwise a transcript whose writes all failed
      // (written stays 0) is classified downstream as "skipped" (nothing to
      // do) rather than "errored" (something went wrong).
      erroredChunks++;
      logSink.warn(
        `writeTurnsForTranscript: failed to upsert a chunk of ${chunk.length} turns for ` +
          `${agentSessionId} (turns ${chunk[0]?.turnIndex}-${chunk[chunk.length - 1]?.turnIndex})`,
        {
          error: getLoggableErrorSummary(err),
        }
      );
    }
  }

  // ── Orphan removal (mt#3514) ───────────────────────────────────────────
  // `turnIndex` is assigned contiguously 0..N-1 over the whole transcript
  // (turn-extractor.ts: `let turnIndex = 0` … `turnIndex++` per emitted turn),
  // so after writing N turns, every row for this session at `turn_index >= N`
  // is a row a PREVIOUS extraction emitted and this one did not — an orphan.
  // The upsert above cannot reach it, and before this nothing else did either.
  //
  // Skipped when any chunk failed: the upsert half is already known-degraded,
  // and compounding it with a delete would make the session's state harder to
  // reason about, not easier. A later clean run removes the orphans.
  let orphansDeleted = 0;
  let orphanDeleteFailed = false;
  // Single-sourced (mt#3911) so the bound in the QUERY and the bound in the
  // log below cannot drift apart, and so the intended value is stated once:
  // the count the EXTRACTOR produced — never `written`, which under-counts
  // whenever a chunk failed and would make the delete remove rows this run
  // simply did not manage to write.
  const orphanBound = turns.length;
  if (erroredChunks === 0) {
    try {
      const deleted = await db
        .delete(agentTranscriptTurnsTable)
        .where(
          and(
            eq(agentTranscriptTurnsTable.agentSessionId, agentSessionId as ConversationId),
            gte(agentTranscriptTurnsTable.turnIndex, orphanBound)
          )
        )
        .returning({ turnIndex: agentTranscriptTurnsTable.turnIndex });
      orphansDeleted = deleted.length;
      if (orphansDeleted > 0) {
        logSink.warn(
          `writeTurnsForTranscript: removed ${orphansDeleted} orphaned turn row(s) for ` +
            `${agentSessionId} at turn_index >= ${orphanBound} — left by an earlier ` +
            `extraction that emitted more turns than this one`,
          { agentSessionId, orphansDeleted, currentTurnCount: orphanBound }
        );
      }
    } catch (err) {
      orphanDeleteFailed = true;
      logSink.warn(
        `writeTurnsForTranscript: failed to remove orphaned turn rows for ${agentSessionId} ` +
          `at turn_index >= ${orphanBound}`,
        { error: getLoggableErrorSummary(err) }
      );
    }
  }

  return {
    extracted: turns.length,
    written,
    nonEmptyYieldedZero: false,
    erroredChunks,
    orphansDeleted,
    orphanDeleteFailed,
    chunkSplits,
  };
}

/** Which aggregate bucket a single transcript's write outcome falls into. */
export type WriteOutcomeBucket = "processed" | "skipped" | "errored";

/** Pure classification of a single transcript's write outcome (mt#3628). */
export interface WriteOutcomeClassification {
  bucket: WriteOutcomeBucket;
  /** Turns to add to the running `turnsWritten` aggregate for this transcript. */
  turnsWritten: number;
  /**
   * Turns to add to the running `turnsExtracted` aggregate (mt#3911). Carried
   * in EVERY bucket, including `errored` — a transcript that extracted 604 and
   * wrote 104 must report both numbers, since their divergence IS the defect
   * signal.
   */
  turnsExtracted: number;
  /** Chunk splits to add to the running aggregate (mt#3911). */
  chunkSplits: number;
  /**
   * Whether THIS transcript's orphan DELETE failed (mt#3911).
   *
   * Carried through the classification for the same reason `orphansDeleted`
   * is: the aggregate — and therefore the operator-facing line — has no other
   * way to see it. Without this the field existed on `WriteTurnsResult`,
   * was honored by the bucketing, and still could not be rendered, which is
   * the precise defect this task exists to fix, one level down.
   */
  orphanDeleteFailed: boolean;
  /** Whether this outcome should also increment the aggregate's `nonEmptyYieldedZero`. */
  countNonEmptyYieldedZero: boolean;
  /**
   * Orphaned rows removed for this transcript (mt#3514) — carried through the
   * classification so the sweep's aggregate reports it in EVERY bucket. An
   * errored transcript can still have deleted orphans before the failure, and
   * dropping that count on the error path would understate the sweep's effect.
   */
  orphansDeleted: number;
}

/**
 * Pure decision core for `extractTurnsForAllTranscripts`'s per-transcript
 * bucketing (mt#3628, extracted from mt#2457 R1 review's chunk-failure
 * classification). Any chunk error takes priority over the write count —
 * a partial write (`written > 0` alongside `erroredChunks > 0`) is still
 * `\"errored\"`, not folded into `\"processed\"` just because some turns
 * landed. No I/O, no logger: testable entirely by return value.
 */
export function classifyWriteOutcome({
  extracted,
  written,
  nonEmptyYieldedZero,
  erroredChunks,
  orphansDeleted,
  orphanDeleteFailed,
  chunkSplits,
}: WriteTurnsResult): WriteOutcomeClassification {
  // mt#3514: a failed orphan DELETE is an error even when every chunk upserted
  // cleanly. The session is left holding stale rows the upsert cannot reach —
  // the exact state this mechanism exists to remove — so classifying it
  // "processed" would re-hide the defect behind a success count.
  if (erroredChunks > 0 || orphanDeleteFailed) {
    return {
      bucket: "errored",
      turnsWritten: written > 0 ? written : 0,
      turnsExtracted: extracted,
      chunkSplits,
      orphanDeleteFailed,
      countNonEmptyYieldedZero: false,
      orphansDeleted,
    };
  }
  if (written === 0) {
    return {
      bucket: "skipped",
      turnsWritten: 0,
      turnsExtracted: extracted,
      chunkSplits,
      orphanDeleteFailed,
      countNonEmptyYieldedZero: nonEmptyYieldedZero,
      orphansDeleted,
    };
  }
  return {
    bucket: "processed",
    turnsWritten: written,
    turnsExtracted: extracted,
    chunkSplits,
    orphanDeleteFailed,
    countNonEmptyYieldedZero: false,
    orphansDeleted,
  };
}

/** Aggregate result of an extraction reconciliation sweep. */
export interface ExtractAllTurnsResult {
  transcriptsScanned: number;
  transcriptsProcessed: number;
  transcriptsSkipped: number;
  /**
   * Transcripts whose write hit an error: either a chunk upsert failed
   * (`WriteTurnsResult.erroredChunks > 0`) or the row-level try/catch below
   * caught an unexpected throw. Distinct from `transcriptsSkipped`, which
   * means "nothing to write" (empty/absent transcript), not "tried and
   * failed."
   */
  transcriptsErrored: number;
  turnsWritten: number;
  /**
   * Turns the extractor PRODUCED across the sweep (mt#3911). Equal to
   * `turnsWritten` in steady state; a shortfall is the partial-write signal
   * that was previously invisible because only `turnsWritten` was reported —
   * and reported under the label `extracted=`.
   */
  turnsExtracted: number;
  /** Chunks split and retried after a statement timeout (mt#3911). */
  chunkSplits: number;
  /**
   * Transcripts whose orphan DELETE itself failed (mt#3911). Always rendered,
   * even at zero, so "the delete ran and found nothing" and "the delete ran
   * and threw" are distinguishable from the output line alone.
   */
  orphanDeletesFailed: number;
  /**
   * mt#2457 SC3: count of non-empty transcripts that yielded zero turns with
   * NO chunk errors — an extraction/extractor-shape-mismatch signal, distinct
   * from both a genuinely-empty-session skip and a write-error (which counts
   * under `transcriptsErrored` instead, even if `nonEmptyYieldedZero` would
   * also otherwise apply). Non-zero here means something needs investigating;
   * it should not happen in steady state.
   */
  nonEmptyYieldedZero: number;
  /**
   * Total orphaned turn rows removed across the sweep (mt#3514). In steady
   * state this is 0; a non-zero value on a corpus-wide run is the backlog of
   * stale rows accumulated while nothing deleted them.
   */
  orphansDeleted: number;
  /**
   * True when the sweep stopped early because a batch fetch (`fetchPage`)
   * failed, rather than reaching a clean end-of-corpus completion (an empty
   * page). Callers must treat an aborted sweep as INCOMPLETE — the corpus is
   * not fully reconciled — and should retry/resume via `afterId` once the
   * underlying fetch issue is diagnosed. Before mt#2457 R1 review this was
   * only logged, with no signal in the returned result to distinguish
   * "finished cleanly" from "gave up partway through."
   */
  aborted: boolean;
}

/**
 * Counters shown even when zero, because their ABSENCE is information: a run
 * that extracted nothing and a run that wrote nothing must not render as an
 * empty string. Everything else is shown only when non-zero.
 */
const ALWAYS_SHOWN_COUNTERS: ReadonlySet<string> = new Set([
  "turnsExtracted",
  "turnsWritten",
  // `orphansDeleted` is always shown even at zero because a NO-OP delete is
  // the exact shape of the mt#3911 incident: the operator needs to be able to
  // tell "the delete ran and found nothing" from "the delete never ran" from
  // the output line alone, without a database query.
  "orphansDeleted",
  // Same reasoning, and the other half of the spec criterion: a delete that
  // THREW must be readable from the line, not inferable only from the
  // DEGRADED marker (which several unrelated conditions also set).
  "orphanDeletesFailed",
]);

/**
 * True when the sweep's own numbers say it did not fully succeed (mt#3911).
 *
 * Note the third clause: `turnsWritten < turnsExtracted` is degraded even when
 * no transcript landed in the errored bucket, because that is precisely the
 * shape of a partial write.
 */
export function isDegradedExtraction(result: ExtractAllTurnsResult): boolean {
  return (
    result.transcriptsErrored > 0 ||
    result.orphanDeletesFailed > 0 ||
    result.aborted ||
    result.nonEmptyYieldedZero > 0 ||
    result.turnsWritten < result.turnsExtracted
  );
}

/**
 * Render an extraction result from its own SHAPE rather than from a
 * hand-maintained field list (mt#3911).
 *
 * The defect this exists to prevent: `index-embeddings` built its output line
 * by naming two fields inline, so `orphansDeleted` and `orphanDeleteFailed`
 * — added by mt#3514, plumbed through three modules, typechecked, and
 * unit-tested — were invisible at every operator surface. Every subsequent
 * field would have inherited that default. Here a new counter on
 * `ExtractAllTurnsResult` is surfaced automatically and an author has to opt
 * OUT by excluding it, rather than opt in by remembering this call site.
 */
export function formatExtractAllTurnsResult(result: ExtractAllTurnsResult): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(result)) {
    if (typeof value === "number") {
      if (value !== 0 || ALWAYS_SHOWN_COUNTERS.has(key)) parts.push(`${key}=${value}`);
    } else if (typeof value === "boolean") {
      if (value) parts.push(`${key}=true`);
    }
  }
  const body = parts.join(", ");
  return isDegradedExtraction(result) ? `DEGRADED(${body})` : body;
}

/** One page of `(agentSessionId, transcript)` rows for the reconciliation sweep. */
export type TranscriptPageRow = { agentSessionId: string; transcript: unknown };

/**
 * Fetches one keyset-paginated page of `agent_transcripts` rows, ordered by
 * `agent_session_id` (the table's primary key — no new index required).
 * Exposed as an injectable seam (`ExtractAllTurnsOptions.fetchPage`) so
 * `extractTurnsForAllTranscripts`'s batching/resumability logic is testable
 * without mocking the drizzle query-builder chain.
 *
 * Executes the query explicitly (awaits it to a concrete array) rather than
 * returning the drizzle query builder itself — the builder IS thenable, so
 * returning it directly would have worked, but only by relying on the
 * caller's `await` implicitly unwrapping it (mt#2457 R1 review: "brittle
 * thenable behavior"). Awaiting here makes the function's own return type
 * (`Promise<TranscriptPageRow[]>`) match what actually comes back, with no
 * implicit unwrapping left to the caller.
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

  const rows = afterId
    ? await query.where(gt(agentTranscriptsTable.agentSessionId, afterId as ConversationId))
    : await query;
  return rows;
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
  /** Injectable warn/error sink (mt#3628); see `TurnWriterLogSink`. */
  logSink?: TurnWriterLogSink;
}

/**
 * Extraction reconciliation: ensure every `agent_transcripts` row has its turns
 * materialized into `agent_transcript_turns`. This is the catch-up for sessions
 * that were ingested before extraction-on-capture existed (or whose turn rows
 * were otherwise lost). Idempotent: the upsert never computes an embedding, and
 * preserves an existing one whenever the row's text is unchanged (mt#3883).
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
  const logSink = options.logSink ?? defaultLogSink;

  const result: ExtractAllTurnsResult = {
    transcriptsScanned: 0,
    transcriptsProcessed: 0,
    transcriptsSkipped: 0,
    transcriptsErrored: 0,
    turnsWritten: 0,
    turnsExtracted: 0,
    chunkSplits: 0,
    orphanDeletesFailed: 0,
    nonEmptyYieldedZero: 0,
    orphansDeleted: 0,
    aborted: false,
  };

  let cursor: string | null = options.afterId ?? null;

  for (;;) {
    let rows: TranscriptPageRow[];
    try {
      rows = await fetchPage(db, cursor, batchSize);
    } catch (err) {
      // mt#2457 R1 review: a fetch failure must be visible in the RESULT, not
      // just the log — a caller reading only the returned counts previously
      // had no way to tell "clean end of corpus" from "gave up on a fetch
      // error partway through" (both looked like a normal loop exit).
      result.aborted = true;
      logSink.error("extractTurnsForAllTranscripts: failed to load a transcript batch", {
        error: getLoggableErrorSummary(err),
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
        const outcome = await writeTurnsForTranscript(
          db,
          row.agentSessionId,
          row.transcript,
          logSink
        );
        // mt#3628: bucketing is a pure decision (classifyWriteOutcome) — any
        // chunk write failure is an error even when some OTHER chunk of the
        // same transcript succeeded (written > 0); a partial write is not
        // "processed", it's a degraded result that needs investigating, same
        // as a total write failure.
        const classification = classifyWriteOutcome(outcome);
        // mt#3514: accumulate before the bucket switch — orphan removal is
        // orthogonal to which bucket the transcript lands in. Same for
        // mt#3911's counters: a transcript's extracted count and its chunk
        // splits are meaningful in EVERY bucket, and the errored bucket is
        // exactly where the extracted-vs-written gap needs to show up.
        result.orphansDeleted += classification.orphansDeleted;
        result.turnsExtracted += classification.turnsExtracted;
        result.chunkSplits += classification.chunkSplits;
        if (classification.orphanDeleteFailed) result.orphanDeletesFailed++;
        switch (classification.bucket) {
          case "errored":
            result.transcriptsErrored++;
            result.turnsWritten += classification.turnsWritten;
            break;
          case "skipped":
            result.transcriptsSkipped++;
            if (classification.countNonEmptyYieldedZero) {
              result.nonEmptyYieldedZero++;
            }
            break;
          case "processed":
            result.transcriptsProcessed++;
            result.turnsWritten += classification.turnsWritten;
            break;
        }
      } catch (err) {
        result.transcriptsErrored++;
        logSink.warn(`extractTurnsForAllTranscripts: failed for ${row.agentSessionId}`, {
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

  log.info("extractTurnsForAllTranscripts: complete", { ...result });
  return result;
}
