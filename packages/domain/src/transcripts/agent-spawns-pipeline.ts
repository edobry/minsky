/**
 * AgentSpawnsPipeline
 *
 * Post-pass orchestrator that reads `agent_transcript_turns` rows where
 * `is_spawn_boundary = true`, extracts spawn metadata from `tool_calls` JSON,
 * and upserts rows into `agent_spawns`.
 *
 * Design choice (post-pass over in-line):
 *   - mt#1352's PerTurnEmbeddingPipeline is already in main and tested; modifying
 *     it risks regressions.
 *   - mt#1329 runs in parallel and also wants to extend ingest; two post-pass
 *     orchestrators are cleaner than two contributors editing the same file.
 *   - The spec explicitly allows a "second sweeper pass" for backfill.
 *
 * Extraction logic:
 *   - `agent_kind`: value of `subagent_type` arg on the Agent tool call.
 *   - `spawn_type`: "background" when `run_in_background` arg is truthy, else "foreground".
 *   - `child_agent_session_id`: extracted from tool-call result metadata when present;
 *     otherwise derived from cwd-time-window heuristic (finds agent_transcripts rows
 *     whose cwd matches parent cwd and startedAt falls within the spawn turn's time window).
 *   - `spawned_at`: the turn's `ended_at` timestamp (moment the Agent tool was invoked).
 *
 * Idempotent: upserts on (parent_agent_session_id, parent_turn_index).
 *
 * Also drives the `subagent_spawn` `minsky_session_links` writer (mt#2756):
 * once `childAgentSessionId` is resolved for a spawn, this pipeline calls
 * `writeSpawnLink` (spawn-link-writer.ts) with the SAME Agent tool call's
 * `input.prompt` text already loaded for extraction above — no extra query.
 * That link is what lets `/agents/:id` (mt#1919, `src/cockpit/routes/agents.ts`)
 * resolve a dispatched subagent's live conversation even though its `cwd`
 * never matches the workspace directory (mt#2749 finding).
 *
 * @see mt#1327 — this file
 * @see mt#1313 §Schema — agent_spawns table
 * @see mt#1352 — PerTurnEmbeddingPipeline writes is_spawn_boundary flag
 * @see agent-spawns-schema.ts — destination table
 * @see mt#2756 / spawn-link-writer.ts — subagent_spawn minsky_session_links writer
 */

