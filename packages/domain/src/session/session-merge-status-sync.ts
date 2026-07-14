/**
 * Session Merge Status Sync (mt#2614)
 *
 * Extracted from session-merge-operations.ts, where this was one of three
 * mixed concerns (conflict detection / cleanup / status-update) in a
 * 1,426-line file. This module owns the status-update concern: applying
 * the five idempotent post-merge state changes (task status, session
 * status, PR record, workspace cleanup) shared across every merge-completion
 * trigger (in-band session_pr_merge, webhook, sweeper, repair pass).
 */

import { log } from "@minsky/shared/logger";
import { type SessionProviderInterface } from "./types";
import type { TaskServiceInterface } from "../tasks/taskService";
import { TASK_STATUS } from "../tasks/taskConstants";
import { getErrorMessage } from "../errors";
import { SessionStatus } from "./types";
import { cleanupSessionImpl } from "./session-lifecycle-operations";
import { existsSync, rmSync } from "node:fs";
import { getSessionsDir } from "@minsky/shared/paths";

// ---------------------------------------------------------------------------
// Post-merge state sync (extracted for reuse across all merge paths)
// ---------------------------------------------------------------------------

/**
 * Parameters for applyPostMergeStateSync.
 * All fields optional except sessionId — the function is called from both
 * the session_pr_merge path (where taskId is known) and the webhook/sweeper
 * path (where taskId is resolved from the session record).
 */
export interface PostMergeStateSyncParams {
  /** The session to update. */
  sessionId: string;
  /** Merge commit SHA (for audit + PR record sync). */
  mergeSha?: string;
  /** ISO timestamp of the merge (from GitHub event or detected). */
  mergedAt?: string;
  /**
   * Whether to run workspace cleanup after state update.
   * Default: true (matches session_pr_merge behavior).
   */
  cleanupSession?: boolean;
  /**
   * Which trigger fired this sync, for audit attribution.
   * One of: "session_pr_merge" | "webhook" | "sweeper" | "repair_pass"
   */
  trigger?: string;
}

/** Dependencies for applyPostMergeStateSync — same interface as SessionMergeDependencies. */
export interface PostMergeStateSyncDeps {
  sessionDB: SessionProviderInterface;
  taskService: TaskServiceInterface;
}

/** Result of applyPostMergeStateSync. */
export interface PostMergeStateSyncResult {
  sessionId: string;
  taskId?: string;
  /**
   * Indicates whether the effect was actually written to the DB on this
   * invocation. Three-way semantics (mt#1841):
   *
   * - `true` + no error: this invocation wrote the effect.
   * - `false` + no corresponding error: no-op success (the value was already
   *   in the target state — e.g., session already MERGED, task already DONE).
   * - `false` + corresponding error: the write was attempted but failed (the
   *   error field carries the underlying message).
   *
   * Callers that need to know "did the effect land?" should consult
   * `partialFailure` (true iff any error field is populated), not the flag
   * alone. See PR #1121 R1 BLOCKING #3.
   */
  taskStatusUpdated: boolean;
  /**
   * The terminal status the task was (or already) at — DONE for all kinds
   * since mt#2311 collapsed the per-kind terminals (mt#1872's kind dispatch
   * is retired). Undefined when no task is associated. Retained so callers
   * keep an explicit record of the applied terminal.
   */
  taskTerminalStatus?: string;
  sessionStatusUpdated: boolean;
  pullRequestRecordUpdated: boolean;
  /**
   * Populated when effect (a) (task status update) failed at the DB layer. mt#1841.
   * Undefined when the update succeeded OR the function decided no update was needed.
   * Callers (webhook handler, sweeper) should check this to detect partial failure;
   * the sweeper backstop will catch the missed effects on its next cycle (mt#1752).
   */
  taskUpdateError?: string;
  /**
   * Populated when effects (b)/(c)/(d) (session.status, lastActivityAt, pullRequest
   * record) failed at the DB layer. mt#1841. Undefined when the update succeeded OR
   * the function decided no update was needed.
   *
   * Originating incident: mt#1813 (PR #1101, bypass-merged 2026-05-13T14:54Z) had
   * task=DONE within minutes but session.status stayed at PR_OPEN until manually
   * synced ~21h later. The catch block at session-merge-status-sync.ts:204-210 logged
   * the error but the result reported success because the flags were set
   * optimistically BEFORE the await. This field makes partial failure visible to
   * callers.
   */
  sessionUpdateError?: string;
  /**
   * True iff `taskUpdateError` OR `sessionUpdateError` is populated — the
   * single boolean a caller can read to decide whether to retry/escalate
   * without needing to disambiguate flag semantics. Computed by the function
   * before returning, so callers don't have to derive it themselves
   * (PR #1121 R1 BLOCKING #3).
   */
  partialFailure: boolean;
  sessionCleanup?: {
    performed: boolean;
    directoriesRemoved: string[];
    errors: string[];
  };
}

