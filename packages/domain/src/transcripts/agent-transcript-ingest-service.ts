/**
 * AgentTranscriptIngestService
 *
 * Orchestration layer that wires a TranscriptSource adapter to the
 * `agent_transcripts` DB table.  Per-session ingest is incremental: only JSONL
 * lines whose timestamp is strictly greater than the stored
 * `last_ingested_jsonl_timestamp` high-water-mark are ingested.  Re-running
 * over an unchanged JSONL is a no-op.
 *
 * @see mt#1313 §Ingestion semantics
 * @see mt#1351 — this file
 * @see mt#1350 — TranscriptSource interface + ClaudeCodeTranscriptSource
 * @see mt#1324 — agent_transcripts schema
 */

import { eq, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import { agentTranscriptsTable } from "../storage/schemas/agent-transcripts-schema";
import { agentTranscriptAttachmentsTable } from "../storage/schemas/agent-transcript-attachments-schema";
import { log } from "@minsky/shared/logger";
import { getErrorMessage } from "../errors/index";
import type { DiscoveredSession, RawTurnLine, TranscriptSource } from "./transcript-source";
import { type AttachmentRow, buildAttachmentRow } from "./attachment-row-builder";
import { writeTurnsForTranscript } from "./turn-writer";
import { writeCwdMatchLink } from "./session-link-writer";

export class AgentTranscriptIngestService {
  constructor(
    private readonly db: PostgresJsDatabase,
    private readonly source: TranscriptSource
  ) {}

  /**
   * Ingest a single session identified by its agent session ID.
   *
   * Returns a typed result so the caller can distinguish success from a caught
   * failure. Three paths — HWM read, stream, upsert — ABORT immediately on
   * failure (mt#2789: HWM-read failure moved from "swallow and proceed" to
   * "abort" so it can no longer append a whole-file re-collect onto a stored
   * transcript, see the comment at the HWM read site). Two further paths —
   * turn-row materialization, attachment insert — are best-effort: they log
   * and continue, surfacing their error on an otherwise-successful return.
   * Either way, a non-undefined `error` means `ingestAll` counts the session
   * in `sessionsErrored` honestly (mt#1444).
   *
   * @param session - The discovered session metadata (from discoverSessions() or a direct lookup).
   * @returns `{ ingested: number; error?: Error }` — `ingested` is the number of new
   *   lines written (0 on idempotent re-run or on an abort path); `error` is set
   *   when any of the five internal paths above hit a failure.
   */
  async ingestSession(session: DiscoveredSession): Promise<IngestSessionResult> {
    const { agentSessionId, harness, jsonlPath, mtime } = session;

    // ── 1. Read the current high-water-mark ──────────────────────────────────
    let highWaterMark: Date | null = null;
    try {
      const rows = await this.db
        .select({
          lastIngestedJsonlTimestamp: agentTranscriptsTable.lastIngestedJsonlTimestamp,
        })
        .from(agentTranscriptsTable)
        .where(eq(agentTranscriptsTable.agentSessionId, agentSessionId))
        .limit(1);

      highWaterMark = rows[0]?.lastIngestedJsonlTimestamp ?? null;
    } catch (err) {
      const hwmReadError = err instanceof Error ? err : new Error(String(err));
      log.warn(`Failed to read high-water-mark for session ${agentSessionId}`, {
        error: getErrorMessage(err),
      });
      // mt#2789: abort this session's ingest rather than proceeding with
      // highWaterMark=null. Proceeding used to mean "treat as no prior
      // ingest" — re-collecting and re-appending the ENTIRE transcript onto
      // whatever is already stored. That was one of the two concrete
      // duplication mechanisms found in the mt#2789 diagnosis (the other
      // being the plain concurrent-actor race, which the uuid-dedup UPDATE
      // below now closes). We picked abort over "proceed, uuid-dedup makes
      // it safe" for two reasons even though the dedup WOULD in fact make a
      // full re-collect safe: (a) it avoids the O(whole-transcript) resend
      // and the O(new*existing) dedup-subquery cost on every transient HWM
      // read failure, and (b) it keeps the failure legible — the sweep
      // already counts `result.error` (mt#1444) and will retry this session
      // on the next pass once the read succeeds, so nothing is lost by not
      // pushing through on a degraded read.
      return { ingested: 0, error: hwmReadError };
    }

    // ── 2. Stream new lines ──────────────────────────────────────────────────
    // Source yields all retained types (user/assistant/attachment/system per
    // `RETAINED_TYPES` in claude-code-transcript-source). The ingest routes
    // them to two destinations:
    //   - user/assistant turn content → `agent_transcripts.transcript` jsonb
    //     (backwards-compat for existing turn-extractor / FTS / summary etc.)
    //   - attachment/system side material → `agent_transcript_attachments`
    //     (mt#2022 — new sibling table for context-inspector use case)
    //
    // `lineIndex` increments on every retained line yielded — including those
    // filtered out by the HWM gate — so the counter is stable across re-ingest
    // for an append-only JSONL file. Attachments use it as part of their PK.
    const newLines: RawTurnLine[] = [];
    const newAttachmentRows: AttachmentRow[] = [];
    let latestTs: Date | null = null;
    let lineIndex = -1;

    try {
      for await (const line of this.source.readSession(agentSessionId)) {
        lineIndex++;

        const tsStr = this.source.getJsonlTimestamp(line);
        if (!tsStr) continue;

        const tsDate = new Date(tsStr);
        if (isNaN(tsDate.getTime())) continue;

        // Incremental gate: skip lines already ingested.
        if (highWaterMark !== null && tsDate <= highWaterMark) continue;

        const lineType = typeof line.type === "string" ? line.type : "";
        if (lineType === "user" || lineType === "assistant") {
          newLines.push(line);
        } else if (lineType === "attachment" || lineType === "system") {
          const row = buildAttachmentRow(agentSessionId, lineIndex, line, tsDate);
          if (row !== null) newAttachmentRows.push(row);
        }

        if (latestTs === null || tsDate > latestTs) {
          latestTs = tsDate;
        }
      }
    } catch (err) {
      log.warn(`Failed to stream lines for session ${agentSessionId}`, {
        error: getErrorMessage(err),
      });
      // Return 0 — don't partially-commit a broken read.
      // Surface the error so the sweep can count it (mt#1444).
      return { ingested: 0, error: err instanceof Error ? err : new Error(String(err)) };
    }

    if (newLines.length === 0 && newAttachmentRows.length === 0) {
      log.debug(
        `No new lines for session ${agentSessionId} (high-water-mark: ${highWaterMark?.toISOString() ?? "none"})`
      );
      // Idempotent re-run. (mt#2789: a HWM-read failure aborts above, before
      // this point is reached, so there is no swallowed HWM error to surface
      // here anymore.)
      return { ingested: 0, error: undefined };
    }

    // ── 3. Derive metadata from the source's DiscoveredSession ───────────────
    const startedAt = extractStartedAt(newLines, this.source);
    const endedAt = latestTs ?? mtime;

    // ── 4. Upsert into agent_transcripts ─────────────────────────────────────
    // Single atomic statement: INSERT … ON CONFLICT (agent_session_id) DO UPDATE.
    //
    // mt#2789: the append is now idempotent BY LINE `uuid`, not just
    // timestamp-gated. Diagnosis found the observed subagent-transcript
    // duplication was a concurrent-ingest race: two actors (the cockpit
    // watcher, the MCP boot sweep, the SessionEnd hook — any two of the N
    // processes that can call ingestSession) both read the same
    // high-water-mark, both collect the same "new" batch, and both append.
    // The in-process HWM gate at step 2 is a cheap first-pass filter but
    // can't see a concurrent actor's read; only the DB has the information
    // needed to detect the race, and only at the moment of the write.
    //
    // The fix: filter `EXCLUDED.transcript` down to elements whose `uuid` is
    // NOT already present in the stored `transcript` array, via a correlated
    // subquery over `jsonb_array_elements`, before concatenating. This is
    // race-free WITHOUT an advisory lock because the UPDATE's row lock
    // already serializes concurrent writers to the same `agent_session_id`:
    // under Postgres READ COMMITTED, a blocked `ON CONFLICT DO UPDATE`
    // re-evaluates its SET expressions against the just-committed row once
    // unblocked — so the second writer's uuid check sees the first writer's
    // already-appended lines and correctly filters them out.
    //
    // Lines without a `uuid` are always appended (never treated as
    // duplicates) — Claude Code's retained user/assistant lines always carry
    // one, so this is a defensive default for a case that should not occur
    // in practice, not a silent-drop.
    //
    // `lastIngestedJsonlTimestamp` uses GREATEST(existing, EXCLUDED) rather
    // than a flat overwrite so a racing writer that read an OLDER
    // high-water-mark (and is therefore behind) cannot regress the
    // watermark below a value a faster concurrent writer already advanced
    // it to — regressing it would cause the NEXT ingest to re-collect
    // already-ingested lines (harmless now that the append is uuid-deduped,
    // but wasteful).
    //
    // Fields restricted to insert-only (harness, cwd, project_dir, started_at)
    // are not overwritten on conflict.
    try {
      await this.db
        .insert(agentTranscriptsTable)
        .values({
          agentSessionId,
          harness,
          transcript: newLines,
          startedAt: startedAt ?? undefined,
          endedAt: endedAt ?? undefined,
          // mt#1445: use the session's recovered working directory if the
          // source could provide one; otherwise leave the column NULL rather
          // than substituting the JSONL path. Downstream consumers querying
          // `cwd` expect a working directory, not a transcript path.
          cwd: session.cwd ?? undefined,
          projectDir: deriveProjectDir(jsonlPath),
          lastIngestedJsonlTimestamp: latestTs ?? undefined,
          ingestedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: agentTranscriptsTable.agentSessionId,
          set: {
            transcript: sql`COALESCE(${agentTranscriptsTable.transcript}, '[]'::jsonb) || (
              SELECT COALESCE(jsonb_agg(new_elem ORDER BY ord), '[]'::jsonb)
              FROM jsonb_array_elements(EXCLUDED.transcript) WITH ORDINALITY AS t(new_elem, ord)
              WHERE (new_elem->>'uuid') IS NULL
                OR NOT EXISTS (
                  SELECT 1
                  FROM jsonb_array_elements(COALESCE(${agentTranscriptsTable.transcript}, '[]'::jsonb)) AS existing_elem
                  WHERE existing_elem->>'uuid' = new_elem->>'uuid'
                )
            )`,
            endedAt: sql`EXCLUDED.ended_at`,
            lastIngestedJsonlTimestamp: sql`GREATEST(${agentTranscriptsTable.lastIngestedJsonlTimestamp}, EXCLUDED.last_ingested_jsonl_timestamp)`,
            ingestedAt: sql`EXCLUDED.ingested_at`,
          },
        });
    } catch (err) {
      log.error(`Failed to upsert transcript for session ${agentSessionId}`, {
        error: getErrorMessage(err),
      });
      return { ingested: 0, error: err instanceof Error ? err : new Error(String(err)) };
    }

    // ── 4b. Materialize per-turn rows for FTS (ADR-019, mt#2381) ──────────────
    // Extraction rides with capture: read back the full MERGED transcript (the
    // upsert just concatenated the new lines onto any prior transcript) and
    // upsert text-only turn rows. This makes the session FTS-searchable with no
    // embedding API call — `fts_text` is a GENERATED column populated on the
    // text write. The embedding vector is filled later by the vector-only
    // backfill (PerTurnEmbeddingPipeline); writeTurnsForTranscript never touches
    // the `embedding` column, so an already-embedded turn is not clobbered.
    // Turn ordering is assigned over the WHOLE transcript, so we extract from the
    // full merged row, not from the incremental `newLines` slice.
    let turnExtractError: Error | undefined;
    let persistedCwd: string | null = null;
    try {
      const fullRows = await this.db
        .select({
          transcript: agentTranscriptsTable.transcript,
          cwd: agentTranscriptsTable.cwd,
        })
        .from(agentTranscriptsTable)
        .where(eq(agentTranscriptsTable.agentSessionId, agentSessionId))
        .limit(1);
      const fullTranscript = fullRows[0]?.transcript ?? null;
      persistedCwd = fullRows[0]?.cwd ?? null;
      await writeTurnsForTranscript(this.db, agentSessionId, fullTranscript);
    } catch (err) {
      turnExtractError = err instanceof Error ? err : new Error(String(err));
      log.warn(`Failed to materialize turn rows for session ${agentSessionId}`, {
        error: getErrorMessage(err),
      });
      // Don't fail the whole ingest — the transcript upsert already succeeded.
      // Surface the error so the sweep can count degraded ingests.
    }

    // ── 4c. Write cwd_match link into minsky_session_links (mt#2441) ────────
    // Runs from THIS shared ingest core so every ingest path — transcripts_ingest,
    // the MCP boot sweep, the SessionEnd hook, and the cadence sweep — writes
    // the same link with no per-consumer duplication (all four funnel through
    // ingestSession). No-ops (no DB call) when the resolved cwd doesn't
    // resolve to a session workspace path — the expected common case per the
    // mt#2749 finding (subagents don't chdir), not an error. Never allowed to
    // fail the ingest: writeCwdMatchLink swallows its own DB errors, and this
    // try/catch is a defensive backstop only.
    //
    // Prefer `session.cwd` (the freshest value from THIS discovery) over
    // `persistedCwd` (the stored column, which the upsert above never updates
    // on conflict — `cwd` is insert-only, mt#1445). Without this precedence a
    // session first ingested before its cwd was recoverable, then re-ingested
    // once the source CAN report it, would silently never get a link: the
    // persisted column stays NULL forever while `session.cwd` carries the
    // real value on every subsequent call (PR #1899 R1).
    try {
      await writeCwdMatchLink(this.db, agentSessionId, session.cwd ?? persistedCwd);
    } catch (err) {
      log.warn(`Failed to write cwd_match link for session ${agentSessionId}`, {
        error: getErrorMessage(err),
      });
    }

    // ── 5. Insert new attachment rows (mt#2022) ──────────────────────────────
    // Write to the sibling table for non-turn JSONL lines (attachment/system).
    // PK is `(agent_session_id, line_index)`; `line_index` is stable on an
    // append-only JSONL so ON CONFLICT DO NOTHING is the idempotency mechanism
    // for re-runs (backfill, repeated ingests, HWM regressions).
    let attachmentsWritten = 0;
    let attachmentError: Error | undefined;
    if (newAttachmentRows.length > 0) {
      try {
        await this.db
          .insert(agentTranscriptAttachmentsTable)
          .values(newAttachmentRows)
          .onConflictDoNothing();
        attachmentsWritten = newAttachmentRows.length;
      } catch (err) {
        attachmentError = err instanceof Error ? err : new Error(String(err));
        log.warn(
          `Failed to insert ${newAttachmentRows.length} attachment rows for session ${agentSessionId}`,
          { error: getErrorMessage(err) }
        );
        // Don't fail the whole ingest — turn-row upsert already succeeded.
        // Surface the error so the sweep can count degraded ingests.
      }
    }

    log.debug(
      `Ingested ${newLines.length} turn lines + ${attachmentsWritten} attachment rows for session ${agentSessionId}`,
      {
        highWaterMark: highWaterMark?.toISOString() ?? "none",
        newHighWaterMark: latestTs?.toISOString(),
      }
    );

    // Surface any turn-extract OR attachment-insert failure on success — the
    // caller may want to know turn rows weren't materialized (FTS lag) or
    // that attachments were skipped. (mt#2789: HWM-read failure can no longer
    // reach this point — it aborts above — so it's not part of this union
    // anymore.) The `ingested` count counts turn lines only, matching the
    // pre-mt#2022 semantics; attachments live in their own table and don't
    // roll into this number.
    return {
      ingested: newLines.length,
      error: turnExtractError ?? attachmentError,
    };
  }

  /**
   * Sweep all sessions discoverable by the source adapter and ingest each one.
   *
   * A failure on any individual session is logged and skipped so the sweep
   * continues over the remaining ~245 sessions.
   *
   * @returns Total number of new lines ingested across all sessions.
   */
  async ingestAll(): Promise<IngestAllResult> {
    let totalIngested = 0;
    let sessionsProcessed = 0;
    let sessionsErrored = 0;

    for await (const session of this.source.discoverSessions()) {
      sessionsProcessed++;
      try {
        const result = await this.ingestSession(session);
        totalIngested += result.ingested;
        if (result.error !== undefined) {
          // ingestSession hit a failure along one of its internal paths
          // (HWM read, stream, upsert — abort; turn-extract, attachment
          // insert — best-effort). Count it honestly (mt#1444).
          sessionsErrored++;
          log.warn(`Session ${session.agentSessionId} reported a degraded ingest`, {
            error: getErrorMessage(result.error),
            ingested: result.ingested,
          });
        }
      } catch (err) {
        // Defensive — ingestSession is documented as never throwing, but if
        // an unexpected throw escapes (e.g., an iterator boundary), still count it.
        sessionsErrored++;
        log.warn(`Session ${session.agentSessionId} failed during sweep`, {
          error: getErrorMessage(err),
        });
      }
    }

    log.info(`Ingest sweep complete`, { totalIngested, sessionsProcessed, sessionsErrored });
    return { totalIngested, sessionsProcessed, sessionsErrored };
  }
}

export interface IngestSessionResult {
  /** Number of new lines written to agent_transcripts for this session. */
  ingested: number;
  /**
   * Set when ingestSession hit a failure along one of its internal paths.
   * HWM read / stream / upsert failures ABORT the ingest (mt#2789) and
   * return `{ ingested: 0, error }`; turn-extract / attachment-insert
   * failures are best-effort — the function continues and surfaces the
   * error on an otherwise-successful return. Either way, callers can count
   * it. mt#1444.
   */
  error?: Error;
}

export interface IngestAllResult {
  totalIngested: number;
  sessionsProcessed: number;
  sessionsErrored: number;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Extracts the earliest ISO timestamp from the provided lines; returns null if
 * none of the lines carry a valid timestamp.
 */
function extractStartedAt(lines: RawTurnLine[], source: TranscriptSource): Date | null {
  let earliest: Date | null = null;
  for (const line of lines) {
    const tsStr = source.getJsonlTimestamp(line);
    if (!tsStr) continue;
    const d = new Date(tsStr);
    if (isNaN(d.getTime())) continue;
    if (earliest === null || d < earliest) {
      earliest = d;
    }
  }
  return earliest;
}

/**
 * Best-effort derivation of a project_dir from a JSONL path.
 *
 * Claude Code stores transcripts under `~/.claude/projects/<project-dir>/<session-uuid>.jsonl`.
 * The `project-dir` segment is the absolute project path with `/` replaced by `-`.
 * We return the parent directory of the JSONL file as a portable proxy.
 */
function deriveProjectDir(jsonlPath: string): string {
  const lastSlash = jsonlPath.lastIndexOf("/");
  return lastSlash > 0 ? jsonlPath.slice(0, lastSlash) : jsonlPath;
}