import { eq, and, gte, lte } from "drizzle-orm";
import { sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import { agentTranscriptTurnsTable } from "../storage/schemas/agent-transcript-turns-schema";
import { agentTranscriptsTable } from "../storage/schemas/agent-transcripts-schema";
import { agentSpawnsTable } from "../storage/schemas/agent-spawns-schema";
import { writeSpawnLink } from "./spawn-link-writer";
import { findAgentToolCall, type AgentToolCallBlock } from "./agent-tool-call-shape";
import { log } from "@minsky/shared/logger";
import { getErrorMessage } from "../errors/index";

// ── Types ─────────────────────────────────────────────────────────────────────

/** Result returned by AgentSpawnsPipeline.run(). */
export interface SpawnsPipelineRunResult {
  /** Total spawn-boundary turns scanned from agent_transcript_turns. */
  spawnsScanned: number;
  /** Spawn rows inserted/updated in agent_spawns. */
  spawnsWritten: number;
  /** Spawn rows where child_agent_session_id was resolved via metadata. */
  childLinkedFromMetadata: number;
  /** Spawn rows where child_agent_session_id was resolved via cwd-time heuristic. */
  childLinkedFromHeuristic: number;
  /** Spawn rows where child_agent_session_id could not be resolved (remains null). */
  childUnresolved: number;
  /** Number of turns that errored and were skipped. */
  spawnsErrored: number;
  /**
   * `subagent_spawn` minsky_session_links rows written or already present
   * (mt#2756) — a subset of the resolved-child spawns whose dispatch prompt
   * embedded a Minsky workspace session directory.
   */
  spawnLinksWritten: number;
  /**
   * Spawn had a resolved `childAgentSessionId`, but its dispatch prompt did
   * NOT embed a Minsky workspace session directory (mt#2756 R1). Kept
   * distinct from `childUnresolved` on purpose: a low `spawnLinksWritten`
   * count is ambiguous on its own — it could mean "children rarely resolve"
   * (see `childUnresolved`) OR "children resolve fine but their prompts
   * aren't Minsky-shaped" (this counter). Conflating the two was flagged in
   * review as misleading.
   */
  spawnLinksSkippedNoPromptMatch: number;
  /**
   * The `subagent_spawn` link DB write itself failed for a row that HAD a
   * resolved child and a matching prompt (mt#2756 R1) — distinct from
   * `spawnsErrored`, which covers whole-turn processing failures (upstream
   * of the link write).
   */
  spawnLinksErrored: number;
}

/** Time-window margin in milliseconds for cwd-time heuristic (± 30 seconds). */
const CWD_TIME_MARGIN_MS = 30_000;

// ── Pipeline ──────────────────────────────────────────────────────────────────

export class AgentSpawnsPipeline {
  /**
   * @param db Postgres connection.
   * @param sessionsDir Override for the Minsky sessions-workspace root
   *   (`<stateDir>/sessions`) passed through to `writeSpawnLink` (mt#2756).
   *   Defaults to the live `getSessionsDir()` when omitted — a test seam,
   *   not a production knob.
   */
  constructor(
    private readonly db: PostgresJsDatabase,
    private readonly sessionsDir?: string
  ) {}

  /**
   * Run the full spawn-extraction sweep.
   *
   * Reads all agent_transcript_turns rows where is_spawn_boundary = true,
   * joined to agent_transcripts for cwd and timing metadata. For each row:
   *   1. Extract agent_kind and spawn_type from tool_calls JSON.
   *   2. Try to resolve child_agent_session_id from metadata (future: from tool result).
   *   3. Fall back to cwd-time-window heuristic if metadata link is absent.
   *   4. Upsert into agent_spawns.
   */
  async run(): Promise<SpawnsPipelineRunResult> {
    const result: SpawnsPipelineRunResult = {
      spawnsScanned: 0,
      spawnsWritten: 0,
      childLinkedFromMetadata: 0,
      childLinkedFromHeuristic: 0,
      childUnresolved: 0,
      spawnsErrored: 0,
      spawnLinksWritten: 0,
      spawnLinksSkippedNoPromptMatch: 0,
      spawnLinksErrored: 0,
    };

    // ── 1. Load spawn-boundary turns with parent metadata ─────────────────
    let rows: Array<{
      agentSessionId: string;
      turnIndex: number;
      toolCalls: unknown;
      endedAt: Date | null;
      parentCwd: string | null;
    }>;

    try {
      rows = await this.db
        .select({
          agentSessionId: agentTranscriptTurnsTable.agentSessionId,
          turnIndex: agentTranscriptTurnsTable.turnIndex,
          toolCalls: agentTranscriptTurnsTable.toolCalls,
          endedAt: agentTranscriptTurnsTable.endedAt,
          parentCwd: agentTranscriptsTable.cwd,
        })
        .from(agentTranscriptTurnsTable)
        .innerJoin(
          agentTranscriptsTable,
          eq(agentTranscriptTurnsTable.agentSessionId, agentTranscriptsTable.agentSessionId)
        )
        .where(eq(agentTranscriptTurnsTable.isSpawnBoundary, true));
    } catch (err) {
      log.error("AgentSpawnsPipeline: failed to load spawn-boundary turns", {
        error: getErrorMessage(err),
      });
      return result;
    }

    result.spawnsScanned = rows.length;

    // ── 2. Process each spawn-boundary turn ──────────────────────────────
    for (const row of rows) {
      try {
        const { agentSessionId, turnIndex, toolCalls, endedAt, parentCwd } = row;

        // Extract Agent tool call from tool_calls JSONB.
        const agentCall = findAgentToolCall(toolCalls);
        if (!agentCall) {
          // is_spawn_boundary was true but no Agent tool call found — shouldn't happen,
          // but guard gracefully.
          log.warn(
            `AgentSpawnsPipeline: is_spawn_boundary=true but no Agent tool call found for ${agentSessionId}[${turnIndex}]`
          );
          continue;
        }

        const agentKind = extractAgentKind(agentCall);
        const spawnType = extractSpawnType(agentCall);
        const spawnedAt = endedAt;

        // Attempt to resolve child session ID.
        let childAgentSessionId: string | null = null;
        let linkSource: "metadata" | "heuristic" | "unresolved" = "unresolved";

        // Primary: extract from tool-call metadata (tool result carries session ID).
        // This is populated when the tool_calls JSONB includes a session_id field
        // on the Agent call's input (some harness versions include this).
        const metadataSessionId = extractChildSessionIdFromMetadata(agentCall);
        if (metadataSessionId) {
          childAgentSessionId = metadataSessionId;
          linkSource = "metadata";
        } else if (parentCwd && spawnedAt) {
          // Fallback: cwd-time-window heuristic.
          const heuristicId = await this.resolveChildByCwdTimeWindow(
            agentSessionId,
            parentCwd,
            spawnedAt
          );
          if (heuristicId) {
            childAgentSessionId = heuristicId;
            linkSource = "heuristic";
          }
        }

        // Upsert into agent_spawns.
        await this.db
          .insert(agentSpawnsTable)
          .values({
            parentAgentSessionId: agentSessionId,
            parentTurnIndex: turnIndex,
            childAgentSessionId: childAgentSessionId ?? undefined,
            spawnType: spawnType ?? undefined,
            agentKind: agentKind ?? undefined,
            spawnedAt: spawnedAt ?? undefined,
          })
          .onConflictDoUpdate({
            target: [agentSpawnsTable.parentAgentSessionId, agentSpawnsTable.parentTurnIndex],
            set: {
              childAgentSessionId: sql`EXCLUDED.child_agent_session_id`,
              spawnType: sql`EXCLUDED.spawn_type`,
              agentKind: sql`EXCLUDED.agent_kind`,
              spawnedAt: sql`EXCLUDED.spawned_at`,
            },
          });

        result.spawnsWritten++;
        if (linkSource === "metadata") result.childLinkedFromMetadata++;
        else if (linkSource === "heuristic") result.childLinkedFromHeuristic++;
        else result.childUnresolved++;

        // mt#2756: write the subagent_spawn minsky_session_links row using
        // the SAME Agent tool call's prompt text already loaded above — no
        // extra query. The discriminated outcome (mt#2756 R1) lets us count
        // "no-prompt-match" separately from "no-child" (already reflected
        // above via childUnresolved) and from a genuine DB-write failure —
        // collapsing those into one boolean was flagged in review as
        // misleading (a low written-count is ambiguous without this split).
        const spawnLinkOutcome = await writeSpawnLink(
          this.db,
          childAgentSessionId,
          agentCall.input?.prompt,
          this.sessionsDir
        );
        if (spawnLinkOutcome === "written") result.spawnLinksWritten++;
        else if (spawnLinkOutcome === "no-prompt-match") result.spawnLinksSkippedNoPromptMatch++;
        else if (spawnLinkOutcome === "error") result.spawnLinksErrored++;
        // "no-child" needs no separate counter — childUnresolved above already
        // captures it from the same childAgentSessionId resolution state.
      } catch (err) {
        result.spawnsErrored++;
        log.warn(
          `AgentSpawnsPipeline: failed to process spawn for ${row.agentSessionId}[${row.turnIndex}]`,
          { error: getErrorMessage(err) }
        );
      }
    }

    log.info("AgentSpawnsPipeline: run complete", {
      spawnsScanned: result.spawnsScanned,
      spawnsWritten: result.spawnsWritten,
      childLinkedFromMetadata: result.childLinkedFromMetadata,
      childLinkedFromHeuristic: result.childLinkedFromHeuristic,
      childUnresolved: result.childUnresolved,
      spawnsErrored: result.spawnsErrored,
      spawnLinksWritten: result.spawnLinksWritten,
      spawnLinksSkippedNoPromptMatch: result.spawnLinksSkippedNoPromptMatch,
      spawnLinksErrored: result.spawnLinksErrored,
    });

    return result;
  }

  /**
   * Run the pipeline for a single parent agent session.
   *
   * Reads only spawn-boundary turns for the given session ID. Useful for
   * targeted re-extraction after a single transcript is ingested.
   */
  async runForSession(agentSessionId: string): Promise<SpawnsPipelineRunResult> {
    const result: SpawnsPipelineRunResult = {
      spawnsScanned: 0,
      spawnsWritten: 0,
      childLinkedFromMetadata: 0,
      childLinkedFromHeuristic: 0,
      childUnresolved: 0,
      spawnsErrored: 0,
      spawnLinksWritten: 0,
      spawnLinksSkippedNoPromptMatch: 0,
      spawnLinksErrored: 0,
    };

    let rows: Array<{
      turnIndex: number;
      toolCalls: unknown;
      endedAt: Date | null;
      parentCwd: string | null;
    }>;

    try {
      rows = await this.db
        .select({
          turnIndex: agentTranscriptTurnsTable.turnIndex,
          toolCalls: agentTranscriptTurnsTable.toolCalls,
          endedAt: agentTranscriptTurnsTable.endedAt,
          parentCwd: agentTranscriptsTable.cwd,
        })
        .from(agentTranscriptTurnsTable)
        .innerJoin(
          agentTranscriptsTable,
          eq(agentTranscriptTurnsTable.agentSessionId, agentTranscriptsTable.agentSessionId)
        )
        .where(
          and(
            eq(agentTranscriptTurnsTable.agentSessionId, agentSessionId),
            eq(agentTranscriptTurnsTable.isSpawnBoundary, true)
          )
        );
    } catch (err) {
      log.error(
        `AgentSpawnsPipeline: failed to load spawn-boundary turns for session ${agentSessionId}`,
        { error: getErrorMessage(err) }
      );
      return result;
    }

    result.spawnsScanned = rows.length;

    for (const row of rows) {
      try {
        const { turnIndex, toolCalls, endedAt, parentCwd } = row;

        const agentCall = findAgentToolCall(toolCalls);
        if (!agentCall) {
          log.warn(
            `AgentSpawnsPipeline: is_spawn_boundary=true but no Agent tool call found for ${agentSessionId}[${turnIndex}]`
          );
          continue;
        }

        const agentKind = extractAgentKind(agentCall);
        const spawnType = extractSpawnType(agentCall);
        const spawnedAt = endedAt;

        let childAgentSessionId: string | null = null;
        let linkSource: "metadata" | "heuristic" | "unresolved" = "unresolved";

        const metadataSessionId = extractChildSessionIdFromMetadata(agentCall);
        if (metadataSessionId) {
          childAgentSessionId = metadataSessionId;
          linkSource = "metadata";
        } else if (parentCwd && spawnedAt) {
          const heuristicId = await this.resolveChildByCwdTimeWindow(
            agentSessionId,
            parentCwd,
            spawnedAt
          );
          if (heuristicId) {
            childAgentSessionId = heuristicId;
            linkSource = "heuristic";
          }
        }

        await this.db
          .insert(agentSpawnsTable)
          .values({
            parentAgentSessionId: agentSessionId,
            parentTurnIndex: turnIndex,
            childAgentSessionId: childAgentSessionId ?? undefined,
            spawnType: spawnType ?? undefined,
            agentKind: agentKind ?? undefined,
            spawnedAt: spawnedAt ?? undefined,
          })
          .onConflictDoUpdate({
            target: [agentSpawnsTable.parentAgentSessionId, agentSpawnsTable.parentTurnIndex],
            set: {
              childAgentSessionId: sql`EXCLUDED.child_agent_session_id`,
              spawnType: sql`EXCLUDED.spawn_type`,
              agentKind: sql`EXCLUDED.agent_kind`,
              spawnedAt: sql`EXCLUDED.spawned_at`,
            },
          });

        result.spawnsWritten++;
        if (linkSource === "metadata") result.childLinkedFromMetadata++;
        else if (linkSource === "heuristic") result.childLinkedFromHeuristic++;
        else result.childUnresolved++;

        // mt#2756: see the identical comment in run() above.
        const spawnLinkOutcome = await writeSpawnLink(
          this.db,
          childAgentSessionId,
          agentCall.input?.prompt,
          this.sessionsDir
        );
        if (spawnLinkOutcome === "written") result.spawnLinksWritten++;
        else if (spawnLinkOutcome === "no-prompt-match") result.spawnLinksSkippedNoPromptMatch++;
        else if (spawnLinkOutcome === "error") result.spawnLinksErrored++;
      } catch (err) {
        result.spawnsErrored++;
        log.warn(
          `AgentSpawnsPipeline: failed to process spawn for ${agentSessionId}[${row.turnIndex}]`,
          { error: getErrorMessage(err) }
        );
      }
    }

    return result;
  }

  /**
   * CWD-time-window heuristic for child session resolution.
   *
   * Searches agent_transcripts for rows whose cwd matches the parent's cwd
   * AND started_at falls within [spawnedAt - margin, spawnedAt + margin].
   * Excludes the parent session itself.
   *
   * Returns the matching session ID if exactly one candidate is found, or null
   * if zero or multiple candidates are found (ambiguous).
   */
  private async resolveChildByCwdTimeWindow(
    parentAgentSessionId: string,
    parentCwd: string,
    spawnedAt: Date
  ): Promise<string | null> {
    const windowStart = new Date(spawnedAt.getTime() - CWD_TIME_MARGIN_MS);
    const windowEnd = new Date(spawnedAt.getTime() + CWD_TIME_MARGIN_MS);

    let candidates: Array<{ agentSessionId: string }>;
    try {
      candidates = await this.db
        .select({ agentSessionId: agentTranscriptsTable.agentSessionId })
        .from(agentTranscriptsTable)
        .where(
          and(
            eq(agentTranscriptsTable.cwd, parentCwd),
            gte(agentTranscriptsTable.startedAt, windowStart),
            lte(agentTranscriptsTable.startedAt, windowEnd)
          )
        );
    } catch (err) {
      log.warn("AgentSpawnsPipeline: cwd-time heuristic query failed", {
        error: getErrorMessage(err),
      });
      return null;
    }

    // Exclude the parent session from candidates.
    const withoutParent = candidates.filter((c) => c.agentSessionId !== parentAgentSessionId);

    if (withoutParent.length === 1) {
      const candidate = withoutParent[0];
      return candidate ? candidate.agentSessionId : null;
    }

    // Zero or multiple candidates — cannot resolve unambiguously.
    if (withoutParent.length > 1) {
      log.debug(
        `AgentSpawnsPipeline: cwd-time heuristic found ${withoutParent.length} candidates for ` +
          `parent ${parentAgentSessionId} — cannot resolve unambiguously`
      );
    }

    return null;
  }
}

// ── Extraction helpers ─────────────────────────────────────────────────────────

/**
 * Re-exported for backward compatibility (this module's own test file and
 * external callers import `findAgentToolCall` from here). The actual
 * implementation lives in `agent-tool-call-shape.ts` (mt#2756 R1) — the
 * shared finder both this pipeline and the `subagent_spawn` backfill sweep
 * (spawn-link-writer.ts) use, so the two `tool_calls`-JSONB parsers can't
 * drift apart.
 */
export { findAgentToolCall };

/**
 * Extract agent_kind from an Agent tool call's input.
 *
 * Claude Code passes the subagent type (e.g. "general-purpose", "Explore", "refactorer")
 * as the `subagent_type` field in the Agent tool call's `input` object.
 */
export function extractAgentKind(agentCall: AgentToolCallBlock): string | null {
  const input = agentCall.input;
  if (!input || typeof input !== "object") return null;
  const subagentType = (input as Record<string, unknown>)["subagent_type"];
  if (typeof subagentType === "string" && subagentType.length > 0) return subagentType;
  return null;
}

/**
 * Extract spawn_type from an Agent tool call's input.
 *
 * Returns "background" when `run_in_background` is truthy in the input.
 * Defaults to "foreground" when absent or false.
 */
export function extractSpawnType(agentCall: AgentToolCallBlock): "foreground" | "background" {
  const input = agentCall.input;
  if (!input || typeof input !== "object") return "foreground";
  const runInBackground = (input as Record<string, unknown>)["run_in_background"];
  return runInBackground === true ? "background" : "foreground";
}

/**
 * Extract child_agent_session_id from the tool call's metadata when present.
 *
 * Some harness versions include a `session_id` field in the Agent tool call's
 * input that directly identifies the child session. This is the most reliable
 * linkage method and is preferred over the cwd-time heuristic.
 */
export function extractChildSessionIdFromMetadata(agentCall: AgentToolCallBlock): string | null {
  const input = agentCall.input;
  if (!input || typeof input !== "object") return null;
  const sessionId = (input as Record<string, unknown>)["session_id"];
  if (typeof sessionId === "string" && sessionId.length > 0) return sessionId;
  return null;
}
