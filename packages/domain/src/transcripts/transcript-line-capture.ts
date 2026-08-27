/**
 * Full-fidelity raw-line capture into `transcript_lines` (ADR-045, mt#4573).
 *
 * The ingest service fans one file read out to three destinations. Two of them
 * — the transcript jsonb and the attachments table — are gated by a TIMESTAMP
 * high-water mark and by a per-source retention filter, and between them they
 * drop roughly a quarter of every transcript. This module owns the third: every
 * parsed line, verbatim, keyed by position in file.
 *
 * Split out of `agent-transcript-ingest-service.ts` rather than added to it
 * because that file sits at the 1500-line ceiling, and because the capture
 * path's idempotency story is genuinely separate from the rest of ingest — it
 * keys on its own ordinal high-water, not on the timestamp watermark. That
 * independence is what lets the caller run capture AFTER the watermark-bearing
 * upsert and treat a failure as retryable rather than fatal.
 *
 * @see packages/domain/src/storage/schemas/transcript-lines-schema.ts
 * @see mt#4573
 */

import { eq, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import { log } from "@minsky/shared/logger";

import {
  transcriptLinesTable,
  type NewTranscriptLineRecord,
} from "../storage/schemas/transcript-lines-schema";
import { getLoggableErrorSummary } from "../errors/index";

/**
 * Rows per `transcript_lines` INSERT. A session's first capture is the whole
 * file, and at four columns per row Postgres's 65535-parameter ceiling is
 * reached around 16k lines — well inside the corpus, whose largest transcripts
 * run to tens of thousands of lines.
 */
const CAPTURE_INSERT_CHUNK_SIZE = 500;

/**
 * Highest `line_ordinal` already captured for this session, or -1 when it has
 * no captured lines yet.
 *
 * Returns `null` when the read itself FAILED, which the caller must treat as
 * "skip capture this pass" rather than as "nothing captured yet". The
 * distinction matters: -1 makes the caller rebuild capture rows for every line
 * in the file, and for a large transcript (the corpus max is ~44 MB) that is a
 * needless memory spike on an error path. The JSONL is append-only and the next
 * sweep re-reads it, so skipping loses nothing permanently.
 */
export async function readCapturedOrdinalHighWater(
  db: PostgresJsDatabase,
  agentSessionId: string
): Promise<number | null> {
  try {
    const rows = await db
      .select({ maxOrdinal: sql<number | null>`max(${transcriptLinesTable.lineOrdinal})` })
      .from(transcriptLinesTable)
      .where(eq(transcriptLinesTable.agentSessionId, agentSessionId));
    const maxOrdinal = rows[0]?.maxOrdinal;
    return typeof maxOrdinal === "number" ? maxOrdinal : -1;
  } catch (err) {
    log.warn(
      `transcript_lines high-water read FAILED for session ${agentSessionId} — skipping full-fidelity capture this pass`,
      { agentSessionId, error: getLoggableErrorSummary(err) }
    );
    return null;
  }
}

/**
 * Insert captured raw lines. Returns the error rather than throwing so the
 * caller decides whether it is fatal — for this path it is not, because the
 * ordinal high-water only advances when rows actually land, so a failed batch
 * is rebuilt identically by the next sweep.
 */
export async function writeCapturedLines(
  db: PostgresJsDatabase,
  rows: NewTranscriptLineRecord[]
): Promise<Error | undefined> {
  if (rows.length === 0) return undefined;
  try {
    for (let i = 0; i < rows.length; i += CAPTURE_INSERT_CHUNK_SIZE) {
      await db
        .insert(transcriptLinesTable)
        .values(rows.slice(i, i + CAPTURE_INSERT_CHUNK_SIZE))
        .onConflictDoNothing();
    }
    return undefined;
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err));
  }
}
