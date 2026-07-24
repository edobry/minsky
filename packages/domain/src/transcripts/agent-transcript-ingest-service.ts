/**
 * AgentTranscriptIngestService
 *
 * Orchestration layer that wires a TranscriptSource adapter to the
 * `agent_transcripts` DB table.  Per-session ingest is incremental: only JSONL
 * lines whose timestamp is strictly greater than the stored
 * `last_ingested_jsonl_timestamp` high-water-mark are ingested.  Re-running
 * over an unchanged JSONL is a no-op.
 *
 * ## Credential scrubbing (mt#2763)
 *
 * Every raw line is passed through `scrubValueDeep` (see
 * `./credential-scrubber.ts`) BEFORE it reaches either durable-copy
 * destination this service writes to — `agent_transcripts.transcript` JSONB
 * and `agent_transcript_attachments.content`. This is the chosen enforcement
 * point: investigation (documented in `credential-scrubber.ts`'s header)
 * found that a Claude Code PostToolUse hook cannot rewrite/redact a tool
 * result before it is stored or displayed, so the scrub cannot happen at the
 * hook layer — it has to happen here, at ingest, the first point a raw line
 * is about to become a DB-backed durable copy. Per-turn extraction
 * (`turn-writer.ts`) re-reads the already-scrubbed stored transcript, so one
 * interception point covers every DB-backed read path. This does NOT scrub
 * the harness's own on-disk JSONL copy or the live model context — see
 * `credential-scrubber.ts`'s "What this does NOT cover" section.
 *
 * @see mt#1313 §Ingestion semantics
 * @see mt#1351 — this file
 * @see mt#1350 — TranscriptSource interface + ClaudeCodeTranscriptSource
 * @see mt#1324 — agent_transcripts schema
 * @see mt#2763 — credential scrubbing at this layer
 */

