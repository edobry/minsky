/**
 * Session Apply-Post-Merge-State-Sync Command
 *
 * MCP tool wrapper for `applyPostMergeStateSync` (session-merge-operations.ts).
 * Registered as `session.apply_post_merge_state_sync` so the webhook handler
 * in services/reviewer/src/server.ts can call it by tool ID.
 *
 * This is the canonical state-sync entry point for all non-session_pr_merge
 * merge paths: GitHub-UI merges, bypass-merges via `gh api PUT /merge`, and
 * the sweeper backstop.
 */
import { z } from "zod";
import { CommandCategory, type CommandDefinition } from "../../command-registry";
import { type LazySessionDeps, withErrorLogging } from "./types";
import type { SessionCommandDependencies } from "./types";
import type { PostMergeStateSyncParams } from "../../../../domain/session/session-merge-operations";

/**
 * Parameter schema for the session.apply_post_merge_state_sync MCP tool.
 *
 * Either `sessionId` or `task` must be provided so the handler can resolve
 * which session to sync. `task` is the idiomatic choice from the webhook path
 * (which extracts a task ID from the branch name `task/mt-N`).
 */
export const applyPostMergeStateSyncCommandParams = {
  sessionId: {
    schema: z.string(),
    description: "Session ID to sync (resolved from task if omitted)",
    required: false,
  },
  task: {
    schema: z.string(),
    description:
      "Task ID whose session should be synced (e.g. 'mt#123'). Used when sessionId is unknown.",
    required: false,
  },
  mergeSha: {
    schema: z.string(),
    description: "Merge commit SHA for audit log and PR record sync",
    required: false,
  },
  mergedAt: {
    schema: z.string(),
    description: "ISO-8601 timestamp of the merge event (defaults to now)",
    required: false,
  },
  cleanupSession: {
    schema: z.boolean(),
    description:
      "Whether to run workspace cleanup after state update (default: true). " +
      "Pass false to preserve session files (e.g. for debugging).",
    required: false,
    defaultValue: true,
  },
  trigger: {
    schema: z.string(),
    description:
      "Audit attribution string — which path triggered this sync. " +
      "One of: 'session_pr_merge' | 'webhook' | 'sweeper' | 'repair_pass'. " +
      "Defaults to 'unknown'.",
    required: false,
    defaultValue: "unknown",
  },
};

/**
 * Resolve a session ID from command params, looking up by task ID if needed.
 *
 * Exported for unit testing without module mocks.
 */
export async function resolveSessionIdFromParams(
  params: Record<string, unknown>,
  deps: Pick<SessionCommandDependencies, "sessionProvider">
): Promise<string> {
  const sessionId = params.sessionId as string | undefined;
  const taskId = params.task as string | undefined;

  if (!sessionId && !taskId) {
    throw new Error("Either sessionId or task must be provided to apply_post_merge_state_sync");
  }

  if (sessionId) {
    return sessionId;
  }

  // Look up the session for this task ID.
  const sessions = await deps.sessionProvider.listSessions();
  const match = sessions.find((s: { taskId?: string }) => s.taskId === taskId);
  if (!match) {
    throw new Error(`No session found for task ${taskId} — cannot run post-merge state sync`);
  }
  return (match as { sessionId: string }).sessionId;
}

/**
 * Build the PostMergeStateSyncParams from raw command params + a resolved sessionId.
 *
 * Exported for unit testing without module mocks.
 */
export function buildPostMergeStateSyncParams(
  resolvedSessionId: string,
  params: Record<string, unknown>
): PostMergeStateSyncParams {
  return {
    sessionId: resolvedSessionId,
    mergeSha: params.mergeSha as string | undefined,
    mergedAt: params.mergedAt as string | undefined,
    cleanupSession: params.cleanupSession as boolean | undefined,
    trigger: (params.trigger as string | undefined) ?? "unknown",
  };
}

export function createApplyPostMergeStateSyncCommand(getDeps: LazySessionDeps): CommandDefinition {
  return {
    id: "session.apply_post_merge_state_sync",
    category: CommandCategory.SESSION,
    name: "apply_post_merge_state_sync",
    description:
      "Apply all post-merge state changes to a Minsky session: " +
      "task IN-REVIEW → DONE, session status PR_OPEN → MERGED, lastActivityAt update, " +
      "pullRequest record sync, and optional workspace cleanup. " +
      "Idempotent — safe to call multiple times for the same merge event.",
    parameters: applyPostMergeStateSyncCommandParams,
    mutating: true,
    execute: withErrorLogging(
      "session.apply_post_merge_state_sync",
      async (params: Record<string, unknown>) => {
        const { applyPostMergeStateSync } = await import(
          "../../../../domain/session/session-merge-operations"
        );
        const { log } = await import("../../../../utils/logger");
        const deps = await getDeps();

        const resolvedSessionId = await resolveSessionIdFromParams(params, deps);
        log.debug(`apply_post_merge_state_sync: resolved sessionId=${resolvedSessionId}`, {
          task: params.task,
          trigger: params.trigger,
        });

        const syncParams = buildPostMergeStateSyncParams(resolvedSessionId, params);
        const result = await applyPostMergeStateSync(syncParams, {
          sessionDB: deps.sessionProvider,
          taskService: deps.taskService,
        });

        return {
          success: true,
          sessionId: result.sessionId,
          taskId: result.taskId,
          taskStatusUpdated: result.taskStatusUpdated,
          sessionStatusUpdated: result.sessionStatusUpdated,
          pullRequestRecordUpdated: result.pullRequestRecordUpdated,
          // mt#1841: propagate partial-failure error fields so the webhook handler
          // (and other MCP callers) can detect when (a) or (b/c/d) silently failed.
          taskUpdateError: result.taskUpdateError,
          sessionUpdateError: result.sessionUpdateError,
          sessionCleanup: result.sessionCleanup,
        };
      }
    ),
  };
}