/**
 * Apply all five post-merge state changes to a Minsky session, idempotently.
 *
 * This function is the canonical implementation of the post-merge state-sync.
 * It is invoked from:
 *   - `mergeSessionPr` (the session_pr_merge path — was previously inline)
 *   - The webhook handler for pull_request.closed && merged=true
 *   - The merge-state sweeper backstop
 *   - The one-shot repair pass script
 *
 * The five effects:
 *   (a) Task status: IN-REVIEW → DONE (idempotent — skips if already DONE).
 *   (b) Session.status: → MERGED (idempotent — skips if already MERGED).
 *   (c) Session.lastActivityAt: updated to mergedAt (or now).
 *   (d) Session.pullRequest record: state="closed", merged=true, mergedAt, mergeSha, lastSynced.
 *   (e) Session workspace cleanup (same cleanupSessionImpl used by session_pr_merge).
 *
 * TOCTOU analysis (§7b):
 *   - Read atomicity: task status read + action in separate calls. Accept — idempotent; both
 *     session_pr_merge and webhook fire for the same merge event; re-running produces same state.
 *   - Decision-action gap: between reading task status and writing DONE, status can change.
 *     Accept — idempotent; writing DONE when already DONE is a no-op; writing DONE over a
 *     different status (e.g., BLOCKED) is corrected by the next tool invocation and is observable.
 *   - Stale-read: session record read is from DB at call time; no cache. Accept — fresh DB read.
 *
 * @param params - sync parameters
 * @param deps - injected dependencies (sessionDB, taskService)
 */
