#!/usr/bin/env bun
// SubagentStop hook: record completed subagent invocation to the DB.
//
// Fires when a subagent stops (successfully or with an error). Classifies
// the subagent's workspace outcome and records the invocation via
// SubagentDispatchTracker.recordSubagentInvocation().
//
// Fail-safe contract: any error logs a warning to stderr and exits 0.
// This hook must NEVER block a subagent stop event.
//
// @see mt#1737 — this file
// @see src/mcp/subagent-dispatch-tracker.ts — DB write layer
// @see src/domain/subagent/workspace-classifier.ts — workspace state
// @see src/domain/subagent/transcript-metrics.ts — transcript metrics
// @see mt#2649 — metrics read the wrong file for background-dispatched subagents
// @see .claude/hooks/transcript.ts — resolveTranscriptCandidates (mt#2637 / PR #1806)

import { existsSync } from "node:fs";
import { join } from "node:path";
import { readInput } from "./types";
import type { StopHookInput } from "./types";
import { resolveTranscriptCandidates } from "./transcript";

// ---------------------------------------------------------------------------
// Main entrypoint
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const input = await readInput<StopHookInput>();

  try {
    await recordInvocation(input);
  } catch (err) {
    process.stderr.write(
      `[record-subagent-invocation] warn: unexpected top-level error: ${err instanceof Error ? err.message : String(err)}\n`
    );
  }

  process.exit(0);
}

// ---------------------------------------------------------------------------
// Metrics-transcript resolution (mt#2649)
// ---------------------------------------------------------------------------

/**
 * Resolve the transcript file to read metrics from for a given subagent.
 *
 * Background-Agent-dispatched subagents receive a `transcript_path` pointing
 * at the PARENT session's top-level transcript (`<session-id>.jsonl`), while
 * the subagent's own tool_use/usage lines live at
 * `<session-dir>/subagents/agent-<agentId>.jsonl` (mt#2637 diagnosis). Passing
 * the parent path straight to `readTranscriptMetrics` reads the wrong file and
 * yields null/incorrect `toolUseCount` / `totalTokens` / `durationMs`.
 *
 * Reuses {@link resolveTranscriptCandidates} (mt#2637 / PR #1806) to derive the
 * candidate set, then prefers the precise `agent-<agentId>.jsonl` file when it
 * exists on disk. Falls back to the given `transcriptPath` when no such file
 * exists (main-thread invocations, or a harness build where `transcript_path`
 * is already per-agent-correct) — `readTranscriptMetrics` is fail-safe on a
 * missing/unreadable file either way, and the caller still passes `agentId`
 * through so the `agent_session_id` line-filter is preserved on whichever
 * file is ultimately read.
 *
 * Exported for testing.
 */
export function resolveMetricsTranscriptPath(
  transcriptPath: string | undefined,
  agentId: string
): string | undefined {
  if (!transcriptPath) return transcriptPath;
  const perAgentFile = `agent-${agentId}.jsonl`;
  const candidates = resolveTranscriptCandidates(transcriptPath, agentId);
  // Match the directory-qualified per-agent path (R1: stricter than a bare
  // basename match, which could pair with a similarly-named candidate from an
  // adjacent tree if the candidate set ever widens beyond this session).
  const perAgentSuffix = join("subagents", perAgentFile);
  const perAgentPath = candidates.find((candidate) => candidate.endsWith(perAgentSuffix));
  return perAgentPath && existsSync(perAgentPath) ? perAgentPath : transcriptPath;
}

// ---------------------------------------------------------------------------
// Core logic
// ---------------------------------------------------------------------------

