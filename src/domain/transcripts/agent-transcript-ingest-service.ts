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
   * @param session - The discovered session metadata (from discoverSessions() or a direct lookup).
   * @returns Number of new lines ingested (0 for a fully-idempotent re-run).
   */
  async ingestSession(session: DiscoveredSession): Promise<number> {
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
      log.warn(`Failed to read high-water-mark for session ${agentSessionId}`, {
        error: getErrorMessage(err),
      });
      // Proceed with null — treat as no prior ingest, will collect all lines.
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
      return 0;
    }

    if (newLines.length === 0) {
      log.debug(
        `No new lines for session ${agentSessionId} (high-water-mark: ${highWaterMark?.toISOString() ?? "none"})`
      );
      return 0;
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
          cwd: jsonlPath, // best-effort: jsonlPath encodes the project dir
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
      return 0;
    }

    log.debug(`Ingested ${newLines.length} new lines for session ${agentSessionId}`, {
      highWaterMark: highWaterMark?.toISOString() ?? "none",
      newHighWaterMark: latestTs?.toISOString(),
    });

    return newLines.length;
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
        const count = await this.ingestSession(session);
        totalIngested += count;
      } catch (err) {
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