export async function applyPostMergeStateSync(
  params: PostMergeStateSyncParams,
  deps: PostMergeStateSyncDeps
): Promise<PostMergeStateSyncResult> {
  const { sessionId, mergeSha, cleanupSession = true, trigger = "unknown" } = params;
  const mergedAt = params.mergedAt ?? new Date().toISOString();
  const { sessionDB, taskService } = deps;

  log.debug("applyPostMergeStateSync called", { sessionId, mergeSha, mergedAt, trigger });

  // Fetch current session record (fresh read — no cache).
  const sessionRecord = await sessionDB.getSession(sessionId);
  if (!sessionRecord) {
    // Session DB record is already gone — likely removed by a concurrent call
    // (e.g., webhook fired and completed cleanup before session_pr_merge reached
    // this function). This is the mt#1941 ordering bug: the atomic merge triggers
    // a webhook which runs applyPostMergeStateSync first, deleting the DB record,
    // and then mergeSessionPr calls this function and finds the record missing.
    //
    // Best-effort workspace cleanup: derive the dir from the UUID directly
    // (path = getSessionsDir()/<uuid>) and remove it if it still exists.
    // This prevents the workspace from being orphaned on disk when the DB
    // record is already gone.
    const workspaceDir = `${getSessionsDir()}/${sessionId}`;
    const cleanupPerformed = existsSync(workspaceDir);
    let cleanupError: string | undefined;
    if (cleanupSession && cleanupPerformed) {
      try {
        rmSync(workspaceDir, { recursive: true, force: true });
        log.info(
          `applyPostMergeStateSync: session "${sessionId}" not in DB — cleaned up orphaned workspace dir`,
          { workspaceDir, trigger }
        );
      } catch (err) {
        cleanupError = `Failed to remove orphaned workspace dir ${workspaceDir}: ${getErrorMessage(err)}`;
        log.error(cleanupError, { sessionId, trigger });
      }
    } else {
      log.debug(
        `applyPostMergeStateSync: session "${sessionId}" not in DB (already cleaned up by concurrent call)`,
        { trigger, workspaceDir, dirExists: cleanupPerformed }
      );
    }

    // Return an all-false result: DB effects are no-ops (record gone), but
    // sessionCleanup reflects what happened to the workspace dir.
    return {
      sessionId,
      taskId: undefined,
      taskStatusUpdated: false,
      sessionStatusUpdated: false,
      pullRequestRecordUpdated: false,
      partialFailure: false,
      ...(cleanupSession
        ? {
            sessionCleanup: {
              performed: cleanupPerformed && !cleanupError,
              directoriesRemoved: cleanupPerformed && !cleanupError ? [workspaceDir] : [],
              errors: cleanupError ? [cleanupError] : [],
            },
          }
        : {}),
    };
  }

  const taskId = sessionRecord.taskId;
  const result: PostMergeStateSyncResult = {
    sessionId,
    taskId,
    taskStatusUpdated: false,
    sessionStatusUpdated: false,
    pullRequestRecordUpdated: false,
    partialFailure: false,
  };

  // (a) Task status: post-merge terminal-state transition. Since mt#2311
  // collapsed the workflows to a single success terminal, the target is DONE
  // for every kind — mt#1872's kind dispatch (umbrella → COMPLETED) is
  // retired along with the COMPLETED state itself.
  if (taskId && taskService.setTaskStatus && taskService.getTaskStatus) {
    try {
      const currentStatus = await taskService.getTaskStatus(taskId);
      const targetStatus = TASK_STATUS.DONE;
      result.taskTerminalStatus = targetStatus;

      if (currentStatus !== targetStatus) {
        log.debug(`applyPostMergeStateSync: setting task ${taskId} → ${targetStatus}`, {
          currentStatus,
          targetStatus,
          trigger,
        });
        await taskService.setTaskStatus(taskId, targetStatus);
        result.taskStatusUpdated = true;
      }
    } catch (error) {
      // Non-fatal: log and continue so remaining effects still apply.
      // mt#1841: surface the error to the caller via result.taskUpdateError so
      // partial failure is detectable; emit a structured log event for
      // Railway log searchability so operators can grep for the event name.
      const errMsg = getErrorMessage(error);
      result.taskUpdateError = errMsg;
      log.error("apply_post_merge_state_sync.task_update_failed", {
        event: "apply_post_merge_state_sync.task_update_failed",
        sessionId,
        taskId,
        trigger,
        error: errMsg,
      });
    }
  }

  // (b) + (c) Session.status → MERGED, Session.lastActivityAt → mergedAt
  // (d) Session.pullRequest record: reflect closed/merged state
  //
  // mt#1841: track update-intent separately from did-update result. The previous
  // implementation set result.sessionStatusUpdated = true BEFORE the await, so if
  // updateSession threw, the catch swallowed the error and the result still
  // reported success — the webhook handler had no way to detect partial failure.
  // The intent/result split moves the flag-write to AFTER the await succeeds.
  let intendSessionStatusUpdate = false;
  let intendPullRequestRecordUpdate = false;
  try {
    const sessionUpdates: Partial<Omit<typeof sessionRecord, "sessionId">> = {};

    if (sessionRecord.status !== SessionStatus.MERGED) {
      sessionUpdates.status = SessionStatus.MERGED;
      sessionUpdates.lastActivityAt = mergedAt;
      intendSessionStatusUpdate = true;
    }

    // (d) Update pullRequest record to reflect merged state.
    if (sessionRecord.pullRequest) {
      const existing = sessionRecord.pullRequest;
      sessionUpdates.pullRequest = {
        ...existing,
        state: "closed",
        mergedAt: existing.mergedAt ?? mergedAt,
        lastSynced: new Date().toISOString(),
        // Persist mergeSha on github sub-object so it survives across sessions
        // (PR #1010 R1: previously the SHA was logged but silently dropped).
        ...(mergeSha && existing.github
          ? {
              github: {
                ...existing.github,
                mergeCommitSha: mergeSha,
              },
            }
          : {}),
      };
      if (mergeSha) {
        log.info(
          `applyPostMergeStateSync: PR record synced for session ${sessionId}, ` +
            `merge_commit_sha=${mergeSha}, trigger=${trigger}`
        );
      }
      intendPullRequestRecordUpdate = true;
    }

    if (Object.keys(sessionUpdates).length > 0) {
      await sessionDB.updateSession(sessionId, sessionUpdates);
      // mt#1841: flag-write moved here, AFTER the await. The result now reports
      // ACTUAL update state, not intent.
      result.sessionStatusUpdated = intendSessionStatusUpdate;
      result.pullRequestRecordUpdated = intendPullRequestRecordUpdate;
    }
  } catch (e) {
    // mt#1841: surface the error to the caller via result.sessionUpdateError.
    // The flags remain false (never written past the await) so the result
    // accurately reflects that the session-side effects did NOT land.
    const errMsg = getErrorMessage(e);
    result.sessionUpdateError = errMsg;
    log.error("apply_post_merge_state_sync.session_update_failed", {
      event: "apply_post_merge_state_sync.session_update_failed",
      sessionId,
      taskId,
      trigger,
      error: errMsg,
      intendSessionStatusUpdate,
      intendPullRequestRecordUpdate,
    });
  }

  // (e) Session workspace cleanup
  if (cleanupSession) {
    try {
      const cleanupResult = await cleanupSessionImpl(
        {
          sessionId,
          taskId: sessionRecord.taskId,
          force: true,
        },
        { sessionDB }
      );

      result.sessionCleanup = {
        performed: true,
        directoriesRemoved: cleanupResult.directoriesRemoved,
        errors: cleanupResult.errors,
      };

      log.debug(`applyPostMergeStateSync: cleanup done for ${sessionId}`, {
        directoriesRemoved: cleanupResult.directoriesRemoved.length,
        errors: cleanupResult.errors.length,
        trigger,
      });
    } catch (cleanupError) {
      const errorMsg = `Session cleanup failed: ${getErrorMessage(cleanupError)}`;
      log.error(errorMsg, { sessionId, trigger });
      result.sessionCleanup = {
        performed: false,
        directoriesRemoved: [],
        errors: [errorMsg],
      };
    }
  }

  log.info(`applyPostMergeStateSync: completed for session ${sessionId}`, {
    taskId,
    taskStatusUpdated: result.taskStatusUpdated,
    sessionStatusUpdated: result.sessionStatusUpdated,
    pullRequestRecordUpdated: result.pullRequestRecordUpdated,
    trigger,
  });

  // PR #1121 R1 BLOCKING #3: derive partialFailure so callers don't have to
  // disambiguate "no-op success" (flags=false + no error) from "write attempted
  // and failed" (flags=false + error set). This is the single boolean that
  // unambiguously means "an effect declared but did not land."
  result.partialFailure =
    result.taskUpdateError !== undefined || result.sessionUpdateError !== undefined;

  return result;
}
