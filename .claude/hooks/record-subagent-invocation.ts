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

import { readInput } from "./types";
import type { StopHookInput } from "./types";

// ---------------------------------------------------------------------------
// Main entrypoint
// ---------------------------------------------------------------------------

const input = await readInput<StopHookInput>();

try {
  await recordInvocation(input);
} catch (err) {
  process.stderr.write(
    `[record-subagent-invocation] warn: unexpected top-level error: ${err instanceof Error ? err.message : String(err)}\n`
  );
}

process.exit(0);

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
    "../../src/domain/subagent/workspace-classifier"
  );
  const classification = await classifyWorkspaceOutcome(cwd, taskId);

  // 3. Read transcript metrics (best-effort).
  const { readTranscriptMetrics } = await import("../../src/domain/subagent/transcript-metrics");
  const metrics = await readTranscriptMetrics(transcriptPath, agentId);

  // 4. Open a DB connection and record the invocation.
  const { resolvePersistenceProvider } = await import("../../src/domain/persistence/factory");
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

  await tracker.recordSubagentInvocation({
    taskId,
    agentType: "general-purpose", // Harness doesn't expose agentType at SubagentStop; the dispatch-time row has it
    subagentSessionId: agentId,
    agentSessionId: agentId,
    outcome: classification.outcome,
    prUrl: classification.prUrl ?? null,
    lastCommitHash: classification.lastCommitHash ?? null,
    handoffWritten: classification.handoffWritten,
    toolUseCount: metrics.toolUseCount ?? null,
    totalTokens: metrics.totalTokens ?? null,
    durationMs: metrics.durationMs ?? null,
    endedAt: now,
    startedAt: now, // startedAt will be preserved by upsert logic (not overwritten when row exists)
  });

  try {
    await provider.close();
  } catch {
    /* ignore */
  }
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
    const { resolvePersistenceProvider } = await import("../../src/domain/persistence/factory");
    const provider = await resolvePersistenceProvider();
    if (provider) {
      try {
        const storage = provider.getStorage();
        const sessions = await storage.getEntities();
        if (Array.isArray(sessions)) {
          for (const s of sessions) {
            if (s && typeof s === "object" && "taskId" in s && typeof s.taskId === "string") {
              const rec = s as { taskId: string; sessionId?: string };
              // Check if cwd is under this session's directory
              const sessionId = rec.sessionId ?? "";
              if (sessionId && cwd.includes(sessionId)) {
                await provider.close();
                return rec.taskId;
              }
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
