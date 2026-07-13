/**
 * SummaryPipeline
 *
 * Orchestrates session-level summary generation and summary embedding for
 * agent_transcripts rows. For each transcript:
 *
 *   1. Extract turns via `extractTurns` (pure, from turn-extractor.ts).
 *   2. Generate summary text via `SummaryGenerator` (CognitionProvider.perform()).
 *   3. Embed the summary text via `EmbeddingService.generateEmbedding()`.
 *   4. Write `summary` and `summary_embedding` back to the `agent_transcripts` row.
 *
 * Idempotent: rows where `summary` is already non-null are skipped by default.
 * Pass `force: true` to re-generate even for already-summarized rows.
 *
 * Scoped to a single session via `runForSession()` or all sessions via `run()`.
 *
 * @see mt#1353 — this file
 * @see mt#1313 §Cognition scope
 * @see summary-generator.ts — CognitionProvider-based summary generation
 * @see per-turn-embedding-pipeline.ts — per-turn extraction (mt#1352)
 */

import { eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import { agentTranscriptsTable } from "../storage/schemas/agent-transcripts-schema";
import { log } from "@minsky/shared/logger";
import { getErrorMessage } from "../errors/index";
import type { EmbeddingService } from "../ai/embeddings/types";
import { extractTurns } from "./turn-extractor";
import type { AgentSessionId, RawTurnLine } from "./transcript-source";
import { SummaryGenerator } from "./summary-generator";
import type { CognitionProvider } from "../cognition/types";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SummaryPipelineRunResult {
  /** Total transcript rows scanned. */
  transcriptsScanned: number;
  /** Transcripts skipped because summary already exists (and force=false). */
  transcriptsSkipped: number;
  /** Transcripts for which a new summary was generated and written. */
  transcriptsProcessed: number;
  /** Transcripts that encountered an error and were skipped. */
  transcriptsErrored: number;
  /** Total embedding API calls made (1 per processed transcript). */
  embeddingCallsMade: number;
}

export interface SummaryPipelineOptions {
  /**
   * When true, re-generate summaries even for rows that already have a
   * non-null `summary`. Default: false (idempotent skip).
   */
  force?: boolean;
}

// ── Pipeline ──────────────────────────────────────────────────────────────────

export class SummaryPipeline {
  private readonly generator: SummaryGenerator;

  constructor(
    private readonly db: PostgresJsDatabase,
    private readonly cognitionProvider: CognitionProvider,
    private readonly embeddingService: EmbeddingService,
    private readonly options: SummaryPipelineOptions = {}
  ) {
    this.generator = new SummaryGenerator(cognitionProvider);
  }

  /**
   * Run the summary pipeline for all rows in `agent_transcripts`.
   */
  async run(): Promise<SummaryPipelineRunResult> {
    const result: SummaryPipelineRunResult = {
      transcriptsScanned: 0,
      transcriptsSkipped: 0,
      transcriptsProcessed: 0,
      transcriptsErrored: 0,
      embeddingCallsMade: 0,
    };

    let rows: Array<{
      agentSessionId: AgentSessionId;
      transcript: unknown;
      summary: string | null;
    }>;
    try {
      rows = await this.db
        .select({
          agentSessionId: agentTranscriptsTable.agentSessionId,
          transcript: agentTranscriptsTable.transcript,
          summary: agentTranscriptsTable.summary,
        })
        .from(agentTranscriptsTable);
    } catch (err) {
      log.error("SummaryPipeline: failed to load transcripts", {
        error: getErrorMessage(err),
      });
      return result;
    }

    result.transcriptsScanned = rows.length;

    for (const row of rows) {
      const { agentSessionId, transcript, summary } = row;

      // Skip rows with existing summaries unless force=true.
      if (summary && !this.options.force) {
        result.transcriptsSkipped++;
        continue;
      }

      try {
        const processed = await this.processTranscript(agentSessionId, transcript, result);
        if (processed) {
          result.transcriptsProcessed++;
        } else {
          result.transcriptsSkipped++;
        }
      } catch (err) {
        result.transcriptsErrored++;
        log.warn(`SummaryPipeline: failed to process transcript ${agentSessionId}`, {
          error: getErrorMessage(err),
        });
      }
    }

    log.info("SummaryPipeline: run complete", {
      transcriptsScanned: result.transcriptsScanned,
      transcriptsSkipped: result.transcriptsSkipped,
      transcriptsProcessed: result.transcriptsProcessed,
      transcriptsErrored: result.transcriptsErrored,
      embeddingCallsMade: result.embeddingCallsMade,
    });

    return result;
  }

  /**
   * Run the summary pipeline for a single session by agentSessionId.
   *
   * @returns true if the summary was generated and written; false if skipped.
   */
  async runForSession(agentSessionId: AgentSessionId): Promise<boolean> {
    let rows: Array<{
      agentSessionId: AgentSessionId;
      transcript: unknown;
      summary: string | null;
    }>;
    try {
      rows = await this.db
        .select({
          agentSessionId: agentTranscriptsTable.agentSessionId,
          transcript: agentTranscriptsTable.transcript,
          summary: agentTranscriptsTable.summary,
        })
        .from(agentTranscriptsTable)
        .where(eq(agentTranscriptsTable.agentSessionId, agentSessionId));
    } catch (err) {
      throw new Error(
        `SummaryPipeline: failed to load transcript for session ${agentSessionId}: ${getErrorMessage(err)}`,
        { cause: err }
      );
    }

    if (rows.length === 0) {
      throw new Error(
        `SummaryPipeline: no transcript row found for session ${agentSessionId}. ` +
          "Run transcripts.ingest first."
      );
    }

    const row = rows[0];
    if (!row) {
      throw new Error(`SummaryPipeline: unexpected null row for session ${agentSessionId}`);
    }

    // Skip if already summarized and force=false.
    if (row.summary && !this.options.force) {
      log.debug(`SummaryPipeline: skipping ${agentSessionId} (already summarized)`);
      return false;
    }

    const fakeResult: SummaryPipelineRunResult = {
      transcriptsScanned: 1,
      transcriptsSkipped: 0,
      transcriptsProcessed: 0,
      transcriptsErrored: 0,
      embeddingCallsMade: 0,
    };

    const processed = await this.processTranscript(agentSessionId, row.transcript, fakeResult);
    return processed;
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  /**
   * Generate and write summary + summary_embedding for one transcript row.
   *
   * @returns true if summary was generated and written; false if skipped (empty transcript).
   */
  private async processTranscript(
    agentSessionId: AgentSessionId,
    transcript: unknown,
    result: SummaryPipelineRunResult
  ): Promise<boolean> {
    // Guard: transcript must be an array of raw turn lines.
    if (!Array.isArray(transcript) || transcript.length === 0) {
      log.debug(`SummaryPipeline: skipping empty/null transcript for ${agentSessionId}`);
      return false;
    }

    const rawLines = transcript as RawTurnLine[];
    const turns = extractTurns(rawLines);

    if (turns.length === 0) {
      log.debug(`SummaryPipeline: no turns extracted from ${agentSessionId}`);
      return false;
    }

    // Generate summary text via CognitionProvider.
    const summaryText = await this.generator.generateSummary(agentSessionId, turns);

    if (!summaryText) {
      log.debug(`SummaryPipeline: generator returned null for ${agentSessionId}`);
      return false;
    }

    // Generate summary embedding.
    let summaryEmbedding: number[] | null = null;
    try {
      summaryEmbedding = await this.embeddingService.generateEmbedding(summaryText);
      result.embeddingCallsMade++;
    } catch (err) {
      log.warn(`SummaryPipeline: embedding failed for ${agentSessionId}`, {
        error: getErrorMessage(err),
      });
      // Still write the summary text even if embedding fails.
    }

    // Write summary and summary_embedding back to agent_transcripts.
    await this.db
      .update(agentTranscriptsTable)
      .set({
        summary: summaryText,
        summaryEmbedding: summaryEmbedding ?? undefined,
      })
      .where(eq(agentTranscriptsTable.agentSessionId, agentSessionId));

    log.debug(`SummaryPipeline: wrote summary for ${agentSessionId}`, {
      summaryLength: summaryText.length,
      hasEmbedding: summaryEmbedding !== null,
    });

    return true;
  }
}
