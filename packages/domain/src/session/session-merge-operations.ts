/**
 * Session Merge Operations (Task #358)
 *
 * This module implements session PR merge functionality that requires
 * PR approval before allowing merge, enabling standard collaborative workflows.
 */

import { log } from "@minsky/shared/logger";
import { ValidationError, ResourceNotFoundError } from "../errors/index";
import { type SessionProviderInterface } from "./types";
import {
  detectRepositoryBackendTypeFromUrl,
  extractGitHubInfoFromUrl,
} from "./repository-backend-detection";
import {
  createRepositoryBackend,
  RepositoryBackendType,
  type RepositoryBackend,
  type RepositoryBackendConfig,
  type MergeInfo,
  type MergePROptions,
} from "../repository/index";
import type { TaskServiceInterface } from "../tasks/taskService";
import { createGitService } from "../git";
import type { GitServiceInterface } from "../git/types";
import { TASK_STATUS } from "../tasks/taskConstants";
import { getErrorMessage } from "../errors";
import type { SessionRecord } from "./types";
import { SessionStatus } from "./types";
import { cleanupSessionImpl } from "./session-lifecycle-operations";
import { cleanupLocalBranches } from "./session-approve-operations";
import { evaluateTaskCorrespondence } from "./task-correspondence";
import { resolveRepository } from "../repository";
import type { PersistenceProvider, SqlCapablePersistenceProvider } from "../persistence/types";
import { ProvenanceService } from "../provenance/provenance-service";
import { AuthorshipTier } from "../provenance/types";
import { formatBranchProtectionLine } from "./branch-protection-formatter";
import { buildMergeTrailers, type MergeIdentity } from "../provenance/authorship-labels";
import { resolveMergeToken } from "../provenance/merge-token-resolution";
import { AuthorshipJudge } from "../provenance/authorship-judge";
import { AgentTranscriptService } from "../provenance/transcript-service";
import { createCompletionService } from "../ai/service-factory";
import { createTokenProvider } from "../auth";
import { getConfiguration } from "../configuration/index";
import type { ResolvedConfig } from "../configuration/types";
import { resolveBotIdentities } from "../configuration/bot-identity";
import type { AskRepository } from "../ask/repository";
import { existsSync, rmSync } from "node:fs";
import { getSessionsDir } from "@minsky/shared/paths";

