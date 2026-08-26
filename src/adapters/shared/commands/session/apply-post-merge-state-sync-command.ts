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
import type { PostMergeStateSyncParams } from "@minsky/domain/session/session-merge-operations";
import { TASK_STATUS } from "@minsky/domain/tasks/taskConstants";

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
    description:
      "Session ID to sync (resolved from task if omitted) — accepts the uuid, a " +
      "`ws#N` short id (mt#2967), an 8+ char hex prefix of the uuid, or a legacy " +
      "custom session name.",
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
 * Returns `null` — rather than throwing — when the caller supplied `task` AND
 * `mergeSha` but no session row exists (mt#4403). That is the REPAIR case, and
 * it is the one this tool was most needed for and could not serve: cleanup is
 * part of the post-merge state set this command applies, so any ordering where
 * cleanup lands and the task-status write does not leaves a task stranded at
 * IN-REVIEW with the session record — the only key every recovery path resolves
 * through — already deleted. Observed 2026-08-21 on mt#4299, repaired by hand
 * with the `tasks_status_set` that `task-status-workflow-protocol` tells agents
 * never to use, because it was the only move left.
 *
 * The conjunction is deliberate. `task` with no session and NO `mergeSha` keeps
 * throwing the original message: without a merge SHA there is nothing to verify
 * the repair against, and a repair path that trusts the caller's word about a
 * merge is worse than the gap it closes.
 *
 * Exported for unit testing without module mocks.
 */
export async function resolveSessionIdFromParams(
  params: Record<string, unknown>,
  deps: Pick<SessionCommandDependencies, "sessionProvider">
): Promise<string | null> {
  const sessionId = params.sessionId as string | undefined;
  const taskId = params.task as string | undefined;
  const mergeSha = params.mergeSha as string | undefined;

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
    if (mergeSha) {
      // Repair case: no session row, but a merge SHA to verify against.
      return null;
    }
    throw new Error(
      `No session found for task ${taskId} — cannot run post-merge state sync. ` +
        `If the session was already cleaned up and you are repairing a stranded task, ` +
        `pass mergeSha so the merge can be verified before the status is written.`
    );
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

/**
 * Outcome of a stranded-task repair attempt (mt#4403).
 *
 * `repaired: false` is NOT an error — it is the guard doing its job, and
 * `refusedReason` says which one. Callers must be able to tell "repaired" from
 * "declined to repair" without inspecting a message, which is why this is a
 * discriminated result rather than a thrown error for the refusal paths.
 */
export interface StrandedTaskRepairResult {
  repaired: boolean;
  taskId: string;
  previousStatus?: string;
  refusedReason?: string;
}

export interface StrandedTaskRepairDeps {
  getTaskStatus: (taskId: string) => Promise<string | undefined>;
  setTaskStatus: (taskId: string, status: string) => Promise<unknown>;
  /**
   * True iff `mergeSha` belongs to a pull request that is actually MERGED.
   * Injected rather than reached for, so the guard can be tested against both
   * answers without patching a forge client the function would otherwise
   * import itself.
   */
  isMergedCommit: (mergeSha: string) => Promise<boolean>;
  /**
   * Audit sink. RFC "Configurable task state machines and cross-backend status
   * reconciliation" (Accepted 2026-07-21) Rule 3: "The reconcile path emits an
   * audit event on every use, and its use rate is a health signal with an
   * owner." Every RETURN below records, including the refusals — a reconcile
   * path that only counted its successes would under-report exactly when it is
   * misbehaving.
   */
  recordReconcile: (entry: {
    taskId: string;
    mergeSha: string;
    trigger: string;
    outcome: "repaired" | "refused-not-merged" | "refused-wrong-status" | "already-done";
    previousStatus?: string;
  }) => Promise<void>;
}

/**
 * Repair a task stranded at IN-REVIEW whose session record is already gone
 * (mt#4403).
 *
 * This is the RFC's `reconcile` write path: it "may set a status regardless of
 * graph reachability, but the semantic integrity guards still apply." The graph
 * bypass is the point — there is no session left to walk the normal transition
 * through. The guards are what keep that from being a blank cheque:
 *
 *  1. **The PR must actually be merged.** A repair tool that sets DONE on the
 *     caller's word is worse than the stranding it fixes, because a stranded
 *     task is visible and a wrongly-DONE task is not.
 *  2. **The task must be at IN-REVIEW.** Writing DONE over BLOCKED or TODO
 *     would be the reconcile path corrupting state rather than repairing it.
 *     Already-DONE returns cleanly — the tool's own description promises it is
 *     "idempotent, safe to call multiple times for the same merge event", and
 *     that promise is only now true for the state it is actually called in.
 *
 * Order matters: merge verification runs FIRST, so a caller with a bogus SHA is
 * refused before the task is read at all.
 */
export async function repairStrandedTask(
  args: { taskId: string; mergeSha: string; trigger: string },
  deps: StrandedTaskRepairDeps
): Promise<StrandedTaskRepairResult> {
  const { taskId, mergeSha, trigger } = args;

  const merged = await deps.isMergedCommit(mergeSha);
  if (!merged) {
    const refusedReason =
      `Refusing to repair ${taskId}: commit ${mergeSha} does not belong to a merged ` +
      `pull request. The task's status is unchanged.`;
    await deps.recordReconcile({ taskId, mergeSha, trigger, outcome: "refused-not-merged" });
    return { repaired: false, taskId, refusedReason };
  }

  const previousStatus = await deps.getTaskStatus(taskId);

  if (previousStatus === TASK_STATUS.DONE) {
    await deps.recordReconcile({
      taskId,
      mergeSha,
      trigger,
      outcome: "already-done",
      previousStatus,
    });
    return { repaired: false, taskId, previousStatus, refusedReason: undefined };
  }

  if (previousStatus !== TASK_STATUS.IN_REVIEW) {
    const refusedReason =
      `Refusing to repair ${taskId}: expected status IN-REVIEW but found ` +
      `${previousStatus ?? "none"}. The reconcile path repairs a stranded review, ` +
      `it does not force DONE from an arbitrary state.`;
    await deps.recordReconcile({
      taskId,
      mergeSha,
      trigger,
      outcome: "refused-wrong-status",
      previousStatus,
    });
    return { repaired: false, taskId, previousStatus, refusedReason };
  }

  await deps.setTaskStatus(taskId, TASK_STATUS.DONE);
  await deps.recordReconcile({
    taskId,
    mergeSha,
    trigger,
    outcome: "repaired",
    previousStatus,
  });
  return { repaired: true, taskId, previousStatus };
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
          "@minsky/domain/session/session-merge-operations"
        );
        const { log } = await import("@minsky/shared/logger");
        const deps = await getDeps();

        const resolvedSessionId = await resolveSessionIdFromParams(params, deps);

        if (resolvedSessionId === null) {
          // mt#4403 repair path: the session record is gone, so there is nothing
          // for applyPostMergeStateSync to resolve. Repair the task directly,
          // behind the guards in repairStrandedTask.
          const taskId = params.task as string;
          const mergeSha = params.mergeSha as string;
          const trigger = (params.trigger as string | undefined) ?? "unknown";

          log.debug(`apply_post_merge_state_sync: no session for ${taskId} — repair path`, {
            mergeSha,
            trigger,
          });

          const repair = await repairStrandedTask(
            { taskId, mergeSha, trigger },
            {
              getTaskStatus: (id) => deps.taskService.getTaskStatus(id),
              setTaskStatus: (id, status) => deps.taskService.setTaskStatus(id, status),
              isMergedCommit: async (sha) => {
                const backend = await deps.getRepositoryBackend();
                if (!backend.github) {
                  throw new Error(
                    `Cannot verify merge for ${taskId}: repository backend is ` +
                      `${backend.backendType}, which exposes no pull-request API. ` +
                      `Refusing rather than assuming the merge happened.`
                  );
                }
                const { getConfiguration } = await import("@minsky/domain/configuration/index");
                const { Octokit } = await import("@octokit/rest");
                const { createTimeoutFetch } = await import(
                  "@minsky/domain/github/octokit-timeout"
                );
                const githubToken = getConfiguration().github.token;
                if (!githubToken) {
                  throw new Error(
                    `Cannot verify merge for ${taskId}: no GitHub token configured. ` +
                      `Refusing rather than assuming the merge happened.`
                  );
                }
                const octokit = new Octokit({
                  auth: githubToken,
                  request: { fetch: createTimeoutFetch() },
                });
                // Ask GitHub which PRs this commit belongs to, then require one
                // to be genuinely merged. `merged_at` is the field that answers
                // it — `state: "closed"` is also true for a PR closed WITHOUT
                // merging, which is precisely the case this guard exists to
                // refuse.
                const { data: associated } =
                  await octokit.rest.repos.listPullRequestsAssociatedWithCommit({
                    owner: backend.github.owner,
                    repo: backend.github.repo,
                    commit_sha: sha,
                  });
                return associated.some((pr) => pr.merged_at != null);
              },
              recordReconcile: async (entry) => {
                // Best-effort, per the emit contract everywhere else in this
                // codebase: an audit-write failure must not change whether the
                // repair happened.
                const { resolvePersistenceProvider } = await import(
                  "@minsky/domain/persistence/factory"
                );
                const { emitSystemEventFromProvider } = await import(
                  "@minsky/domain/events/emit-best-effort"
                );
                const provider = await resolvePersistenceProvider();
                await emitSystemEventFromProvider(provider ?? undefined, {
                  eventType: "task.status_changed",
                  payload: {
                    taskId: entry.taskId,
                    previousStatus: entry.previousStatus ?? null,
                    newStatus: entry.outcome === "repaired" ? TASK_STATUS.DONE : undefined,
                    // The reconcile marker. RFC Rule 3's use-rate counter is a
                    // query over these: `via = "reconcile"` grouped by outcome.
                    via: "reconcile",
                    reconcileOutcome: entry.outcome,
                    mergeSha: entry.mergeSha,
                    trigger: entry.trigger,
                  },
                  relatedTaskId: entry.taskId,
                });
              },
            }
          );

          if (repair.refusedReason) {
            throw new Error(repair.refusedReason);
          }

          return {
            success: true,
            sessionId: undefined,
            taskId: repair.taskId,
            taskStatusUpdated: repair.repaired,
            sessionStatusUpdated: false,
            pullRequestRecordUpdated: false,
            taskUpdateError: undefined,
            sessionUpdateError: undefined,
            partialFailure: false,
            sessionCleanup: undefined,
            // Distinguishes this from the ordinary path for any caller that
            // needs to know a reconcile write happened rather than a sync.
            repairedWithoutSessionRecord: true,
            previousStatus: repair.previousStatus,
          };
        }

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
          // PR #1121 R1 NON-BLOCKING #5: derive success from absence of error
          // fields. Previously this was always `true` regardless of whether
          // applyPostMergeStateSync reported partial failure, which let
          // downstream consumers gating only on `success` treat partial
          // failures as success.
          success: result.taskUpdateError === undefined && result.sessionUpdateError === undefined,
          sessionId: result.sessionId,
          taskId: result.taskId,
          taskStatusUpdated: result.taskStatusUpdated,
          sessionStatusUpdated: result.sessionStatusUpdated,
          pullRequestRecordUpdated: result.pullRequestRecordUpdated,
          // mt#1841: propagate partial-failure error fields so the webhook handler
          // (and other MCP callers) can detect when (a) or (b/c/d) silently failed.
          taskUpdateError: result.taskUpdateError,
          sessionUpdateError: result.sessionUpdateError,
          // PR #1121 R1 BLOCKING #3: top-level partialFailure for consumers that
          // need a single boolean signal.
          partialFailure: result.partialFailure,
          sessionCleanup: result.sessionCleanup,
        };
      }
    ),
  };
}
