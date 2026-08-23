/**
 * TitlePipeline (mt#3321)
 *
 * Fills `agent_transcripts.title` for conversations that don't have one yet.
 *
 * **The work set is "untitled AND not already asked" (mt#4179).** It used to be
 * `WHERE title IS NULL` alone, which reads as idempotent-by-construction and is
 * — but only for rows that CAN succeed. A row the model declines to title
 * (nothing in it names a subject) stays NULL forever and is re-selected on
 * every tick, so with the batch ordered newest-first those rows accumulate at
 * the head of the queue until they fill it. Measured 2026-08-16: 15 consecutive
 * sweeps, 25 candidates each, ~25 skipped, 0 errored, while 1,289 older untitled
 * rows sat below a block of ~29 permanent skips and could never be reached.
 * `title_attempted_at` is what makes "not yet tried" distinguishable from
 * "tried, cannot succeed"; the batch advances because a stamped row leaves the
 * candidate set.
 *
 * **Content comes from `agent_transcript_turns`, not the raw blob (mt#4179).**
 * ADR-025 (Accepted) drops `agent_transcripts.transcript`; the per-turn rows
 * survive it and are written on capture (ADR-019 / mt#2381), so reading them
 * both outlives the column and stops pulling a multi-megabyte JSONB blob into
 * memory per candidate.
 *
 * **Batched and SQL-filtered.** Deliberately NOT modeled on
 * {@link SummaryPipeline}, which `SELECT`s every row in `agent_transcripts`
 * and filters in memory — fine for a hand-run backfill, wrong for something
 * on a timer. This filters and limits in SQL, so a tick costs one bounded
 * query plus at most `batchSize` completion calls regardless of table size.
 * That bound is also the API-spend control while the ~2k-row history drains.
 *
 * **Failures are recorded, never swallowed into "nothing to do."** A provider
 * error increments `errored` and logs with the session id; it does NOT write a
 * placeholder title, and — since mt#4179 — it does NOT stamp
 * `title_attempted_at` either, so a model outage retries later instead of being
 * recorded as a verdict about the conversation. This is deliberate: a mechanism
 * whose broken dependency degrades into a looks-like-success empty result is
 * this codebase's dominant latent-bug shape (mem#682), and a title pipeline
 * that silently titled nothing forever would be invisible from every surface.
 *
 * @see mt#3321 — this module
 * @see mt#4179 — the head-of-line fix and the turns-table source
 * @see title-generator.ts — the model call
 * @see src/cockpit/sweepers.ts — `startConversationTitleSweeper`, the invocation path
 */

import { and, asc, eq, isNotNull, isNull, or, sql, type SQLWrapper } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import { agentTranscriptsTable } from "../storage/schemas/agent-transcripts-schema";
import { agentTranscriptTurnsTable } from "../storage/schemas/agent-transcript-turns-schema";
import { getLoggableErrorSummary } from "../errors/index";
import { log } from "@minsky/shared/logger";
import type { CognitionProvider } from "../cognition/types";
import {
  TitleGenerator,
  selectTitleTurns,
  TURN_SCAN_LIMIT,
  type TitleTurn,
} from "./title-generator";

/**
 * Rows titled per tick. Bounds both wall-clock and API spend for one run.
 * Sized so the ~2k-row backlog drains over a few hours at the sweeper's
 * cadence rather than in one burst of completion calls.
 */
export const DEFAULT_TITLE_BATCH_SIZE = 25;

/**
 * Why an attempt produced no title. Persisted to `title_skip_reason`.
 *
 * The three are distinguished because they have DIFFERENT re-ask triggers, not
 * for reporting flavor:
 *
 * - `no-turns` — the conversation has no text-bearing turn row *yet*. This can
 *   be a race rather than a verdict (see {@link TitlePipeline.candidateConditions}),
 *   so it is the one reason that re-enters the candidate set on turn arrival.
 * - `no-content` — turn rows exist, but nothing in the scanned window survives
 *   markup/attachment stripping. Deterministic given the content; re-asked only
 *   when new content arrives.
 * - `no-subject` — the model read real content and declined to name a subject.
 *   Also re-asked only on new content.
 *
 * `no-content` is split out from `no-subject` because only the latter cost a
 * model call: collapsing them would make the skip counters unable to say
 * whether the model declined or was never asked.
 */
export type TitleSkipReason = "no-turns" | "no-content" | "no-subject";

export interface TitlePipelineRunResult {
  /** Rows selected as candidates this run (bounded by `batchSize`). */
  candidates: number;
  /** Rows for which a title was generated and written. */
  titled: number;
  /** Rows attempted that produced no title. Sum of the two breakdowns below. */
  skipped: number;
  /** Skipped because the conversation has no text-bearing turn row at all. */
  skippedNoTurns: number;
  /** Skipped because every scanned turn was markup/attachment only — no model call made. */
  skippedNoContent: number;
  /** Skipped because the model read real content and found no identifiable subject. */
  skippedNoSubject: number;
  /** Rows that errored (provider or write failure). Left unstamped for a later retry. */
  errored: number;
}