// Re-export for backward compatibility with any consumers importing from this module.
export { BOT_IDENTITY_LOGIN, REVIEWER_BOT_LOGIN } from "../constants";

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
   * The kind-aware terminal status the task was (or already) at: DONE for
   * implementation-kind tasks, COMPLETED for umbrella-kind (mt#1872). Undefined
   * when no task is associated. Lets callers render an accurate user-facing
   * message instead of assuming DONE.
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
   * synced ~21h later. The catch block at session-merge-operations.ts:204-210 logged
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

  // (a) Task status: post-merge terminal-state transition. Kind-aware (mt#1872):
  //   - implementation kind → DONE (existing behavior; the merged PR is the completion signal)
  //   - umbrella kind → COMPLETED (umbrella workflow has no DONE; its success terminal is COMPLETED)
  // Defensive: umbrella tasks normally don't reach the merge path because they don't ship PRs,
  // but nothing structurally prevents an operator from associating one with a PR. Without kind
  // dispatch, setTaskStatus(...,DONE) for an umbrella would throw via the workflow registry's
  // validateStatusTransition (DONE isn't a valid umbrella state) and the surrounding catch would
  // log + swallow, leaving the task stuck in IN-PROGRESS.
  if (taskId && taskService.setTaskStatus && taskService.getTaskStatus) {
    try {
      const currentStatus = await taskService.getTaskStatus(taskId);
      // getTask is a required TaskServiceInterface method. Guard the result shape
      // defensively (typeof/null) so a non-object sentinel can't masquerade as a
      // missing kind — that would silently default umbrella tasks to DONE.
      const task = await taskService.getTask(taskId);
      const taskKind =
        typeof task === "object" &&
        task !== null &&
        typeof (task as { kind?: unknown }).kind === "string"
          ? (task as { kind: string }).kind
          : "implementation";
      const targetStatus = taskKind === "umbrella" ? TASK_STATUS.COMPLETED : TASK_STATUS.DONE;
      result.taskTerminalStatus = targetStatus;

      if (currentStatus !== targetStatus) {
        log.debug(`applyPostMergeStateSync: setting task ${taskId} → ${targetStatus}`, {
          currentStatus,
          targetStatus,
          taskKind,
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

/**
 * CRITICAL: Validate that a session is approved before allowing merge
 *
 * This function enforces the approval requirement across all merge operations.
 * NO MERGE SHOULD EVER BYPASS THIS VALIDATION.
 */
export function validateSessionApprovedForMerge(
  sessionRecord: SessionRecord,
  sessionId: string
): void {
  // For GitHub backend, presence of a recorded PR is sufficient for further checks
  if (sessionRecord.backendType === "github") {
    if (!sessionRecord.pullRequest) {
      throw new ValidationError(
        `❌ MERGE REJECTED: Session "${sessionId}" has no GitHub pull request.\n` +
          `   Create a PR with 'minsky session pr create', or if a PR already exists on GitHub,\n` +
          `   repair the linkage with 'minsky session repair --pr-state'`
      );
    }
    // Approval and mergeability are delegated to the GitHub backend in mergeSessionPr()
    return;
  }

  // Non-GitHub sessions require a PR branch and explicit approval flag
  if (!sessionRecord.prBranch) {
    throw new ValidationError(
      `❌ MERGE REJECTED: Session "${sessionId}" has no PR branch.\n` +
        `   Create a PR first with 'minsky session pr create'`
    );
  }

  if (sessionRecord.prApproved !== true) {
    throw new ValidationError(
      `❌ MERGE REJECTED: Invalid approval state for session "${sessionId}". PR must be approved before merging.`
    );
  }

  log.debug("Session approval validation passed", {
    sessionId,
    prBranch: sessionRecord.prBranch,
    prApproved: sessionRecord.prApproved,
  });
}

/**
 * Parameters for session merge operation
 */
export interface SessionMergeParams {
  session?: string;
  task?: string;
  repo?: string;
  json?: boolean;
  cleanupSession?: boolean; // Session cleanup after merge (default: true)
  /**
   * Operator-override waiver: when true, allows merge for self-authored bot PRs
   * blocked only by the same-App-identity self-approval rule when the reviewer
   * bot has not fired (webhook-miss class). Bot identities resolve from config
   * (github.botIdentityLogin / reviewer.botLogin, mt#2392) with Minsky's own
   * App logins (minsky-ai[bot] / minsky-reviewer[bot]) as defaults.
   *
   * Only used by session.pr.merge -- has no effect in other contexts.
   *
   * Conditions that must ALL hold for the waiver to apply:
   *   - PR author is the configured bot identity (waiver does not apply to human-authored PRs).
   *   - No CHANGES_REQUESTED review exists on the PR (DISMISSED reviews are excluded).
   *   - At least one COMMENTED review from the SAME identity as the PR author exists.
   *   - No review from the configured reviewer bot exists.
   *   - No other merge blockers are active (PR is not a draft, no merge conflicts, PR is open).
   *     Checked via approvalStatus.hasNonApprovalMergeBlockers rather than canMerge because
   *     canMerge is always false when isApproved=false, making it useless in this path.
   *
   * Default: false (safety check is enforced by default; waiver requires explicit opt-in).
   * An audit log entry at INFO level is emitted when the waiver is used.
   */
  acceptStaleReviewerSilence?: boolean;

  /**
   * Audited reviewer-convergence-failure bypass (mt#2215). When true, allows merge of a
   * self-authored bot PR blocked by a CHANGES_REQUESTED review that is a verified
   * false-positive (mt#2211), or by reviewer CoT-leakage / self-reversal / webhook silence
   * (feedback_self_authored_pr_merge_constraints).
   *
   * Distinct from acceptStaleReviewerSilence: that waiver only covers reviewer ABSENCE and
   * explicitly refuses when a CHANGES_REQUESTED review exists; forceBypass is the path for the
   * CHANGES_REQUESTED-present case.
   *
   * Preconditions enforced (all must hold):
   *   - bypassReason is a non-empty string.
   *   - At least one prior review round occurred (rawReviews.length >= 1).
   *   - At least one present (non-DISMISSED) CHANGES_REQUESTED review exists — forceBypass is the
   *     CHANGES_REQUESTED-present path; the reviewer-absent case is acceptStaleReviewerSilence.
   *   - No required status check is failing (CI-not-green), checked where status-check data is
   *     available in the approval metadata.
   *   - No non-approval merge blocker is active (draft / conflict / not-open).
   *
   * Behavior: auto-dismisses every non-DISMISSED CHANGES_REQUESTED review using bypassReason as
   * the dismissal message, writes the canonical audit-trail signature plus bypassReason into the
   * merge-commit body, and emits an INFO audit log entry. merge_method=merge is always enforced.
   *
   * Only used by session.pr.merge. Default: false.
   */
  forceBypass?: boolean;

  /**
   * Required when forceBypass is true: a non-empty evidence string explaining why the bypass is
   * justified. Used as the CHANGES_REQUESTED dismissal message and written into the merge-commit
   * body alongside the canonical bypass audit signature.
   */
  bypassReason?: string;
}

/**
 * Result of session merge operation
 */
export interface SessionMergeResult {
  session: string;
  taskId?: string;
  prBranch?: string;
  mergeInfo: MergeInfo;
  sessionCleanup?: {
    performed: boolean;
    directoriesRemoved: string[];
    errors: string[];
  };
}

/**
 * Dependencies required by mergeSessionPr.
 * sessionDB and taskService are required — merge operations always update task state.
 * gitService has an internal fallback but callers should provide it for testability.
 */
export interface SessionMergeDependencies {
  sessionDB: SessionProviderInterface;
  taskService: TaskServiceInterface;
  gitService?: GitServiceInterface;
  createRepositoryBackend?: (config: RepositoryBackendConfig) => Promise<RepositoryBackend>;
  persistenceProvider?: PersistenceProvider;
  /** Optional — when provided, a quality.review Ask row is emitted before each merge attempt. */
  askRepository?: AskRepository;
}

// ---------------------------------------------------------------------------
// Ask emission constants (mt#1475)
// ---------------------------------------------------------------------------

/** AskKind for pre-merge review requests. */
const QUALITY_REVIEW_KIND = "quality.review" as const;

/** Initial Ask state — router has not yet run. */
const ASK_INITIAL_STATE = "detected" as const;

/** Classifier version tag for the session_pr_merge emission. */
const MERGE_CLASSIFIER_VERSION = "v1.0.0";

/**
 * Merge a session's approved pull request (Task #358)
 *
 * This function:
 * 1. Validates the session has a PR branch
 * 2. Validates the PR is approved (prApproved: true)
 * 3. Calls repositoryBackend.pr.merge()
 * 4. Updates session record
 *
 * Requires the PR to be approved first.
 */
export async function mergeSessionPr(
  params: SessionMergeParams,
  deps: SessionMergeDependencies
): Promise<SessionMergeResult> {
  // Removed noise padding - operation speaks for itself

  const sessionDB = deps.sessionDB;

  // Resolve session ID
  let sessionIdToUse = params.session;

  if (params.task && !sessionIdToUse) {
    const sessionByTask = await sessionDB.getSessionByTaskId(params.task);
    if (!sessionByTask) {
      throw new ResourceNotFoundError(
        `No session found for task ${params.task}`,
        "session",
        params.task
      );
    }
    sessionIdToUse = sessionByTask.sessionId;
  }

  if (!sessionIdToUse) {
    throw new ValidationError("No session detected. Please provide a session ID or task ID");
  }

  // Get session record
  const sessionRecord = await sessionDB.getSession(sessionIdToUse);
  if (!sessionRecord) {
    throw new ResourceNotFoundError(
      `Session "${sessionIdToUse}" not found`,
      "session",
      sessionIdToUse
    );
  }

  // CRITICAL SECURITY VALIDATION: Use centralized approval validation
  // This ensures consistent security enforcement across all merge operations
  validateSessionApprovedForMerge(sessionRecord, sessionIdToUse);

  // Get the main repository path for task updates (not session workspace)
  // Resolve to a local filesystem path to avoid using remote URLs as workdirs
  let originalRepoPath = process.cwd();
  try {
    const repository = await resolveRepository({
      uri: params.repo || sessionRecord.repoUrl,
      autoDetect: true,
    });
    originalRepoPath = repository.isLocal && repository.path ? repository.path : process.cwd();
  } catch (_err) {
    originalRepoPath = process.cwd();
  }

  const taskService = deps.taskService;
  const gitService = deps.gitService || createGitService();

  // Create repository backend for this session
  // Use stored repoUrl for backend detection to avoid redundant git commands
  const repoUrl = params.repo || sessionRecord.repoUrl || process.cwd();
  const backendType = sessionRecord.backendType || detectRepositoryBackendTypeFromUrl(repoUrl);

  // For merge operations, we still need a working directory (session workspace)
  const _workingDirectory = await sessionDB.getSessionWorkdir(sessionIdToUse);

  const config: RepositoryBackendConfig = {
    type: backendType,
    repoUrl: repoUrl,
  };

  // Add GitHub-specific configuration if detected
  if (backendType === RepositoryBackendType.GITHUB) {
    const githubInfo = extractGitHubInfoFromUrl(repoUrl);
    if (githubInfo) {
      config.github = {
        owner: githubInfo.owner,
        repo: githubInfo.repo,
      };
    }
  }

  const createBackendFunc =
    deps?.createRepositoryBackend ||
    ((c: RepositoryBackendConfig) => createRepositoryBackend(c, sessionDB));
  const repositoryBackend = await createBackendFunc(config);

  // Removed implementation detail - backend type is apparent from context

  // Re-check PR existence for merge operation
  const _hasLocalPr = sessionRecord.prBranch;
  const hasGitHubPr = sessionRecord.pullRequest && sessionRecord.backendType === "github";

  // For GitHub backend, check approval status via API before proceeding
  // Holds the canonical bypass audit signature when an audited force-bypass (mt#2215) is
  // applied; threaded into the merge commit body via mergeOptions further below.
  let bypassAuditMessage: string | undefined;
  if (hasGitHubPr && sessionRecord.pullRequest) {
    if (!params.json) {
      log.cli(`🔍 Checking GitHub PR approval & branch protection...`);
    }

    try {
      const approvalStatus = await repositoryBackend.review.getApprovalStatus(
        sessionRecord.pullRequest.number
      );

      if (!params.json) {
        const approvals = approvalStatus.approvals?.length || 0;
        const required = approvalStatus.requiredApprovals ?? 0;
        // mt#2007: read the full branch-protection shape (status checks,
        // dismiss-stale, enforce_admins, force_push, deletion, etc.) from the
        // metadata block populated in github-pr-approval.ts. The previous
        // "required > 0 ? configured : not configured" collapse misreported
        // every protection state where reviews=0 but other protections were
        // active.
        const bp = approvalStatus.metadata?.github?.branchProtection;
        const branchProtection = formatBranchProtectionLine(bp);
        const approvalLine =
          required > 0
            ? `${approvals}/${required} approvals`
            : approvals > 0
              ? `${approvals} approvals`
              : `no approvals required`;
        log.cli(`• Approval status: ${approvalLine}`);
        log.cli(`• Branch protection: ${branchProtection}`);
      }

      // Track whether the waiver path was taken (used for B1: correct success message)
      let waiverApplied = false;
      // Track whether the audited force-bypass path (mt#2215) was taken.
      let bypassApplied = false;

      if (!approvalStatus.isApproved) {
        // Check whether the operator-override waiver applies before blocking.
        // Waiver conditions (ALL must hold):
        //   1. acceptStaleReviewerSilence flag explicitly set to true.
        //   2. PR author is the configured bot identity (default minsky-ai[bot]).
        //   3. No CHANGES_REQUESTED review (substantive findings unaddressed).
        //   4. No reviewer-bot review (webhook-miss class).
        //   5. At least one COMMENTED review from the SAME identity as the PR author.
        //
        // Bot identities resolve from config (github.botIdentityLogin /
        // reviewer.botLogin) with Minsky's own App logins as defaults (mt#2392),
        // so external projects can satisfy the waiver with their own bots.
        const { botIdentityLogin, reviewerBotLogin } = resolveBotIdentities();
        const rawReviews = approvalStatus.rawReviews ?? [];
        const prAuthor = sessionRecord.pullRequest.github?.author ?? "";
        const isPrAuthorBot = prAuthor.toLowerCase() === botIdentityLogin.toLowerCase();
        // Exclude DISMISSED reviews from CHANGES_REQUESTED check (stale reviews that no longer block)
        const hasChangesRequested = rawReviews
          .filter((r) => r.state !== "DISMISSED")
          .some((r) => r.state === "CHANGES_REQUESTED");
        const hasReviewerBotReview = rawReviews.some(
          (r) => r.reviewerLogin.toLowerCase() === reviewerBotLogin.toLowerCase()
        );
        // Waiver requires COMMENTED review from the SAME identity as the PR author.
        // Normalize both sides to lowercase: GitHub logins are case-insensitive.
        const prAuthorLower = prAuthor.toLowerCase();
        const hasCommentedReview = rawReviews.some(
          (r) => r.state === "COMMENTED" && r.reviewerLogin.toLowerCase() === prAuthorLower
        );

        const waiverEligible =
          params.acceptStaleReviewerSilence === true &&
          isPrAuthorBot &&
          !hasChangesRequested &&
          !hasReviewerBotReview &&
          hasCommentedReview;

        if (params.forceBypass === true) {
          // ── Audited reviewer-convergence-failure bypass (mt#2215) ──────────────
          // The CHANGES_REQUESTED-present path the acceptStaleReviewerSilence waiver refuses.
          const reason = (params.bypassReason ?? "").trim();
          if (!reason) {
            throw new ValidationError(
              `❌ forceBypass requires a non-empty bypassReason explaining why the bypass is ` +
                `justified (e.g. the verified false-positive and its verification, or the ` +
                `reviewer convergence-failure class).`
            );
          }

          // Precondition: at least one prior review round must have occurred.
          if (rawReviews.length < 1) {
            throw new ValidationError(
              `❌ forceBypass requires at least one prior review round to have occurred; none ` +
                `found on PR #${sessionRecord.pullRequest.number}. The bypass is for reviewer ` +
                `convergence FAILURE, not for skipping review entirely.`
            );
          }

          // Precondition: CI must not be failing (checked where status-check data is available).
          const statusChecks = approvalStatus.metadata?.github?.statusChecks ?? [];
          const failingChecks = statusChecks
            .filter((c) => c.state === "failure")
            .map((c) => c.context);
          if (failingChecks.length > 0) {
            throw new ValidationError(
              `❌ forceBypass refused: required status check(s) failing on PR ` +
                `#${sessionRecord.pullRequest.number}: ${failingChecks.join(", ")}. ` +
                `CI must be green on HEAD before a convergence-failure bypass.`
            );
          }

          // Other merge blockers (draft / conflict / not-open) still apply.
          if (approvalStatus.hasNonApprovalMergeBlockers) {
            const blockerDesc =
              approvalStatus.nonApprovalBlockerDescription ?? approvalStatus.prState ?? "unknown";
            throw new ValidationError(
              `❌ forceBypass refused: a non-approval merge blocker is active on PR ` +
                `#${sessionRecord.pullRequest.number} (${blockerDesc}). The bypass addresses the ` +
                `review gate only — resolve the underlying blocker (draft state, merge conflicts, ` +
                `closed PR) before retrying.`
            );
          }

          // Precondition: a present (non-DISMISSED) CHANGES_REQUESTED review MUST exist.
          // forceBypass is specifically the CHANGES_REQUESTED-present path (verified
          // false-positive / reviewer self-reversal / leakage-stale blocking review). The
          // reviewer-ABSENT case (webhook-miss, no CHANGES_REQUESTED) is covered by
          // acceptStaleReviewerSilence instead. Without this guard, any not-approved PR with
          // >=1 review and green CI could be force-merged, broadening the bypass beyond intent.
          const blockingReviews = rawReviews.filter((r) => r.state === "CHANGES_REQUESTED");
          if (blockingReviews.length === 0) {
            throw new ValidationError(
              `❌ forceBypass refused: no present (non-DISMISSED) CHANGES_REQUESTED review on PR ` +
                `#${sessionRecord.pullRequest.number}. forceBypass is the CHANGES_REQUESTED-present ` +
                `path. If the merge is blocked only by reviewer ABSENCE (webhook-miss, no ` +
                `CHANGES_REQUESTED), use acceptStaleReviewerSilence instead.`
            );
          }

          // Fold-in dismissal: dismiss every present CHANGES_REQUESTED review using the supplied
          // reason as evidence, clearing the GitHub-side review gate before merge. Uses the
          // already-created repositoryBackend.review.dismissReview primitive — the same call
          // session_pr_review_dismiss wraps — rather than re-creating a backend.
          const dismissedReviewIds: string[] = [];
          const dismissReview = repositoryBackend.review.dismissReview?.bind(
            repositoryBackend.review
          );
          for (const review of blockingReviews) {
            const reviewIdNum = Number(review.reviewId);
            if (!Number.isInteger(reviewIdNum) || reviewIdNum <= 0) {
              log.warn(
                `forceBypass: skipping non-numeric review id "${review.reviewId}" on dismiss`
              );
              continue;
            }
            if (!dismissReview) {
              log.warn(
                `forceBypass: repository backend does not support review dismissal; ` +
                  `review ${review.reviewId} left in place (merge will still proceed)`
              );
              continue;
            }
            try {
              await dismissReview(sessionRecord.pullRequest.number, reviewIdNum, {
                message: reason,
              });
              dismissedReviewIds.push(review.reviewId);
            } catch (dismissError) {
              // COMMENT-event reviews cannot be dismissed (GitHub 422); merge can still proceed.
              log.warn(
                `forceBypass: could not dismiss review ${review.reviewId} on PR ` +
                  `#${sessionRecord.pullRequest.number}: ${getErrorMessage(dismissError)}`
              );
            }
          }

          const dismissedSummary = dismissedReviewIds.length
            ? dismissedReviewIds.join(", ")
            : "none";
          log.info(
            `FORCE-BYPASS: audited reviewer-convergence-failure bypass applied for PR ` +
              `#${sessionRecord.pullRequest.number}. Reason: ${reason}. ` +
              `Review rounds observed: ${rawReviews.length}. ` +
              `CHANGES_REQUESTED dismissed: ${dismissedSummary}. ` +
              `Per feedback_self_authored_pr_merge_constraints.`
          );
          if (!params.json) {
            log.cli(
              `⚠️  Audited force-bypass applied (mt#2215): ${reason}. ` +
                `Canonical audit signature will be written to the merge commit.`
            );
          }

          // Canonical audit-trail signature — consumed by /verify-task's bypass-merge closeout.
          bypassAuditMessage =
            `\n\nBot self-approval bypass per feedback_self_authored_pr_merge_constraints` +
            `\nReason: ${reason}` +
            `\nReview rounds observed: ${rawReviews.length}` +
            `\nCHANGES_REQUESTED dismissed: ${dismissedSummary}`;
          bypassApplied = true;
          // Fall through to merge -- do not throw.
        } else if (waiverEligible) {
          // Waiver only addresses the reviewer-bot-silence blocker, not other merge blockers.
          // Use hasNonApprovalMergeBlockers rather than canMerge: canMerge is always false
          // when isApproved=false (it includes isApproved in its computation), making it
          // permanently unreachable here. hasNonApprovalMergeBlockers is computed independently
          // of approval state and accurately reflects draft/conflict/closed blockers (B1).
          if (approvalStatus.hasNonApprovalMergeBlockers) {
            const blockerDesc =
              approvalStatus.nonApprovalBlockerDescription ?? approvalStatus.prState ?? "unknown";
            throw new ValidationError(
              `❌ GitHub PR #${sessionRecord.pullRequest.number} cannot be merged.\n` +
                `   The acceptStaleReviewerSilence waiver addresses reviewer-bot silence only.\n` +
                `   Another merge blocker is active (${blockerDesc}).\n` +
                `   Resolve the underlying blocker (e.g., draft state, merge conflicts, failing checks) before retrying.\n\n` +
                `💡 Next steps:` +
                `\n   1. View the PR: ${sessionRecord.pullRequest.url}` +
                `\n   2. Address the blocker` +
                `\n   3. Re-run merge when the PR is mergeable`
            );
          }

          // Identify which identities are involved for audit record
          const commentReviewers = rawReviews
            .filter((r) => r.state === "COMMENTED")
            .map((r) => r.reviewerLogin)
            .join(", ");
          const prNumber = sessionRecord.pullRequest.number;

          log.info(
            `WAIVER: acceptStaleReviewerSilence applied for PR #${prNumber}. ` +
              `PR author identity: ${sessionRecord.pullRequest.github?.author ?? "unknown"}. ` +
              `COMMENT reviewer(s): ${commentReviewers}. ` +
              `${reviewerBotLogin} review absent (webhook-miss class). ` +
              `Proceeding with merge under operator-override waiver.`
          );
          if (!params.json) {
            log.cli(
              `⚠️  Operator-override waiver applied: ${reviewerBotLogin} review absent. ` +
                `Merging under acceptStaleReviewerSilence. See audit log for details.`
            );
          }
          waiverApplied = true;
          // Fall through to merge -- do not throw
        } else if (params.acceptStaleReviewerSilence === true && !waiverEligible) {
          // Flag was set but waiver conditions don't hold -- give a clear reason
          const reasons: string[] = [];
          if (!isPrAuthorBot) {
            reasons.push(
              `PR author is "${prAuthor}", not the configured bot identity "${botIdentityLogin}" ` +
                `(waiver only applies to self-authored bot PRs; set github.botIdentityLogin / ` +
                `reviewer.botLogin if this project uses its own bots)`
            );
          }
          if (hasChangesRequested) {
            reasons.push(
              "CHANGES_REQUESTED review exists (substantive findings must be addressed)"
            );
          }
          if (hasReviewerBotReview) {
            reasons.push(
              `${reviewerBotLogin} review exists (waiver only applies when reviewer-bot is absent)`
            );
          }
          if (!hasCommentedReview) {
            reasons.push(
              `no COMMENTED review from the PR author (${prAuthor}) found (waiver requires a same-identity COMMENT review)`
            );
          }
          throw new ValidationError(
            `❌ GitHub PR #${sessionRecord.pullRequest.number} does not meet approval requirements.\n` +
              `   acceptStaleReviewerSilence=true was set but waiver conditions are not met:\n${reasons
                .map((r) => `   - ${r}`)
                .join("\n")}\n\n` +
              `💡 Next steps:` +
              `\n   1. View the PR: ${sessionRecord.pullRequest.url}` +
              `\n   2. Request required reviews` +
              `\n   3. Address any changes requested` +
              `\n   4. Re-run merge when approvals are sufficient`
          );
        } else {
          // Default path: no waiver, block merge with actionable guidance
          // Only hint about acceptStaleReviewerSilence when the waiver could plausibly apply:
          // the PR must be authored by the bot identity (waiver never applies to human-authored PRs).
          const missingReviewerNote =
            isPrAuthorBot && !hasReviewerBotReview
              ? `\n   Note: ${reviewerBotLogin} has not reviewed this PR. ` +
                `If the reviewer bot is silent (webhook-miss), you may use ` +
                `acceptStaleReviewerSilence=true as an operator-override waiver.`
              : "";
          throw new ValidationError(
            `❌ GitHub PR #${sessionRecord.pullRequest.number} does not meet approval requirements.${
              missingReviewerNote
            }\n\n` +
              `💡 Next steps:` +
              `\n   1. View the PR: ${sessionRecord.pullRequest.url}` +
              `\n   2. Request required reviews` +
              `\n   3. Address any changes requested` +
              `\n   4. Re-run merge when approvals are sufficient`
          );
        }
      }

      // B1: Condition success message on whether the PR was actually approved (not waiver path).
      // When proceeding via waiver, the waiver message above already informed the user.
      if (!params.json) {
        if (waiverApplied) {
          log.cli(
            `PR proceeding via acceptStaleReviewerSilence waiver -- reviewer-bot review absent, waiver conditions met`
          );
        } else if (bypassApplied) {
          // The forceBypass branch already emitted its own audited cli message above.
          log.cli(`PR proceeding via audited force-bypass (mt#2215)`);
        } else {
          log.cli(`✅ PR is approved and mergeable`);
        }
      }
    } catch (error) {
      if (error instanceof ValidationError) {
        throw error; // Re-throw our validation errors
      }
      // Quietly continue on API errors; avoid noisy raw HTTP logs
      log.debug(
        `Skipping pre-merge approval check due to API error. Proceeding with merge attempt.`
      );
    }
  }

  // ── quality.review Ask emission (mt#1475) ──────────────────────────────
  // Best-effort: emit a quality.review Ask before each merge attempt.
  // Failure must never block the merge — log and continue.
  if (deps.askRepository) {
    try {
      const prUrl = sessionRecord.pullRequest?.url;
      const prNumber =
        sessionRecord.backendType === "github" && sessionRecord.pullRequest
          ? sessionRecord.pullRequest.number
          : undefined;
      const taskId = sessionRecord.taskId;

      await deps.askRepository.create({
        kind: QUALITY_REVIEW_KIND,
        classifierVersion: MERGE_CLASSIFIER_VERSION,
        // requestor: the session ID in AgentId format (session identity)
        requestor: sessionIdToUse,
        parentSessionId: sessionIdToUse,
        parentTaskId: taskId,
        title: prNumber != null ? `Review PR #${prNumber} before merge` : "Review PR before merge",
        question:
          prUrl != null
            ? `Review the changes in PR ${prUrl} before merge.`
            : "Review the session PR changes before merge.",
        contextRefs: prUrl
          ? [
              {
                kind: "github-pr",
                ref: prUrl,
                description: prNumber != null ? `PR #${prNumber}` : "PR",
              },
            ]
          : [],
        metadata: {},
      });

      log.debug(`${QUALITY_REVIEW_KIND} Ask emitted for merge`, {
        sessionId: sessionIdToUse,
        taskId,
        prNumber,
        state: ASK_INITIAL_STATE,
      });
    } catch (askError) {
      // Non-fatal: log at debug and continue so the merge always proceeds.
      log.debug(`Failed to emit quality.review Ask before merge: ${getErrorMessage(askError)}`);
    }
  }

  // Merge the approved PR using repository backend
  // Determine PR identifier based on backend
  let prIdentifier: string | number | undefined = sessionRecord.prBranch;
  if (sessionRecord.backendType === "github" && sessionRecord.pullRequest) {
    prIdentifier = sessionRecord.pullRequest.number;
  }

  if (!params.json) {
    const displayId = typeof prIdentifier === "number" ? `#${prIdentifier}` : String(prIdentifier);
    log.cli(`🔀 Merging ${displayId}`);
  }

  if (prIdentifier === undefined) {
    throw new ValidationError("No PR identifier available for merge");
  }

  // ── Tier-aware merge options ────────────────────────────────────────────
  // Look up the provenance record to determine authorship tier, then select
  // the appropriate token and build git trailers for the merge commit.
  // All of this is best-effort: any failure degrades gracefully to the
  // default (no trailers, default token) — it must never break the merge.
  const mergeOptions: MergePROptions = {};
  // mt#2215: thread the canonical audited-bypass signature into the merge commit body.
  if (bypassAuditMessage) {
    mergeOptions.bypassAuditMessage = bypassAuditMessage;
  }
  try {
    const prNumber =
      sessionRecord.backendType === "github" && sessionRecord.pullRequest
        ? sessionRecord.pullRequest.number
        : undefined;

    // Resolve provenance tier (requires SQL-capable persistence + a numeric PR number)
    let authorshipTier: AuthorshipTier | null = null;
    if (prNumber !== undefined && deps.persistenceProvider) {
      const provider = deps.persistenceProvider as SqlCapablePersistenceProvider;
      if (typeof provider.getDatabaseConnection === "function") {
        const db = await provider.getDatabaseConnection();
        if (db) {
          const provenanceService = new ProvenanceService(db);
          const provenance = await provenanceService.getProvenanceForArtifact(
            String(prNumber),
            "pr"
          );
          if (provenance?.authorshipTier != null) {
            authorshipTier = provenance.authorshipTier;
            log.debug(`Tier-aware merge: tier=${authorshipTier} for PR #${prNumber}`);
          }
        }
      }
    }

    // Build token provider from config (same pattern as createRepositoryBackend).
    // Done unconditionally so token routing works even when tier is unknown
    // (mt#992: the previous code only built the provider inside the tier-known
    // branch, which meant missing provenance fell through to the default
    // service token and failed on protected branches).
    const cfg = getConfiguration();
    const userToken = cfg.github?.token ?? "";
    const githubCfg = cfg.github ?? {};
    const tokenProvider = createTokenProvider(githubCfg, userToken);
    const serviceAccountConfigured = tokenProvider.isServiceAccountConfigured();

    // Decide which token to use. The pure function handles all four states
    // (three tier values plus null) consistently. See mt#992 and
    // src/domain/provenance/merge-token-resolution.ts.
    //
    // Behavior note: this check uses only the synchronous
    // `isServiceAccountConfigured()` — not the async `getServiceIdentity()`
    // call that the old code gated on. The effect is that a misconfigured
    // App (config present, credentials invalid) now falls back to the user
    // token instead of throwing during identity resolution. This is the
    // intended fail-safe direction: prefer a working merge under the user
    // PAT over a failed merge under broken App credentials. Flagged by the
    // mt#992 Chinese-wall reviewer, kept intentionally.
    const tokenChoice = resolveMergeToken(authorshipTier, serviceAccountConfigured);
    if (tokenChoice === "user" && serviceAccountConfigured) {
      mergeOptions.tokenOverride = () => tokenProvider.getUserToken();
    }

    if (authorshipTier !== null) {
      const serviceIdentity = await tokenProvider.getServiceIdentity();

      // Build bot identity for trailers (only when a service account is configured)
      let botIdentity: MergeIdentity | null = null;
      if (serviceIdentity) {
        botIdentity = {
          login: serviceIdentity.login,
          email: `${serviceIdentity.login}@users.noreply.github.com`,
        };
      }

      // Resolve human identity for Tier 3 trailers via GitHub API
      let humanIdentity: MergeIdentity | null = null;
      try {
        const humanToken = await tokenProvider.getUserToken();
        if (humanToken) {
          const { createOctokit } = await import("../repository/github-pr-operations");
          const humanOctokit = createOctokit(humanToken);
          const { data: user } = await humanOctokit.rest.users.getAuthenticated();
          humanIdentity = {
            login: user.login,
            email: user.email || `${user.id}+${user.login}@users.noreply.github.com`,
          };
        }
      } catch {
        log.debug("Could not resolve human identity for Tier 3 trailers");
      }

      const trailers = buildMergeTrailers(authorshipTier, botIdentity, humanIdentity);
      if (trailers) {
        mergeOptions.mergeTrailers = trailers;
      }

      mergeOptions.authorshipTier = authorshipTier;
    } else if (serviceAccountConfigured && prNumber !== undefined) {
      log.warn(
        `No provenance record for PR #${prNumber}; defaulting merge to user token (CO_AUTHORED routing). See mt#992.`
      );
    }
  } catch (tierError) {
    log.warn(
      `Tier-aware merge setup failed (falling back to default): ${getErrorMessage(tierError)}`
    );
  }

  // Seam 2 (mt#2514 / mt#2511): block a "task-hijack" cross-bind merge. If the
  // PR's commits reference a task DIFFERENT from the one this session is bound
  // to (and none reference the bound task), refuse the merge — merging would
  // auto-complete the bound task with work that belongs elsewhere. Pre-merge is
  // the only place the commit subjects are reliably available (the merge runs
  // via the GitHub API, so the merge commit is not guaranteed local afterward).
  // Fail-open on any error; override with MINSKY_ACK_TASK_HIJACK=1.
  const hijackBlockMessage = await evaluateTaskCorrespondence({
    boundTaskId: sessionRecord.taskId,
    log,
    listCommitSubjects: async () => {
      const owner = config.github?.owner;
      const repo = config.github?.repo;
      const prNum = sessionRecord.pullRequest?.number;
      const token = getConfiguration().github?.token ?? "";
      if (!owner || !repo || !prNum || !token) return []; // missing precondition → no refs → no mismatch
      const { createOctokit } = await import("../repository/github-pr-operations");
      const octokit = createOctokit(token);
      const resp = await octokit.rest.pulls.listCommits({
        owner,
        repo,
        pull_number: prNum,
        per_page: 100,
      });
      return resp.data.map((c) => (c.commit?.message ?? "").split("\n")[0] ?? "");
    },
  });
  if (hijackBlockMessage) {
    throw new ValidationError(hijackBlockMessage);
  }

  const mergeInfo = await repositoryBackend.pr.merge(prIdentifier, sessionIdToUse, mergeOptions);

  if (!params.json) {
    log.cli(`📝 Merge commit: ${mergeInfo.commitHash.substring(0, 8)}...`);
  }

  // Update authorship label at merge time if tier is known
  const ghOwner = config.github?.owner;
  const ghRepo = config.github?.repo;
  if (
    mergeOptions.authorshipTier != null &&
    sessionRecord.pullRequest?.number &&
    ghOwner &&
    ghRepo
  ) {
    try {
      const mergeCfg = getConfiguration();
      const token = mergeCfg.github?.token ?? "";
      if (token) {
        const { createOctokit } = await import("../repository/github-pr-operations");
        const octokit = createOctokit(token);
        const { ensureAuthorshipLabelsExist, addAuthorshipLabel } = await import(
          "../provenance/authorship-labels"
        );
        await ensureAuthorshipLabelsExist(octokit, ghOwner, ghRepo);
        await addAuthorshipLabel(
          octokit,
          ghOwner,
          ghRepo,
          sessionRecord.pullRequest.number,
          mergeOptions.authorshipTier
        );
        log.debug(
          `Updated authorship label on PR #${sessionRecord.pullRequest.number} at merge time`
        );
      }
    } catch (labelError) {
      log.warn(`Failed to update authorship label at merge time: ${getErrorMessage(labelError)}`);
    }
  }

  // Post-merge: AI-based tier judging (best-effort, non-fatal)
  // Evaluates the session transcript to assign a final authorship tier, replacing
  // the preliminary tier computed at PR creation time.
  if (sessionRecord.pullRequest?.number && deps.persistenceProvider) {
    try {
      const provider = deps.persistenceProvider as SqlCapablePersistenceProvider;
      if (typeof provider.getDatabaseConnection === "function") {
        const db = await provider.getDatabaseConnection();
        if (db) {
          const transcriptService = new AgentTranscriptService(db);
          const transcript = await transcriptService.getTranscript(sessionIdToUse);
          if (transcript && transcript.length > 0) {
            const judgingCfg = getConfiguration() as ResolvedConfig;
            const anthropicKey = (
              judgingCfg as { ai?: { providers?: { anthropic?: { apiKey?: string } } } }
            ).ai?.providers?.anthropic?.apiKey;
            if (anthropicKey) {
              const completionService = createCompletionService(judgingCfg);
              const judge = new AuthorshipJudge(completionService);
              const judgment = await judge.evaluateTranscript(transcript, {
                taskOrigin: "human",
                specAuthorship: "mixed",
                initiationMode: "dispatched",
              });
              const provenanceService = new ProvenanceService(db);
              await provenanceService.updateWithJudgment(
                String(sessionRecord.pullRequest.number),
                "pr",
                judgment
              );
              log.cli(
                `✍️  Authorship tier: ${judgment.tier} (${judgment.rationale.slice(0, 100)}...)`
              );
            } else {
              log.debug("Skipping AI tier judging: ANTHROPIC_API_KEY not configured");
            }
          } else {
            log.debug("Skipping AI tier judging: no transcript stored for session");
          }
        }
      }
    } catch (judgeError) {
      log.warn(`Post-merge AI tier judging failed: ${getErrorMessage(judgeError)}`);
    }
  }

  // Clean up local branches in main repository after successful merge
  try {
    // Removed noise padding for fast operations

    // For branch cleanup, we need to work in the main repository, not session workspace
    const mainRepoPath = originalRepoPath;

    await cleanupLocalBranches(
      gitService,
      mainRepoPath,
      sessionRecord.prBranch || "",
      sessionIdToUse,
      sessionRecord.taskId
    );

    if (!params.json) {
      log.cli("✅ Local branches cleaned up");
    }
  } catch (branchCleanupError) {
    // Log but don't fail the operation if branch cleanup fails
    const errorMsg = `Branch cleanup failed: ${getErrorMessage(branchCleanupError)}`;
    log.debug(errorMsg);
    if (!params.json) {
      log.cli(`⚠️  Warning: ${errorMsg}`);
    }
  }

  // Apply all five post-merge state changes via the shared helper.
  // This is the same logic that the webhook path and sweeper will call — no drift between paths.
  const syncResult = await applyPostMergeStateSync(
    {
      sessionId: sessionIdToUse,
      mergeSha: mergeInfo.commitHash,
      mergedAt: mergeInfo.mergeDate ?? new Date().toISOString(),
      cleanupSession: params.cleanupSession !== false,
      trigger: "session_pr_merge",
    },
    { sessionDB, taskService }
  );

  if (!params.json) {
    if (syncResult.taskStatusUpdated) {
      log.cli(`✅ Task status updated to ${syncResult.taskTerminalStatus ?? "DONE"}`);
    } else if (syncResult.taskId) {
      log.cli(`ℹ️  Task is already marked as ${syncResult.taskTerminalStatus ?? "DONE"}`);
    }
    if (syncResult.sessionCleanup?.directoriesRemoved.length) {
      log.cli(
        `✅ Cleaned up ${syncResult.sessionCleanup.directoriesRemoved.length} session directories`
      );
    }
    if (syncResult.sessionCleanup?.errors.length) {
      log.cli(`⚠️  ${syncResult.sessionCleanup.errors.length} cleanup errors occurred`);
    }
  }

  // Emit pr.merged system event (best-effort, informational — mt#2487).
  // Mirrors emitTaskStatusChangedEvent: skip silently when no SQL-capable
  // provider/DB is available; emission failure must never affect the merge.
  // Wired in the in-band session_pr_merge path (the "at-merge" handler), which
  // fires once per merge — webhook/sweeper/repair detection paths are out of
  // scope here (they call applyPostMergeStateSync directly).
  //
  // Only emit when an actual PR record is present: pr.merged is PR-semantic and
  // its payload requires prUrl + prNumber (the schema doc comment), so a
  // non-GitHub / no-PR merge skips the event rather than writing a row with
  // undefined required fields.
  try {
    const pr = sessionRecord.pullRequest;
    const sqlProvider = deps.persistenceProvider as SqlCapablePersistenceProvider | undefined;
    if (pr?.url && pr.number != null && sqlProvider?.getDatabaseConnection) {
      const db = await sqlProvider.getDatabaseConnection();
      if (db) {
        const { DrizzleEventEmitter } = await import("../events/emitter");
        await new DrizzleEventEmitter(db).emit({
          eventType: "pr.merged",
          payload: {
            prUrl: pr.url,
            prNumber: pr.number,
            taskId: sessionRecord.taskId ?? undefined,
          },
          relatedTaskId: sessionRecord.taskId ?? undefined,
          relatedSessionId: sessionIdToUse,
        });
      }
    }
  } catch (err: unknown) {
    log.warn("pr.merged: event emission failed (best-effort, swallowed)", {
      session: sessionIdToUse,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return {
    session: sessionIdToUse,
    taskId: sessionRecord.taskId,
    prBranch: sessionRecord.prBranch,
    mergeInfo,
    sessionCleanup: syncResult.sessionCleanup,
  };
}
