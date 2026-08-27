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
import { getLoggableErrorSummary } from "../errors/index";
import type { EmbeddingService } from "../ai/embeddings/types";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PipelineRunResult {
  /** Candidate turns selected for embedding (embedding IS NULL AND has text). */
  turnsScanned: number;
  /** Turns whose embedding was successfully generated and written. */
  turnsEmbedded: number;
  /** Turns whose embed or update failed (left with NULL embedding for retry). */
  turnsErrored: number;
  /** Embedding API calls made — one `generateEmbeddings` invocation per batch. */
  embeddingCallsMade: number;
}

export interface PerTurnEmbeddingPipelineOptions {
  /**
   * Maximum number of turns to embed per batch (API call).
   * Default: 20. Reduces latency jitter on large transcripts.
   */
  batchSize?: number;

  /**
   * Maximum candidate turns loaded per run. Default:
   * {@link DEFAULT_MAX_CANDIDATES_PER_RUN}.
   */
  maxCandidatesPerRun?: number;
}

/**
 * Upper bound on candidate turns loaded per run (mt#4212).
 *
 * The candidate SELECT was unbounded, so it loaded EVERY unembedded turn's full
 * `user_text` + `assistant_text` in one query. On 2026-08-17 that was 208,715
 * rows / ~159 MB, and the query stopped completing at all — the pooler dropped
 * the connection (`write CONNECTION_ENDED`) and every run failed at the load
 * step before embedding anything. Backfill throughput went to zero precisely
 * because the backlog was large, which is the wrong way round.
 *
 * 2,000 is derived from the work a run should do, not chosen as a round number:
 * at `batchSize` 20 it is 100 provider calls. The BOUND is still right; the
 * duration this docblock derived from it was not.
 *
 * **CORRECTED 2026-08-26 (mt#4601): a full run is ~13 MINUTES, not ~45 seconds.**
 * This paragraph read *"the slowest batch latency measured against the live
 * endpoint is 449ms (`request-resilience.ts`), so a full run is ~45s of provider
 * time. The sweeper's cadence is minutes, so a run finishes well inside its
 * interval."* The 449 ms is real and is scoped: `request-resilience.ts:23`
 * records it for a *"batch of 20 (~2KB each)"*. Real transcript turns are far
 * larger, and one batch of 20 measured against the live pipeline took
 * **8,054 ms** — ~18x. So 100 batches is ~13 minutes, and "finishes well inside
 * its interval" was false for any cadence under that.
 *
 * This mattered: mt#4601 sized a new sweep's tick timeout at 5 minutes from the
 * ~45s figure, which would have abandoned every full run in production. Caught by
 * running the pipeline against the live database rather than by review. **Re-measure
 * before deriving a duration from this constant** — the number of calls is fixed,
 * the time per call is a property of the payloads, and those grow.
 *
 * Each run still shrinks the candidate set, so a backlog drains across runs
 * rather than being attempted all at once.
 */
export const DEFAULT_MAX_CANDIDATES_PER_RUN = 2_000;

/** Per-run options for {@link PerTurnEmbeddingPipeline.run}. */
export interface PerTurnEmbeddingRunOptions {
  /** Restrict the backfill to a single agent session. Default: all sessions. */
  agentSessionId?: string;
}

// ── Pipeline ──────────────────────────────────────────────────────────────────

export class PerTurnEmbeddingPipeline {
  private readonly batchSize: number;
  private readonly maxCandidatesPerRun: number;

  constructor(
    private readonly db: PostgresJsDatabase,
    private readonly embeddingService: EmbeddingService,
    options: PerTurnEmbeddingPipelineOptions = {}
  ) {
    this.batchSize = options.batchSize ?? 20;
    this.maxCandidatesPerRun = options.maxCandidatesPerRun ?? DEFAULT_MAX_CANDIDATES_PER_RUN;
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
        .where(and(...conditions))
        // ORDERED, and the order is what makes the index usable (mt#4623).
        //
        // This was deliberately UNORDERED until mt#4623, on reasoning that was
        // correct at the time: with no index on the predicate, an ORDER BY
        // forces a sort over the whole filtered set before the limit applies.
        // `idx_agent_transcript_turns_embedding_backlog` inverts that — it is a
        // partial index on exactly this predicate, keyed on exactly these two
        // columns, so it SUPPLIES the order and no sort node is planned at all.
        //
        // The ordering is not cosmetic; without it the index is not used.
        // Measured on a 367,159-row / 313 MB reproduction of production:
        //
        //   no ORDER BY   Seq Scan, 40,123 buffers, 63.0 ms  (index ignored)
        //   ORDER BY      Index Scan, 17 buffers,   0.059 ms
        //
        // The planner ignores the index without the ordering because it
        // estimates 141,913 matching rows against an actual 62: it assumes
        // `embedding IS NULL` and the text predicate are independent when they
        // are strongly anti-correlated (almost every NULL embedding belongs to
        // a text-less row, which can never be a candidate). Its arithmetic is
        // 0.5757 × (1 − 0.5755²) × 367,159 ≈ 141,380. Believing that many
        // matches exist, it expects LIMIT to be satisfied ~1.4% into a
        // sequential scan — so it takes the scan, and then reads the whole
        // table because only 62 rows actually match.
        //
        // The mt#4212 bound below is unaffected and still does its job.
        // Determinism is now a by-product rather than a cost: progress never
        // depended on it (every embedded turn leaves the candidate set
        // permanently), but stable ordering makes successive runs reproducible.
        .orderBy(agentTranscriptTurnsTable.agentSessionId, agentTranscriptTurnsTable.turnIndex)
        .limit(this.maxCandidatesPerRun);
    } catch (err) {
      log.error("PerTurnEmbeddingPipeline: failed to load candidate turns", {
        error: getLoggableErrorSummary(err),
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
        // One provider invocation per batch (not per turn).
        result.embeddingCallsMade += 1;
      } catch (err) {
        result.turnsErrored += batch.length;
        log.warn(
          `PerTurnEmbeddingPipeline: embedding batch failed (turns ${i}-${i + batch.length - 1})`,
          { error: getLoggableErrorSummary(err) }
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
            { error: getLoggableErrorSummary(err) }
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
