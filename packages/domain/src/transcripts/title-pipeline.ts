/**
 * TitlePipeline (mt#3321)
 *
 * Fills `agent_transcripts.title` for conversations that don't have one yet.
 *
 * **Idempotent by construction, not by bookkeeping:** the work set IS
 * `WHERE title IS NULL`, so a re-run naturally does nothing for rows already
 * titled, and a crash mid-run resumes on the next tick with no state to
 * reconcile. `force` re-titles rows that already have one (operator escape
 * hatch for a prompt change), and is the only way to overwrite.
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
 * placeholder title. The row stays NULL and is retried on a later tick. This
 * is deliberate — a mechanism whose broken dependency degrades into a
 * looks-like-success empty result is this codebase's dominant latent-bug shape
 * (mem#682), and a title pipeline that silently titled nothing forever would
 * be invisible from every surface.
 *
 * @see mt#3321 — this module
 * @see title-generator.ts — the model call
 * @see src/cockpit/sweepers.ts — `startConversationTitleSweeper`, the invocation path
 */

import { and, isNull, isNotNull, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import { agentTranscriptsTable } from "../storage/schemas/agent-transcripts-schema";
import { getLoggableErrorSummary } from "../errors/index";
import { log } from "@minsky/shared/logger";
import type { CognitionProvider } from "../cognition/types";
import { extractTurns } from "./turn-extractor";
import type { RawTurnLine } from "./transcript-source";
import { TitleGenerator } from "./title-generator";

/**
 * Rows titled per tick. Bounds both wall-clock and API spend for one run.
 * Sized so the ~2k-row backlog drains over a few hours at the sweeper's
 * cadence rather than in one burst of completion calls.
 */
export const DEFAULT_TITLE_BATCH_SIZE = 25;

export interface TitlePipelineRunResult {
  /** Rows selected as candidates this run (bounded by `batchSize`). */
  candidates: number;
  /** Rows for which a title was generated and written. */
  titled: number;
  /** Rows skipped — empty transcript, no extractable turns, or no identifiable subject. */
  skipped: number;
  /** Rows that errored (provider or write failure). Left NULL for a later retry. */
  errored: number;
}

export interface TitlePipelineOptions {
  /** Re-title rows that already have a title. Default: false. */
  force?: boolean;
  /** Rows per run. Default: {@link DEFAULT_TITLE_BATCH_SIZE}. */
  batchSize?: number;
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

  async run(): Promise<TitlePipelineRunResult> {
    const result: TitlePipelineRunResult = { candidates: 0, titled: 0, skipped: 0, errored: 0 };
    const batchSize = this.options.batchSize ?? DEFAULT_TITLE_BATCH_SIZE;

    let rows: Array<{ agentSessionId: string; transcript: unknown }>;
    try {
      rows = await this.db
        .select({
          agentSessionId: agentTranscriptsTable.agentSessionId,
          transcript: agentTranscriptsTable.transcript,
        })
        .from(agentTranscriptsTable)
        .where(
          and(
            // A transcript with no content can never yield a title; excluding
            // it in SQL keeps those rows from consuming the batch budget on
            // every single tick, forever.
            isNotNull(agentTranscriptsTable.transcript),
            this.options.force ? undefined : isNull(agentTranscriptsTable.title)
          )
        )
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
        const wrote = await this.titleRow(row.agentSessionId, row.transcript);
        if (wrote) result.titled++;
        else result.skipped++;
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

  /** Generate and persist a title for one transcript. Returns false when skipped. */
  private async titleRow(agentSessionId: string, transcript: unknown): Promise<boolean> {
    if (!Array.isArray(transcript) || transcript.length === 0) return false;

    const turns = extractTurns(transcript as RawTurnLine[]);
    if (turns.length === 0) return false;

    const title = await this.generator.generateTitle(agentSessionId, turns);
    if (!title) return false;

    await this.db
      .update(agentTranscriptsTable)
      .set({ title })
      .where(sql`${agentTranscriptsTable.agentSessionId} = ${agentSessionId}`);

    return true;
  }
}