async function recordInvocation(input: StopHookInput): Promise<void> {
  const agentId = input.agent_id;
  const cwd = input.cwd;
  const transcriptPath = input.transcript_path;

  if (!agentId) {
    // No agent_id means this is the main agent's Stop, not a SubagentStop.
    // The hook is registered under SubagentStop, so this shouldn't happen,
    // but guard defensively.
    return;
  }

  // 1. Derive task ID from the workspace path.
  //    Session directories are named after the session ID, not the task ID.
  //    We query the Minsky DB via the session record to get the task ID.
  const taskId = await resolveTaskId(cwd);
  if (!taskId) {
    process.stderr.write(
      `[record-subagent-invocation] warn: could not resolve taskId for cwd=${cwd}\n`
    );
    // Still record with a placeholder — the dispatch row was written at dispatch
    // time with the real taskId; we upsert on subagentSessionId so we need it.
    return;
  }

  // 2. Classify workspace outcome.
  const { classifyWorkspaceOutcome } = await import(
    "../../packages/domain/src/subagent/workspace-classifier"
  );
  const classification = await classifyWorkspaceOutcome(cwd, taskId);

  // 3. Read transcript metrics (best-effort).
  const { readTranscriptMetrics } = await import(
    "../../packages/domain/src/subagent/transcript-metrics"
  );
  const resolvedTranscriptPath = resolveMetricsTranscriptPath(transcriptPath, agentId);
  const metrics = await readTranscriptMetrics(resolvedTranscriptPath, agentId);

  // 4. Open a DB connection and record the invocation.
  const { resolvePersistenceProvider } = await import(
    "../../packages/domain/src/persistence/factory"
  );
  const provider = await resolvePersistenceProvider();
  if (!provider || !("getDatabaseConnection" in provider)) {
    process.stderr.write(
      `[record-subagent-invocation] warn: persistence provider unavailable — skipping DB write\n`
    );
    return;
  }

  let db: import("drizzle-orm/postgres-js").PostgresJsDatabase | null = null;
  try {
    db = (await (
      provider as {
        getDatabaseConnection(): Promise<import("drizzle-orm/postgres-js").PostgresJsDatabase>;
      }
    ).getDatabaseConnection()) as import("drizzle-orm/postgres-js").PostgresJsDatabase;
  } catch (err) {
    process.stderr.write(
      `[record-subagent-invocation] warn: getDatabaseConnection failed: ${err instanceof Error ? err.message : String(err)}\n`
    );
  }

  if (!db) {
    try {
      await provider.close();
    } catch {
      /* ignore */
    }
    return;
  }

  const { SubagentDispatchTracker } = await import("../../src/mcp/subagent-dispatch-tracker");
  const tracker = new SubagentDispatchTracker(db);

  const now = new Date();

  // PR #1053 R1 BLOCKING #1: the upsert correlation key is the SUBAGENT's
  // Minsky session id (NOT the harness agent_id), which is encoded in the
  // last segment of the cwd path. Dispatch wrote the pending row with
  // `subagentSessionId = <subagent's Minsky session id>`; we must use the
  // same key here for the upsert to find that row.
  //
  // The harness agent_id is stored separately as `agentSessionId` (joins
  // `agent_transcripts.agent_session_id` per mt#1313).
  //
  // PR #1053 R1 BLOCKING #2: pre-query for the dispatch-time row. If it
  // exists, omit `agentType` from our upsert payload so the tracker's
  // update path leaves the dispatch-time value untouched. If it doesn't
  // exist (orphan Stop without dispatch, dispatch-write failure), include
  // a placeholder so the INSERT path satisfies the schema's NOT NULL
  // constraint on `agent_type`.
  const subagentSessionId = extractMinskySessionId(cwd);

  await tracker.recordSubagentInvocation({
    taskId,
    subagentSessionId,
    agentSessionId: agentId, // harness-native conversation UUID
    outcome: classification.outcome,
    prUrl: classification.prUrl ?? null,
    lastCommitHash: classification.lastCommitHash ?? null,
    handoffWritten: classification.handoffWritten,
    toolUseCount: metrics.toolUseCount ?? null,
    totalTokens: metrics.totalTokens ?? null,
    durationMs: metrics.durationMs ?? null,
    endedAt: now,
    startedAt: now, // tracker preserves startedAt on upsert (per mt#1736 R1 fix)
    // agentType is required by SubagentInvocationInput (NOT NULL). For the
    // UPDATE path this may clobber the dispatch-set value, but "unknown" is
    // the fallback for hooks that lack the original dispatch context.
    agentType: "unknown",
  });

  try {
    await provider.close();
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// Minsky session id extraction
// ---------------------------------------------------------------------------

/**
 * Extract the subagent's Minsky session id from the cwd path.
 *
 * Session workspaces are stored at `~/.local/state/minsky/sessions/<sessionId>`.
 * The session id is a UUID; we take the last non-empty path segment.
 *
 * Used as the upsert correlation key by `recordSubagentInvocation` — both
 * dispatch-time and SubagentStop-time writes resolve to the same session id
 * so the upsert finds the pending row.
 *
 * Returns null if the cwd doesn't have an extractable session id (e.g.,
 * empty, no sessions/ segment).
 */
function extractMinskySessionId(cwd: string | undefined): string | null {
  if (!cwd) return null;
  const match = cwd.match(/\/sessions\/([^/]+)(?:\/|$)/);
  return match?.[1] ?? null;
}

// ---------------------------------------------------------------------------
// Task ID resolution
// ---------------------------------------------------------------------------

/**
 * Derive a task ID from the subagent's cwd.
 *
 * Strategy:
 *   1. Check if the cwd path contains a session ID segment matching a known
 *      Minsky session. Query the DB to get the task ID for that session.
 *   2. Fall back to extracting the task ID from the cwd basename if it looks
 *      like a task-named directory (e.g., `task/mt-1737`).
 *
 * Returns null when the task ID cannot be determined.
 */
async function resolveTaskId(cwd: string): Promise<string | null> {
  if (!cwd) return null;

  // Strategy 1: Try to load the session record by session directory path.
  // Session workspaces are stored in ~/.local/state/minsky/sessions/<sessionId>.
  try {
    const { resolvePersistenceProvider } = await import(
      "../../packages/domain/src/persistence/factory"
    );
    const provider = await resolvePersistenceProvider();
    if (provider) {
      try {
        const { createSessionProvider } = await import(
          "../../packages/domain/src/session/drizzle-session-repository"
        );
        // eslint-disable-next-line custom/no-singleton-reach-in -- hook bootstrap: the provider is passed via arg (DI), not reached-in
        const sessionProvider = await createSessionProvider(undefined, provider);
        const sessions = await sessionProvider.listSessions();
        for (const rec of sessions) {
          if (typeof rec.taskId === "string") {
            // Check if cwd is under this session's directory
            const sessionId = rec.sessionId ?? "";
            if (sessionId && cwd.includes(sessionId)) {
              // The `finally` below closes the provider — no inner close (would
              // double-close + mask close-time errors; PR #1625 R1 NON-BLOCKING).
              return rec.taskId;
            }
          }
        }
      } finally {
        try {
          await provider.close();
        } catch {
          /* ignore */
        }
      }
    }
  } catch {
    // Fall through to heuristic
  }

  // Strategy 2: Extract session ID from cwd and match to task via git remote.
  // Minsky session directories follow: ~/.local/state/minsky/sessions/<sessionId>
  // The git remote URL contains the task branch: task/mt-<id>
  try {
    const result = Bun.spawnSync(["git", "rev-parse", "--abbrev-ref", "HEAD"], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (result.exitCode === 0) {
      const branch = result.stdout.toString().trim();
      // Branch format: task/mt-1737 or task/mt#1737
      const match = branch.match(/^task\/mt[-#](\d+)$/);
      if (match) {
        return `mt#${match[1]}`;
      }
    }
  } catch {
    // ignore
  }

  return null;
}
