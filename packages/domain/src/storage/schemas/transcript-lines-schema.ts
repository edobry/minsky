import { index, integer, jsonb, pgTable, primaryKey, text } from "drizzle-orm/pg-core";

import { agentTranscriptsTable } from "./agent-transcripts-schema";

/**
 * `transcript_lines` — the insert-only landing zone for RAW transcript lines
 * (ADR-045, mt#4573).
 *
 * ## What this holds that nothing else does
 *
 * Every other transcript table stores a FILTERED or DERIVED view:
 *
 * - `agent_transcripts.transcript` — whole raw lines, but only for the five
 *   types `RETAINED_TYPES` admits (`claude-code-transcript-source.ts`).
 * - `agent_transcript_attachments.content` — whole raw lines, but only for
 *   `attachment` / `system`.
 * - `agent_transcript_turns` — a normalized projection (userText /
 *   assistantText / toolCalls), which drops `toolUseResult` and flattens the
 *   `parentUuid` DAG to a linear `turn_index`.
 *
 * This table holds **every line, verbatim, in file order**, with no type
 * allow-list. It is the only store from which a `.jsonl` can be reconstructed
 * well enough for `claude --resume` to continue the conversation.
 *
 * ## Why a new table rather than widening `RETAINED_TYPES`
 *
 * Measured 2026-08-25 across five real transcripts: every type stored today
 * carries a `timestamp`, and every dropped type (`bridge-session`, `mode`,
 * `custom-title`, `permission-mode`, `ai-title`, `agent-name`,
 * `file-history-snapshot`) carries none. That correspondence is causal, not
 * coincidental — incremental ingest gates on a TIMESTAMP high-water-mark
 * (`agent_transcripts.last_ingested_jsonl_timestamp`), so `RETAINED_TYPES` is
 * in effect the set that mechanism can order at all.
 *
 * Widening it in place fails twice over. The un-timestamped types have no
 * ordering key, so the HWM cannot place them; and `lineIndex` — half of
 * `agent_transcript_attachments`' primary key — counts retained lines, so
 * admitting new types renumbers every already-ingested session and makes a
 * re-ingest write rows at shifted keys (`ON CONFLICT DO NOTHING` would then
 * keep the stale row).
 *
 * `line_ordinal` sidesteps both: it is POSITION IN FILE, which every line has,
 * and it is this table's own key rather than one shared with an existing table.
 *
 * ## Idempotency
 *
 * The JSONL is append-only, so `(agent_session_id, line_ordinal)` is stable
 * across re-ingest and PK collisions are the natural idempotency mechanism —
 * the same property `agent_transcript_attachments` relies on. Capture reads the
 * current `MAX(line_ordinal)` for the session and inserts only beyond it;
 * `ON CONFLICT DO NOTHING` is the backstop for a concurrent writer.
 *
 * Note this high-water is ORDINAL-based and therefore independent of the
 * timestamp HWM the rest of ingest uses. That is deliberate: a sweep that finds
 * "no new timestamped lines" may still have new un-timestamped ones to capture.
 *
 * ## What is still lossy, deliberately
 *
 * Verbatim means "as parsed", not "as bytes". Two transforms are applied before
 * storage, both of them wanted:
 *
 * 1. **Credential scrubbing** (`scrubValueDeep`, mt#2763).
 * 2. **U+0000 sanitization** (`sanitizeForPostgresDeep`, mt#3278) — Postgres
 *    cannot represent a NUL in any text-derived column, `jsonb` included, and
 *    the poison arrives as a JSON escape that `JSON.parse` decodes into a real
 *    U+0000. Without this a single such line fails the insert identically on
 *    every retry, freezing the session forever (mem#750).
 *
 * A reconstruction is therefore faithful modulo these two, and any
 * fidelity check must account for them rather than expecting byte equality.
 *
 * @see docs/architecture/adr-045-transcript-lines-live-landing-zone-object-storage-cold-tier.md
 * @see mt#4573 — this table; the rehydration consumer
 * @see mem#773 — the measured storage cost of exactly this shape (1.714x
 *      expansion over the blob; ~+1 GB projected corpus-wide)
 */
export const transcriptLinesTable = pgTable(
  "transcript_lines",
  {
    agentSessionId: text("agent_session_id")
      .notNull()
      .references(() => agentTranscriptsTable.agentSessionId),

    /**
     * Zero-indexed position of this line in the source JSONL, counting EVERY
     * line the file contains — including types no other table stores, and
     * including sidecar types. This is what makes the count independent of
     * `agent_transcript_attachments.line_index`, which counts only retained
     * non-sidecar lines and must not shift.
     */
    lineOrdinal: integer("line_ordinal").notNull(),

    /**
     * The complete parsed JSONL line, unfiltered — `uuid`, `parentUuid`,
     * `message`, `toolUseResult`, `cwd`, `version`, and every other field the
     * harness emitted, subject only to the two transforms named in the module
     * docblock.
     */
    line: jsonb("line").notNull(),

    /**
     * The line's `type` field, lifted out for queryability so a reader can
     * count or filter by type without deserializing every line. Empty string
     * when the line carried no string `type` — stored rather than NULL so the
     * column can be indexed without a partial-index carve-out.
     */
    lineType: text("line_type").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.agentSessionId, table.lineOrdinal] }),
    index("idx_transcript_lines_type").on(table.agentSessionId, table.lineType),
  ]
);

export type TranscriptLineRecord = typeof transcriptLinesTable.$inferSelect;
export type NewTranscriptLineRecord = typeof transcriptLinesTable.$inferInsert;