import { eq, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import { agentTranscriptsTable } from "../storage/schemas/agent-transcripts-schema";
import { agentTranscriptAttachmentsTable } from "../storage/schemas/agent-transcript-attachments-schema";
import { log } from "@minsky/shared/logger";
import { getLoggableErrorSummary } from "../errors/index";
import type { DiscoveredSession, RawTurnLine, TranscriptSource } from "./transcript-source";
import { type AttachmentRow, buildAttachmentRow } from "./attachment-row-builder";
import { writeTurnsForTranscript } from "./turn-writer";
import { writeCwdMatchLink } from "./session-link-writer";
import { scrubValueDeep, type RedactionHit } from "./credential-scrubber";
import { recordCredentialScrub, realCredentialScrubLogDeps } from "./credential-scrub-log";
import { resolveProjectIdentity } from "../project/identity";
import { resolveProjectScope } from "../project/scope-resolver";
import { isAllProjects } from "../project/scope";
import { SYNTHETIC_MODEL_SENTINEL } from "../subagent/transcript-metrics";

/**
 * Resolve a project uuid for a transcript from its recovered `cwd`, using the
 * same slug resolver the CLI/stdio MCP supplier uses for tasks/sessions/memories/
 * asks (ADR-021, mt#2416). Returns null (never throws) when `cwd` is absent, the
 * identity can't be resolved (e.g. no git remote), or no matching `projects` row
 * exists — mirroring the "unidentified -> ALL_PROJECTS" fail-open posture, since
 * ingestion must never block on project resolution (mt#2417, Phase 1.4).
 */
async function resolveIngestProjectId(
  cwd: string | null | undefined,
  db: PostgresJsDatabase
): Promise<string | null> {
  if (!cwd) return null;
  try {
    const identity = resolveProjectIdentity({ repoPath: cwd });
    if (identity.kind !== "resolved") return null;
    const scope = await resolveProjectScope(identity, db);
    return isAllProjects(scope) ? null : scope;
  } catch (err) {
    log.debug("[transcripts] Project id resolution failed for ingest; leaving unscoped", {
      cwd,
      error: getLoggableErrorSummary(err),
    });
    return null;
  }
}

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
   * @param opts.sessionEnded - mt#3131 (D2): true ONLY when this ingest call
   *   corresponds to genuine positive evidence the session has terminated —
   *   the harness's own SessionEnd lifecycle event, not a routine incremental
   *   poll/sweep. Every other caller (the boot sweep, the filesystem watcher,
   *   the cadence sweep, a manual `--all`/`--conversationId` ingest) MUST omit
   *   this or pass `false`. See `endedAt` derivation below for why.
   * @returns `{ ingested: number; error?: Error }` — `ingested` is the number of new
   *   lines written (0 on idempotent re-run or on an abort path); `error` is set
   *   when any of the five internal paths above hit a failure.
   */
  async ingestSession(
    session: DiscoveredSession,
    opts?: { sessionEnded?: boolean }
  ): Promise<IngestSessionResult> {
    const sessionEnded = opts?.sessionEnded ?? false;
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
        error: getLoggableErrorSummary(err),
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
    // mt#2763: credential-shaped strings redacted out of raw lines this
    // call, aggregated across the whole stream and logged once below (the
    // counted signal — see credential-scrub-log.ts).
    const allRedactions: RedactionHit[] = [];

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
          // mt#2763: scrub BEFORE the line is retained — this is the
          // durable-copy write path (agent_transcripts.transcript JSONB).
          const { value: scrubbedLine, redactions } = scrubValueDeep(line);
          if (redactions.length > 0) allRedactions.push(...redactions);
          newLines.push(scrubbedLine);
        } else if (lineType === "attachment" || lineType === "system") {
          // mt#2763: scrub BEFORE buildAttachmentRow captures `content: line`
          // verbatim (attachment-row-builder.ts) — the other durable-copy
          // write path (agent_transcript_attachments.content).
          const { value: scrubbedLine, redactions } = scrubValueDeep(line);
          if (redactions.length > 0) allRedactions.push(...redactions);
          const row = buildAttachmentRow(agentSessionId, lineIndex, scrubbedLine, tsDate);
          if (row !== null) newAttachmentRows.push(row);
        }

        if (latestTs === null || tsDate > latestTs) {
          latestTs = tsDate;
        }
      }
    } catch (err) {
      log.warn(`Failed to stream lines for session ${agentSessionId}`, {
        error: getLoggableErrorSummary(err),
      });
      // Return 0 — don't partially-commit a broken read.
      // Surface the error so the sweep can count it (mt#1444).
      return { ingested: 0, error: err instanceof Error ? err : new Error(String(err)) };
    }

    // mt#2763: emit the counted signal before the "no new lines" idempotent
    // return below, so a redaction is logged even in the edge case where the
    // ONLY retained line that scrubbed was an attachment/system line whose
    // (already-scrubbed) content buildAttachmentRow then rejected as
    // malformed (returns null) — the redaction still happened even though
    // nothing ended up persisted for that line. NOTE: this call cannot fire
    // for lines the HWM gate filtered out, or for unrecognized line types —
    // both `continue` / fall through BEFORE scrubValueDeep is ever called
    // (see the loop above), so allRedactions only ever contains hits from
    // lines that passed the HWM gate and matched a retained type. Best-effort
    // logging; see credential-scrub-log.ts's own error-swallowing posture.
    if (allRedactions.length > 0) {
      recordCredentialScrub(agentSessionId, allRedactions, realCredentialScrubLogDeps);
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
    // mt#3131 (D2): `endedAt` asserts TERMINATION, not "last observed". Every
    // ingest call used to set it to `latestTs ?? mtime` unconditionally — since
    // ingest runs on every incremental poll/sweep for a conversation, this made
    // `endedAt` advance on every call, including for a conversation that is
    // still actively running. A consumer reading `endedAt` non-null had no way
    // to tell "this finished" from "this is the last line we happened to see."
    // Only set it when THIS call carries positive termination evidence
    // (`opts.sessionEnded`, wired from the harness's own SessionEnd hook —
    // see transcripts.ts's `ended` param and
    // .minsky/hooks/transcript-ingest-on-session-end.ts). Routine polls never
    // touch it (see the onConflictDoUpdate SET clause below); `lastIngestedJsonlTimestamp`
    // already carries the "last observed" signal for every caller (exposed to
    // the frontend as `lastActivityAt`, routes/conversations.ts).
    const endedAt = sessionEnded ? (latestTs ?? mtime) : null;

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
    // Project scoping (mt#2417, Phase 1.4): resolve from the recovered cwd.
    // Unlike `cwd` (strictly insert-only), `project_id` IS refreshed on
    // conflict via COALESCE-forward below — a session first ingested before
    // its cwd was recoverable can still get scoped once a later ingest
    // resolves it, without ever downgrading an already-resolved project back
    // to null (mirrors the `writeCwdMatchLink` precedence note above).
    const resolvedProjectId = await resolveIngestProjectId(session.cwd, this.db);

    // mt#3089: extract the model id from THIS batch's new assistant lines.
    // See extractModelFromNewLines's doc comment for why a later batch that
    // doesn't re-include the model-bearing turn must not regress an
    // already-stored value — handled below via COALESCE on conflict, mirroring
    // projectId's precedence pattern.
    const extractedModel = extractModelFromNewLines(newLines);

    // mt#3089 R1 review — extractor observability: a null result is
    // unremarkable when the batch has no assistant lines at all (nothing to
    // extract from), but a GENUINE miss when assistant lines ARE present and
    // none carried a usable model — either every one was a synthetic retry,
    // or the harness's transcript shape has drifted out from under the
    // extractor. Logging only the latter case keeps the common path quiet
    // while making a future format drift visible instead of silently
    // reproducing the 0/1,729 state this task exists to fix.
    if (extractedModel === null) {
      const assistantLineCount = countAssistantLines(newLines);
      if (assistantLineCount > 0) {
        log.warn(
          `[transcripts] No genuine model id found in ${assistantLineCount} assistant line(s) for session ${agentSessionId} — possible transcript-shape drift`,
          { agentSessionId, assistantLineCount }
        );
      }
    }

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
          model: extractedModel ?? undefined,
          // mt#1445: use the session's recovered working directory if the
          // source could provide one; otherwise leave the column NULL rather
          // than substituting the JSONL path. Downstream consumers querying
          // `cwd` expect a working directory, not a transcript path.
          cwd: session.cwd ?? undefined,
          projectDir: deriveProjectDir(jsonlPath),
          projectId: resolvedProjectId ?? undefined,
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
            // mt#3131 (D2): only overwrite the stored `endedAt` when THIS call
            // carries genuine termination evidence. A routine poll
            // (`sessionEnded` false) must leave whatever is already stored
            // untouched — it must never REGRESS an already-recorded end time
            // back toward "unknown" (a stale/duplicate SessionEnd delivery is
            // not evidence the conversation is live again), and it must not
            // advance a not-yet-ended conversation's endedAt just because a
            // sweep happened to observe new lines.
            endedAt: sessionEnded ? sql`EXCLUDED.ended_at` : sql`${agentTranscriptsTable.endedAt}`,
            // NULL-safety: Postgres GREATEST *ignores* NULL arguments (result
            // is NULL only when ALL args are NULL) — unlike MySQL, where any
            // NULL poisons the result. GREATEST(NULL, ts) = ts here, so a
            // NULL existing watermark advances and a NULL incoming one cannot
            // regress a stored value. Verified empirically on PG17.
            lastIngestedJsonlTimestamp: sql`GREATEST(${agentTranscriptsTable.lastIngestedJsonlTimestamp}, EXCLUDED.last_ingested_jsonl_timestamp)`,
            ingestedAt: sql`EXCLUDED.ingested_at`,
            projectId: sql`COALESCE(${agentTranscriptsTable.projectId}, EXCLUDED.project_id)`,
            // mt#3089: never regress an already-resolved model with a later
            // batch that didn't happen to include the model-bearing turn.
            model: sql`COALESCE(${agentTranscriptsTable.model}, EXCLUDED.model)`,
          },
        });
    } catch (err) {
      log.error(`Failed to upsert transcript for session ${agentSessionId}`, {
        error: getLoggableErrorSummary(err),
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
      const { nonEmptyYieldedZero, erroredChunks } = await writeTurnsForTranscript(
        this.db,
        agentSessionId,
        fullTranscript
      );
      if (nonEmptyYieldedZero) {
        // mt#2457 SC3: a non-empty transcript that yields zero turns is an
        // extraction failure, not a "nothing new to write" no-op — the throw-only
        // catch below can't see this case (writeTurnsForTranscript already logs a
        // WARN; this makes it count as a degraded ingest too, same as a throw).
        turnExtractError = new Error(
          `Non-empty transcript yielded zero turns for session ${agentSessionId}`
        );
      } else if (erroredChunks > 0) {
        // A failed bulk-upsert chunk is a partial write, not a success — surface
        // it as a degraded ingest so ingestAll counts this session in
        // sessionsErrored, matching the sweep and single-session classifications.
        turnExtractError = new Error(
          `${erroredChunks} turn-upsert chunk(s) failed for session ${agentSessionId}`
        );
      }
    } catch (err) {
      turnExtractError = err instanceof Error ? err : new Error(String(err));
      log.warn(`Failed to materialize turn rows for session ${agentSessionId}`, {
        error: getLoggableErrorSummary(err),
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
        error: getLoggableErrorSummary(err),
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
          { error: getLoggableErrorSummary(err) }
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
            error: getLoggableErrorSummary(result.error),
            ingested: result.ingested,
          });
        }
      } catch (err) {
        // Defensive — ingestSession is documented as never throwing, but if
        // an unexpected throw escapes (e.g., an iterator boundary), still count it.
        sessionsErrored++;
        log.warn(`Session ${session.agentSessionId} failed during sweep`, {
          error: getLoggableErrorSummary(err),
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
 * Extract the first genuine (non-synthetic) model id from a batch of newly
 * ingested turn lines (mt#3089).
 *
 * Every REAL Claude Code transcript assistant line carries `message.model`
 * (e.g. `{"type":"assistant","message":{"model":"claude-sonnet-5",...}}`) —
 * the data has always been present in the JSONL; `agent_transcripts.model`
 * was simply never extracted from it (the ingest path never referenced the
 * `model` field at all prior to this fix, unlike the sibling `actual_model`
 * writer in `packages/domain/src/subagent/transcript-metrics.ts`'s
 * `extractActualModel`, mt#2796, which this mirrors). The harness also
 * injects `{@link SYNTHETIC_MODEL_SENTINEL}` on locally-manufactured retry
 * turns (rate-limit/API-error recovery) — never a genuine model response —
 * so those are skipped the same way `extractActualModel` skips them.
 *
 * Operates on the already-parsed `newLines` batch (not a re-read from disk):
 * `ingestSession` scans every retained line since the high-water-mark in one
 * pass, so for a session's FIRST ingest this batch includes its earliest
 * assistant turn and the model is found immediately. A later incremental
 * ingest's `newLines` may not re-include that early turn — the caller
 * (`ingestSession`) is responsible for not regressing an already-stored
 * value (COALESCE on conflict), not this pure extractor.
 *
 * Never throws — returns null on any unexpected shape.
 */
export function extractModelFromNewLines(lines: readonly RawTurnLine[]): string | null {
  for (const line of lines) {
    if (line.type !== "assistant") continue;
    try {
      const message = line.message as { model?: unknown } | undefined;
      const model = message?.model;
      if (typeof model === "string" && model.length > 0 && model !== SYNTHETIC_MODEL_SENTINEL) {
        return model;
      }
    } catch {
      // Defensive — line.message could theoretically be a getter that throws
      // on a malformed source adapter; never let extraction abort ingest.
      continue;
    }
  }
  return null;
}

/**
 * Count assistant-type lines in a batch (mt#3089 R1 review — extractor
 * observability).
 *
 * Used alongside {@link extractModelFromNewLines} to distinguish the two
 * shapes that both produce a `null` model result, which are NOT the same
 * situation:
 *
 *   - **0 assistant lines in the batch** — the common, unremarkable case (a
 *     batch of pure user/tool_result turns, or an incremental ingest whose
 *     new lines happen to be entirely non-assistant). Nothing to warn about.
 *   - **1+ assistant lines, but none carried a genuine (non-synthetic)
 *     `message.model`** — a genuine miss: either every assistant line in the
 *     batch was a synthetic retry, or the harness's transcript shape has
 *     drifted (e.g. `message.model` renamed/moved) and the extractor is
 *     silently failing to find data that should be there. Callers log this
 *     case — see `ingestSession`'s call site — so a future format drift
 *     reproduces as a visible, diagnosable log line instead of silently
 *     regressing back to the 0/1,729 state this task exists to fix.
 *
 * Exported (not just called inline) so both `ingestSession` and
 * `scripts/backfill-agent-transcripts-model.ts` share one definition instead
 * of duplicating the `type === "assistant"` filter.
 */
export function countAssistantLines(lines: readonly RawTurnLine[]): number {
  let count = 0;
  for (const line of lines) {
    if (line.type === "assistant") count++;
  }
  return count;
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
