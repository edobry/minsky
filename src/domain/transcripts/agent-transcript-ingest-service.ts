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
import { log } from "../../utils/logger";
import { getErrorMessage } from "../../errors/index";
import type { DiscoveredSession, RawTurnLine, TranscriptSource } from "./transcript-source";

// eslint-disable-next-line custom/require-injectable -- not yet registered in DI; wired by callers directly
export class AgentTranscriptIngestService {
  constructor(
    private readonly db: PostgresJsDatabase,
    private readonly source: TranscriptSource
  ) {}

  /**
   * Ingest a single session identified by its agent session ID.
   *
   * Returns a typed result so the caller can distinguish success from a caught
   * failure. Failures along the three swallow paths (HWM read, stream, upsert)
   * surface as `error !== undefined` instead of being lost — that's what
   * `ingestAll` uses to count `sessionsErrored` honestly (mt#1444).
   *
   * @param session - The discovered session metadata (from discoverSessions() or a direct lookup).
   * @returns `{ ingested: number; error?: Error }` — `ingested` is the number of new
   *   lines written (0 on idempotent re-run or on caught failure); `error` is set
   *   when any of the three internal paths swallowed a failure.
   */
  async ingestSession(session: DiscoveredSession): Promise<IngestSessionResult> {
    const { agentSessionId, harness, jsonlPath, mtime } = session;

    // ── 1. Read the current high-water-mark ──────────────────────────────────
    let highWaterMark: Date | null = null;
    let hwmReadError: Error | undefined;
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
      hwmReadError = err instanceof Error ? err : new Error(String(err));
      log.warn(`Failed to read high-water-mark for session ${agentSessionId}`, {
        error: getErrorMessage(err),
      });
      // Proceed with null — treat as no prior ingest, will collect all lines.
      // The error is surfaced in the return value so the sweep can count it.
    }

    // ── 2. Stream new lines ──────────────────────────────────────────────────
    const newLines: RawTurnLine[] = [];
    let latestTs: Date | null = null;

    try {
      for await (const line of this.source.readSession(agentSessionId)) {
        const tsStr = this.source.getJsonlTimestamp(line);
        if (!tsStr) continue;

        const tsDate = new Date(tsStr);
        if (isNaN(tsDate.getTime())) continue;

        // Incremental gate: skip lines already ingested.
        if (highWaterMark !== null && tsDate <= highWaterMark) continue;

        newLines.push(line);
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

    if (newLines.length === 0) {
      log.debug(
        `No new lines for session ${agentSessionId} (high-water-mark: ${highWaterMark?.toISOString() ?? "none"})`
      );
      // Idempotent re-run. Still surface any HWM-read failure that occurred —
      // a recovered-from HWM error is a degraded state worth counting (without
      // a HWM, the next ingest would re-collect already-ingested lines).
      return { ingested: 0, error: hwmReadError };
    }

    // ── 3. Derive metadata from the source's DiscoveredSession ───────────────
    const startedAt = extractStartedAt(newLines, this.source);
    const endedAt = latestTs ?? mtime;

    // ── 4. Upsert into agent_transcripts ─────────────────────────────────────
    // Single atomic statement: INSERT … ON CONFLICT (agent_session_id) DO UPDATE.
    // The on-conflict UPDATE merges transcript lines via SQL JSONB array concat
    // (`transcript || EXCLUDED.transcript`), eliminating both the TOCTOU
    // duplicate-key race and the lost-update window of a JS read-modify-write.
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
            transcript: sql`COALESCE(${agentTranscriptsTable.transcript}, '[]'::jsonb) || EXCLUDED.transcript`,
            endedAt: sql`EXCLUDED.ended_at`,
            lastIngestedJsonlTimestamp: sql`EXCLUDED.last_ingested_jsonl_timestamp`,
            ingestedAt: sql`EXCLUDED.ingested_at`,
          },
        });
    } catch (err) {
      log.error(`Failed to upsert transcript for session ${agentSessionId}`, {
        error: getErrorMessage(err),
      });
      return { ingested: 0, error: err instanceof Error ? err : new Error(String(err)) };
    }

    log.debug(`Ingested ${newLines.length} new lines for session ${agentSessionId}`, {
      highWaterMark: highWaterMark?.toISOString() ?? "none",
      newHighWaterMark: latestTs?.toISOString(),
    });

    // Surface any HWM-read failure even on success — caller may want to know
    // the HWM was lost (the upsert merged via JSONB-array-concat so we may have
    // duplicated already-ingested lines). The `ingested` count is honest.
    return { ingested: newLines.length, error: hwmReadError };
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
          // ingestSession swallowed a failure along one of three paths
          // (HWM read, stream, upsert). Count it honestly (mt#1444).
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
   * Set when ingestSession swallowed a failure along one of three paths
   * (HWM read, stream, upsert). The function continued (recovered or returned
   * 0); the error is surfaced so callers can count it. mt#1444.
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