export interface TitlePipelineOptions {
  /** Re-title rows that already have a title, and re-ask rows already attempted. Default: false. */
  force?: boolean;
  /** Rows per run. Default: {@link DEFAULT_TITLE_BATCH_SIZE}. */
  batchSize?: number;
}

/**
 * WHERE conditions selecting titling candidates — the ONE definition.
 *
 * Exported, and a free function rather than a method, because it has a SECOND
 * caller: `scripts/smoke-conversation-titles.ts` previews the candidate set the
 * sweeper would pick. That script used to restate the filter, and a restated
 * filter drifts — it drifted twice inside mt#4179 alone (it still carried
 * `transcript IS NOT NULL AND title IS NULL` after the pipeline had moved on,
 * and then still lacked the `no-turns` clause after the pipeline gained it, which
 * is what PR #3040 R1 caught). An acceptance instrument that previews a
 * different query than the one it exists to check is worse than no instrument,
 * so there is now nothing to keep in sync.
 *
 * Built as an explicit array rather than passing a conditional `undefined`
 * into `and(...)` (PR #2408 R1). Drizzle does drop `undefined` arguments —
 * verified against 0.44.2: `and(cond, undefined)` yields a valid
 * single-condition expression and `and(undefined)` yields `undefined` — but
 * relying on that makes the force branch's SQL depend on an implicit library
 * behavior a reader has to know to check. The array form states the intent
 * directly and is testable via {@link TitlePipeline.candidateConditionCount}.
 *
 * The `transcript IS NOT NULL` condition this used to carry is gone with the
 * blob read (mt#4179). A contentless row is no longer excluded up front — it
 * is attempted once, stamped, and leaves the candidate set, which costs one
 * slot exactly once instead of a permanent filter on a column ADR-025 removes.
 *
 * **The third clause closes a two-channel race.** Content now comes from
 * `agent_transcript_turns`, but the re-ask trigger is
 * `last_ingested_jsonl_timestamp` — the BLOB-ingest high-water mark. Those are
 * different channels: ingest writes the transcript row and its HWM BEFORE the
 * turn rows, turn writes are tolerated-partial by design (mt#2457/mt#3514),
 * and the embeddings-path re-materialization deliberately does not bump the
 * HWM. So an attempt landing in that window sees zero turns for a conversation
 * that has content, and the HWM clause alone would never re-open it. A
 * `no-turns` row therefore also re-enters once a text-bearing turn row EXISTS.
 *
 * That clause is scoped to `no-turns` precisely so it terminates: the re-ask
 * either produces a title or lands on `no-content` / `no-subject`, neither of
 * which the clause matches. Widening it to every skip reason would re-create
 * the permanent-candidate defect this task exists to fix, one reason over.
 *
 * The EXISTS is written as raw SQL rather than drizzle's `exists()` helper
 * because that helper needs a `db`-built subquery, and this function is the
 * seam {@link TitlePipeline.candidateConditionCount} exercises with a fake
 * `db` — building the subquery here would make the shape assertion depend on
 * the fake.
 */
export function titleCandidateConditions(): SQLWrapper[] {
  return [
    isNull(agentTranscriptsTable.title),
    // Not yet asked; or asked before content that has since arrived; or asked
    // when no turn row was visible and one has since landed. The middle
    // comparison is NULL-safe by construction: when
    // `last_ingested_jsonl_timestamp` is NULL it yields NULL rather than true,
    // so a stamped row with no new content stays out of the candidate set.
    sql`(${agentTranscriptsTable.titleAttemptedAt} IS NULL
         OR ${agentTranscriptsTable.lastIngestedJsonlTimestamp} > ${agentTranscriptsTable.titleAttemptedAt}
         OR (${agentTranscriptsTable.titleSkipReason} = 'no-turns' AND EXISTS (
               SELECT 1 FROM ${agentTranscriptTurnsTable} turns_probe
                WHERE turns_probe.agent_session_id = ${agentTranscriptsTable.agentSessionId}
                  AND (turns_probe.user_text IS NOT NULL
                       OR turns_probe.assistant_text IS NOT NULL))))`,
  ];
}

export class TitlePipeline {
  private readonly generator: TitleGenerator;

  constructor(
    private readonly db: PostgresJsDatabase,
    cognitionProvider: CognitionProvider,
    private readonly options: TitlePipelineOptions = {}
  ) {
    this.generator = new TitleGenerator(cognitionProvider);
  }

  /** {@link titleCandidateConditions}, or none at all under `force`. */
  private candidateConditions(): SQLWrapper[] {
    // force re-titles every row — both filters are omitted rather than negated.
    if (this.options.force) return [];
    return titleCandidateConditions();
  }

  /**
   * Number of WHERE conditions the current options produce — 2 normally
   * (untitled AND not-already-asked), 0 under `force` (every row). Exposed for
   * tests so the force branch's query shape is asserted against the real
   * builder rather than inferred from a fake DB.
   */
  candidateConditionCount(): number {
    return this.candidateConditions().length;
  }

