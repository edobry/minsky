/**
 * PerTurnEmbeddingPipeline
 *
 * Orchestrates per-turn embedding extraction for agent_transcripts rows.
 * For each transcript in agent_transcripts, runs extractTurns on the JSONB,
 * generates vector embeddings for each turn via EmbeddingService, and writes
 * per-turn rows to agent_transcript_turns.
 *
 * Idempotent: rows that already exist are upserted on (agent_session_id, turn_index)
 * so re-running over an already-extracted transcript is a no-op for existing turns.
 *
 * Emits a single cost-summary log line at end of each run.
 *
 * @see mt#1313 §Per-turn extraction
 * @see mt#1352 — this file
 * @see turn-extractor.ts — pure extraction logic
 * @see agent-transcript-turns-schema.ts — destination table schema
 */

import { sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import { agentTranscriptsTable } from "../storage/schemas/agent-transcripts-schema";
import { agentTranscriptTurnsTable } from "../storage/schemas/agent-transcript-turns-schema";
import { log } from "@minsky/shared/logger";
import { getErrorMessage } from "../errors/index";
import type { EmbeddingService } from "../ai/embeddings/types";
import { extractTurns } from "./turn-extractor";
import type { RawTurnLine } from "./transcript-source";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PipelineRunResult {
  /** Total transcripts scanned from agent_transcripts. */
  transcriptsScanned: number;
  /** Transcripts skipped because they were already fully extracted. */
  transcriptsSkipped: number;
  /** Transcripts from which at least one turn row was written. */
  transcriptsProcessed: number;
  /** Total individual turn rows written (across all processed transcripts). */
  turnsWritten: number;
  /** Number of transcripts that encountered an error and were skipped. */
  transcriptsErrored: number;
  /** Total embedding API calls made (1 per turn with non-null text). */
  embeddingCallsMade: number;
}

export interface PerTurnEmbeddingPipelineOptions {
  /**
   * Maximum number of turns to embed per batch (API call).
   * Default: 20. Reduces latency jitter on large transcripts.
   */
  batchSize?: number;
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
   * Run the full backfill sweep over all agent_transcripts rows.
   *
   * For each transcript:
   *   1. Load the JSONB transcript column.
   *   2. Run extractTurns to get per-turn rows.
   *   3. Batch-generate embeddings for turns with non-null text.
   *   4. Upsert rows into agent_transcript_turns.
   *
   * Failures on individual transcripts are logged and skipped.
   */
  async run(): Promise<PipelineRunResult> {
    const result: PipelineRunResult = {
      transcriptsScanned: 0,
      transcriptsSkipped: 0,
      transcriptsProcessed: 0,
      turnsWritten: 0,
      transcriptsErrored: 0,
      embeddingCallsMade: 0,
    };

    // ── 1. Load all transcript rows ──────────────────────────────────────────
    let rows: Array<{ agentSessionId: string; transcript: unknown }>;
    try {
      rows = await this.db
        .select({
          agentSessionId: agentTranscriptsTable.agentSessionId,
          transcript: agentTranscriptsTable.transcript,
        })
        .from(agentTranscriptsTable);
    } catch (err) {
      log.error("PerTurnEmbeddingPipeline: failed to load transcripts", {
        error: getErrorMessage(err),
      });
      return result;
    }

    result.transcriptsScanned = rows.length;

    // ── 2. Process each transcript ───────────────────────────────────────────
    for (const row of rows) {
      const { agentSessionId, transcript } = row;

      try {
        const turnsWritten = await this.processTranscript(agentSessionId, transcript, result);
        if (turnsWritten === 0) {
          result.transcriptsSkipped++;
        } else {
          result.transcriptsProcessed++;
          result.turnsWritten += turnsWritten;
        }
      } catch (err) {
        result.transcriptsErrored++;
        log.warn(`PerTurnEmbeddingPipeline: failed to process transcript ${agentSessionId}`, {
          error: getErrorMessage(err),
        });
      }
    }

    // ── 3. Cost-summary log line ─────────────────────────────────────────────
    log.info("PerTurnEmbeddingPipeline: run complete", {
      transcriptsScanned: result.transcriptsScanned,
      transcriptsSkipped: result.transcriptsSkipped,
      transcriptsProcessed: result.transcriptsProcessed,
      turnsWritten: result.turnsWritten,
      transcriptsErrored: result.transcriptsErrored,
      embeddingCallsMade: result.embeddingCallsMade,
    });

    return result;
  }

  /**
   * Extract and embed turns for a single transcript, writing them to agent_transcript_turns.
   *
   * @returns Number of turn rows written (0 if no turns to write).
   */
  private async processTranscript(
    agentSessionId: string,
    transcript: unknown,
    result: PipelineRunResult
  ): Promise<number> {
    // Guard: transcript must be an array of raw turn lines.
    if (!Array.isArray(transcript) || transcript.length === 0) {
      log.debug(`PerTurnEmbeddingPipeline: skipping empty/null transcript for ${agentSessionId}`);
      return 0;
    }

    const rawLines = transcript as RawTurnLine[];
    const turns = extractTurns(rawLines);

    if (turns.length === 0) {
      log.debug(`PerTurnEmbeddingPipeline: no turns extracted from ${agentSessionId}`);
      return 0;
    }

    // ── Build text for embedding ─────────────────────────────────────────────
    // Each turn's embedding input is: "{userText}\n\n{assistantText}" (null parts omitted).
    const embedTexts: string[] = turns.map((t) => buildEmbedText(t.userText, t.assistantText));

    // ── Batch embed ──────────────────────────────────────────────────────────
    const embeddings: (number[] | null)[] = new Array(turns.length).fill(null);

    for (let i = 0; i < embedTexts.length; i += this.batchSize) {
      const batchSlice = embedTexts.slice(i, i + this.batchSize);

      // Build (absoluteIndex, text) pairs for non-empty slots in this batch.
      const nonEmptyPairs: Array<{ idx: number; text: string }> = [];
      for (let k = 0; k < batchSlice.length; k++) {
        const text = batchSlice[k];
        if (text !== undefined && text.trim().length > 0) {
          nonEmptyPairs.push({ idx: i + k, text });
        }
      }

      if (nonEmptyPairs.length === 0) continue;

      try {
        const batchEmbeddings = await this.embeddingService.generateEmbeddings(
          nonEmptyPairs.map((p) => p.text)
        );
        result.embeddingCallsMade += nonEmptyPairs.length;

        for (let j = 0; j < nonEmptyPairs.length; j++) {
          const pair = nonEmptyPairs[j];
          if (pair !== undefined) {
            embeddings[pair.idx] = batchEmbeddings[j] ?? null;
          }
        }
      } catch (err) {
        log.warn(
          `PerTurnEmbeddingPipeline: embedding batch failed for ${agentSessionId} (turns ${i}-${i + batchSlice.length - 1})`,
          { error: getErrorMessage(err) }
        );
        // Embeddings remain null; still write the turn rows (embedding column nullable).
      }
    }

    // ── Upsert turn rows ─────────────────────────────────────────────────────
    let written = 0;
    for (const turn of turns) {
      const embedding = embeddings[turn.turnIndex] ?? null;

      // Build the insert values. Note: fts_text is a GENERATED ALWAYS AS column
      // and must NOT be included in the insert.
      const insertValues = {
        agentSessionId,
        turnIndex: turn.turnIndex,
        userText: turn.userText ?? undefined,
        assistantText: turn.assistantText ?? undefined,
        toolCalls: turn.toolCalls ? JSON.stringify(turn.toolCalls) : undefined,
        startedAt: turn.startedAt ?? undefined,
        endedAt: turn.endedAt ?? undefined,
        embedding: embedding ?? undefined,
        isSpawnBoundary: turn.isSpawnBoundary,
      };

      try {
        await this.db
          .insert(agentTranscriptTurnsTable)
          .values(insertValues)
          .onConflictDoUpdate({
            target: [agentTranscriptTurnsTable.agentSessionId, agentTranscriptTurnsTable.turnIndex],
            set: {
              userText: sql`EXCLUDED.user_text`,
              assistantText: sql`EXCLUDED.assistant_text`,
              toolCalls: sql`EXCLUDED.tool_calls`,
              startedAt: sql`EXCLUDED.started_at`,
              endedAt: sql`EXCLUDED.ended_at`,
              embedding: sql`EXCLUDED.embedding`,
              isSpawnBoundary: sql`EXCLUDED.is_spawn_boundary`,
            },
          });
        written++;
      } catch (err) {
        log.warn(
          `PerTurnEmbeddingPipeline: failed to upsert turn ${agentSessionId}[${turn.turnIndex}]`,
          { error: getErrorMessage(err) }
        );
      }
    }

    return written;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Build the text input for embedding generation from a turn's user and assistant text.
 * Concatenates non-null parts separated by a double newline.
 */
function buildEmbedText(userText: string | null, assistantText: string | null): string {
  const parts: string[] = [];
  if (userText) parts.push(userText);
  if (assistantText) parts.push(assistantText);
  return parts.join("\n\n");
}
