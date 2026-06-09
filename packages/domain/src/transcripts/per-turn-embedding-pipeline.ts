/**
 * PerTurnEmbeddingPipeline — the embedding (vector-only) backfill (ADR-019).
 *
 * Fills the `embedding` column on `agent_transcript_turns` rows that already
 * exist (written by the capture/extraction path — see turn-writer.ts). It does
 * NOT extract turns from `agent_transcripts.transcript`; extraction rides with
 * capture so a session is FTS-searchable with no embedding API. This pipeline is
 * the one expensive, provider-dependent stage, run off the capture critical path.
 *
 * Selection: turns where `embedding IS NULL` and there is text to embed.
 * Write: UPDATE the `embedding` column only — never re-derives text columns, so
 * it cannot duplicate rows or clobber `user_text` / `assistant_text` / `fts_text`.
 *
 * Idempotent: a turn whose embedding is already filled is not re-selected, so
 * re-running is a cheap no-op for embedded turns.
 *
 * @see docs/architecture/adr-019-transcript-pipeline-staging.md
 * @see ./turn-writer.ts — the extraction half (writes the rows this fills)
 * @see mt#1352 — original combined pipeline; mt#2381 — split to vector-only
 */

import { and, eq, isNull, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import { agentTranscriptTurnsTable } from "../storage/schemas/agent-transcript-turns-schema";
import { log } from "@minsky/shared/logger";
import { getErrorMessage } from "../errors/index";
import type { EmbeddingService } from "../ai/embeddings/types";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PipelineRunResult {
  /** Candidate turns selected for embedding (embedding IS NULL AND has text). */
  turnsScanned: number;
  /** Turns whose embedding was successfully generated and written. */
  turnsEmbedded: number;
  /** Turns whose embed or update failed (left with NULL embedding for retry). */
  turnsErrored: number;
  /** Total embedding API calls made (1 per turn with non-empty text). */
  embeddingCallsMade: number;
}

export interface PerTurnEmbeddingPipelineOptions {
  /**
   * Maximum number of turns to embed per batch (API call).
   * Default: 20. Reduces latency jitter on large transcripts.
   */
  batchSize?: number;
}

/** Per-run options for {@link PerTurnEmbeddingPipeline.run}. */
export interface PerTurnEmbeddingRunOptions {
  /** Restrict the backfill to a single agent session. Default: all sessions. */
  agentSessionId?: string;
}

// ── Pipeline ──────────────────────────────────────────────────────────────────

export class PerTurnEmbeddingPipeline {
  private readonly batchSize: number;

  constructor(
    private readonly db: PostgresJsDatabase,
    private readonly embeddingService: EmbeddingService,
    options: PerTurnEmbeddingPipelineOptions = {}
  ) {
    this.batchSize = options.batchSize ?? 20;
  }

  /**
   * Backfill embeddings for turn rows whose `embedding` is NULL.
   *
   *   1. Select candidate turn rows (embedding IS NULL, non-empty text),
   *      optionally scoped to one session.
   *   2. Batch-generate embeddings for their text.
   *   3. UPDATE only the `embedding` column on each row.
   *
   * Extraction (writing the rows) is NOT done here — it happens on the capture
   * path (turn-writer.ts). This pipeline relies on those rows existing.
   */
  async run(opts: PerTurnEmbeddingRunOptions = {}): Promise<PipelineRunResult> {
    const result: PipelineRunResult = {
      turnsScanned: 0,
      turnsEmbedded: 0,
      turnsErrored: 0,
      embeddingCallsMade: 0,
    };

    // ── 1. Select candidate turn rows (NULL embedding, has text) ─────────────
    let rows: Array<{
      agentSessionId: string;
      turnIndex: number;
      userText: string | null;
      assistantText: string | null;
    }>;
    try {
      const conditions = [
        isNull(agentTranscriptTurnsTable.embedding),
        sql`(${agentTranscriptTurnsTable.userText} IS NOT NULL OR ${agentTranscriptTurnsTable.assistantText} IS NOT NULL)`,
      ];
      if (opts.agentSessionId) {
        conditions.push(eq(agentTranscriptTurnsTable.agentSessionId, opts.agentSessionId));
      }
      rows = await this.db
        .select({
          agentSessionId: agentTranscriptTurnsTable.agentSessionId,
          turnIndex: agentTranscriptTurnsTable.turnIndex,
          userText: agentTranscriptTurnsTable.userText,
          assistantText: agentTranscriptTurnsTable.assistantText,
        })
        .from(agentTranscriptTurnsTable)
        .where(and(...conditions));
    } catch (err) {
      log.error("PerTurnEmbeddingPipeline: failed to load candidate turns", {
        error: getErrorMessage(err),
      });
      return result;
    }

    // Build the embed-text for each candidate; drop any that reduce to empty.
    const candidates = rows
      .map((r) => ({
        agentSessionId: r.agentSessionId,
        turnIndex: r.turnIndex,
        text: buildEmbedText(r.userText, r.assistantText),
      }))
      .filter((c) => c.text.trim().length > 0);

    result.turnsScanned = candidates.length;

    // ── 2. Batch embed + 3. UPDATE the embedding column ──────────────────────
    for (let i = 0; i < candidates.length; i += this.batchSize) {
      const batch = candidates.slice(i, i + this.batchSize);

      let embeddings: (number[] | null)[];
      try {
        embeddings = await this.embeddingService.generateEmbeddings(batch.map((c) => c.text));
        result.embeddingCallsMade += batch.length;
      } catch (err) {
        result.turnsErrored += batch.length;
        log.warn(
          `PerTurnEmbeddingPipeline: embedding batch failed (turns ${i}-${i + batch.length - 1})`,
          { error: getErrorMessage(err) }
        );
        continue;
      }

      for (let j = 0; j < batch.length; j++) {
        const c = batch[j];
        const vec = embeddings[j] ?? null;
        if (!c || !vec) {
          if (c) result.turnsErrored++;
          continue;
        }
        try {
          await this.db
            .update(agentTranscriptTurnsTable)
            .set({ embedding: vec })
            .where(
              and(
                eq(agentTranscriptTurnsTable.agentSessionId, c.agentSessionId),
                eq(agentTranscriptTurnsTable.turnIndex, c.turnIndex)
              )
            );
          result.turnsEmbedded++;
        } catch (err) {
          result.turnsErrored++;
          log.warn(
            `PerTurnEmbeddingPipeline: failed to update embedding ${c.agentSessionId}[${c.turnIndex}]`,
            { error: getErrorMessage(err) }
          );
        }
      }
    }

    // ── 4. Cost-summary log line ─────────────────────────────────────────────
    log.info("PerTurnEmbeddingPipeline: run complete", { ...result });

    return result;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Build the text input for embedding generation from a turn's user and assistant
 * text. Concatenates non-null parts separated by a double newline.
 */
function buildEmbedText(userText: string | null, assistantText: string | null): string {
  const parts: string[] = [];
  if (userText) parts.push(userText);
  if (assistantText) parts.push(assistantText);
  return parts.join("\n\n");
}