  async run(): Promise<TitlePipelineRunResult> {
    const result: TitlePipelineRunResult = {
      candidates: 0,
      titled: 0,
      skipped: 0,
      skippedNoTurns: 0,
      skippedNoContent: 0,
      skippedNoSubject: 0,
      errored: 0,
    };
    const batchSize = this.options.batchSize ?? DEFAULT_TITLE_BATCH_SIZE;
    const conditions = this.candidateConditions();

    let rows: Array<{ agentSessionId: string }>;
    try {
      const base = this.db
        .select({ agentSessionId: agentTranscriptsTable.agentSessionId })
        .from(agentTranscriptsTable);
      rows = await (conditions.length > 0 ? base.where(and(...conditions)) : base)
        // Newest first: the conversation an operator is most likely looking at
        // right now is the one that most needs a readable title.
        .orderBy(sql`${agentTranscriptsTable.startedAt} DESC NULLS LAST`)
        .limit(batchSize);
    } catch (err) {
      log.error("TitlePipeline: failed to load candidate transcripts", {
        error: getLoggableErrorSummary(err),
      });
      return result;
    }

    result.candidates = rows.length;

    for (const row of rows) {
      try {
        const outcome = await this.titleRow(row.agentSessionId);
        if (outcome === null) {
          result.titled++;
        } else {
          result.skipped++;
          if (outcome === "no-turns") result.skippedNoTurns++;
          else if (outcome === "no-content") result.skippedNoContent++;
          else result.skippedNoSubject++;
        }
      } catch (err) {
        result.errored++;
        log.warn(`TitlePipeline: failed to title ${row.agentSessionId}`, {
          error: getLoggableErrorSummary(err),
        });
      }
    }

    if (result.candidates > 0) {
      log.info("TitlePipeline: run complete", { ...result });
    }
    return result;
  }

  /**
   * Generate and persist a title for one transcript.
   *
   * Returns `null` when a title was written, or the {@link TitleSkipReason}
   * recorded when none could be. Both outcomes stamp `title_attempted_at`, so
   * the row leaves the candidate set either way; a THROW (provider failure)
   * propagates without stamping, leaving the row for a later tick.
   */
  private async titleRow(agentSessionId: string): Promise<TitleSkipReason | null> {
    const turns = await this.loadTurns(agentSessionId);
    if (turns.length === 0) return this.recordSkip(agentSessionId, "no-turns");

    // Applied HERE as well as inside the generator so the two no-model-call
    // cases stay distinguishable: a row whose every scanned turn is markup or
    // an attachment placeholder is `no-content`, not `no-subject`. Letting the
    // generator's own empty-selection guard answer for both would report a
    // model verdict for a call that was never made.
    const visible = selectTitleTurns(turns);
    if (visible.length === 0) return this.recordSkip(agentSessionId, "no-content");

    const title = await this.generator.generateTitle(agentSessionId, visible);
    if (!title) return this.recordSkip(agentSessionId, "no-subject");

    await this.db
      .update(agentTranscriptsTable)
      .set({ title, titleAttemptedAt: new Date(), titleSkipReason: null })
      // `agentSessionId` is a BRANDED ConversationId column, so a plain string
      // does not satisfy `eq`'s type; the sql template binds it as a parameter.
      .where(sql`${agentTranscriptsTable.agentSessionId} = ${agentSessionId}`);

    return null;
  }

  /**
   * The conversation's opening turns that carry any text at all.
   *
   * Rows with both text columns NULL are dropped in SQL because they are the
   * BULK of a working conversation's opening — an agent running Read/Grep/Bash
   * emits them continuously — and letting them consume the scan window is the
   * defect this fixes. The finer judgment (a turn whose only text is an
   * attachment placeholder or harness markup) belongs to the generator, which
   * owns what the model sees.
   */
  private async loadTurns(agentSessionId: string): Promise<TitleTurn[]> {
    return await this.db
      .select({
        userText: agentTranscriptTurnsTable.userText,
        assistantText: agentTranscriptTurnsTable.assistantText,
      })
      .from(agentTranscriptTurnsTable)
      .where(
        and(
          eq(agentTranscriptTurnsTable.agentSessionId, agentSessionId),
          or(
            isNotNull(agentTranscriptTurnsTable.userText),
            isNotNull(agentTranscriptTurnsTable.assistantText)
          )
        )
      )
      .orderBy(asc(agentTranscriptTurnsTable.turnIndex))
      .limit(TURN_SCAN_LIMIT);
  }

  /** Stamp an attempt that produced no title, and echo the reason back to the caller. */
  private async recordSkip(
    agentSessionId: string,
    reason: TitleSkipReason
  ): Promise<TitleSkipReason> {
    await this.db
      .update(agentTranscriptsTable)
      .set({ titleAttemptedAt: new Date(), titleSkipReason: reason })
      // Branded-column binding, same as the title write above.
      .where(sql`${agentTranscriptsTable.agentSessionId} = ${agentSessionId}`);
    return reason;
  }
}
