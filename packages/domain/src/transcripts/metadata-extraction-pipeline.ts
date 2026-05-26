/**
 * MetadataExtractionPipeline
 *
 * Post-ingest pass orchestrator that reads agent_transcripts rows and
 * UPDATEs the related_task_ids and related_pr_numbers columns by running
 * the metadata extractor over each transcript's JSONB content.
 *
 * Architectural choice: post-pass over existing agent_transcripts rows
 * rather than modifying agent-transcript-ingest-service.ts. This keeps
 * concerns separated and allows idempotent re-runs. Matches the
 * "single post-pass pattern" of mt#1329 spec.
 *
 * Idempotent: re-running over rows with existing extracted metadata
 * produces the same result (UPDATE always writes; content is deterministic).
 *
 * @see mt#1329 — this file
 * @see mt#1313 — Transcript search: harness-agnostic ingestion
 * @see metadata-extractor.ts — pure extraction logic
 */

import { eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import { agentTranscriptsTable } from "../storage/schemas/agent-transcripts-schema";
import { log } from "@minsky/shared/logger";
import { getErrorMessage } from "../errors/index";
import { extractMetadataFromJsonb } from "./metadata-extractor";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ExtractionPipelineResult {
  /** Total rows scanned from agent_transcripts. */
  rowsScanned: number;
  /** Rows where metadata was successfully extracted and written. */
  rowsUpdated: number;
  /** Rows where extraction or update failed (logged and skipped). */
  rowsErrored: number;
  /** Rows with empty transcript (skipped, columns left as-is). */
  rowsSkipped: number;
}

// ── Pipeline ──────────────────────────────────────────────────────────────────

export class MetadataExtractionPipeline {
  constructor(private readonly db: PostgresJsDatabase) {}

  /**
   * Run the full extraction sweep over all agent_transcripts rows.
   *
   * For each row:
   *   1. Load the JSONB transcript column and related_task_ids/related_pr_numbers.
   *   2. Run extractMetadataFromJsonb over the transcript JSONB.
   *   3. UPDATE the row's related_task_ids and related_pr_numbers columns.
   *
   * Always UPDATEs (does not skip rows with existing metadata), ensuring
   * idempotent re-runs produce consistent results.
   *
   * Failures on individual rows are logged and skipped so the sweep continues.
   */
  async run(): Promise<ExtractionPipelineResult> {
    const result: ExtractionPipelineResult = {
      rowsScanned: 0,
      rowsUpdated: 0,
      rowsErrored: 0,
      rowsSkipped: 0,
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
      log.error("MetadataExtractionPipeline: failed to load transcripts", {
        error: getErrorMessage(err),
      });
      return result;
    }

    result.rowsScanned = rows.length;

    // ── 2. Process each row ──────────────────────────────────────────────────
    for (const row of rows) {
      const { agentSessionId, transcript } = row;

      // Skip rows with no transcript content.
      if (!Array.isArray(transcript) || transcript.length === 0) {
        log.debug(
          `MetadataExtractionPipeline: skipping row with no transcript for ${agentSessionId}`
        );
        result.rowsSkipped++;
        continue;
      }

      try {
        const metadata = extractMetadataFromJsonb(transcript);

        // Convert pr_numbers to string[] for the text[] column.
        const prNumbersAsStrings = metadata.pr_numbers.map(String);

        await this.db
          .update(agentTranscriptsTable)
          .set({
            relatedTaskIds: metadata.task_ids,
            relatedPrNumbers: prNumbersAsStrings,
          })
          .where(eq(agentTranscriptsTable.agentSessionId, agentSessionId));

        result.rowsUpdated++;

        log.debug(`MetadataExtractionPipeline: extracted metadata for ${agentSessionId}`, {
          taskIds: metadata.task_ids,
          prNumbers: metadata.pr_numbers,
        });
      } catch (err) {
        result.rowsErrored++;
        log.warn(`MetadataExtractionPipeline: failed to process row ${agentSessionId}`, {
          error: getErrorMessage(err),
        });
      }
    }

    // ── 3. Summary log ───────────────────────────────────────────────────────
    log.info("MetadataExtractionPipeline: run complete", {
      rowsScanned: result.rowsScanned,
      rowsUpdated: result.rowsUpdated,
      rowsSkipped: result.rowsSkipped,
      rowsErrored: result.rowsErrored,
    });

    return result;
  }
}
