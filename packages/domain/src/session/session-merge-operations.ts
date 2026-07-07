/**
 * Session Merge Operations (Task #358)
 *
 * This module implements session PR merge functionality that requires
 * PR approval before allowing merge, enabling standard collaborative workflows.
 *
 * Two adjacent concerns were extracted from this file (mt#2614), each into
 * its own module: post-merge status-update sync (session-merge-status-sync.ts)
 * and pre-merge approval/conflict-blocker detection
 * (session-merge-conflict-detection.ts). Both are re-exported below for
 * backward compatibility with existing consumers.
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
import { getErrorMessage } from "../errors";
import { cleanupLocalBranches } from "./session-branch-cleanup";
import { evaluateTaskCorrespondence } from "./task-correspondence";
import { resolveRepository } from "../repository";
import type { PersistenceProvider, SqlCapablePersistenceProvider } from "../persistence/types";
import { ProvenanceService } from "../provenance/provenance-service";
import { AuthorshipTier } from "../provenance/types";
import { buildMergeTrailers, type MergeIdentity } from "../provenance/authorship-labels";
import { resolveMergeToken } from "../provenance/merge-token-resolution";
import { AuthorshipJudge } from "../provenance/authorship-judge";
import { AgentTranscriptService } from "../provenance/transcript-service";
import { createCompletionService } from "../ai/service-factory";
import { createTokenProvider } from "../auth";
import { getConfiguration } from "../configuration/index";
import type { ResolvedConfig } from "../configuration/types";
import type { AskRepository } from "../ask/repository";
import { applyPostMergeStateSync } from "./session-merge-status-sync";
import {
  validateSessionApprovedForMerge,
  checkGitHubMergeApprovalBlockers,
} from "./session-merge-conflict-detection";

// Re-export for backward compatibility with any consumers importing from this module.
export { BOT_IDENTITY_LOGIN, REVIEWER_BOT_LOGIN } from "../constants";

// Status-update concern (post-merge state sync) extracted to
// session-merge-status-sync.ts (mt#2614). Re-exported here for backward
// compatibility with existing consumers (same-directory tests, and
// cross-package dynamic imports of
// "@minsky/domain/session/session-merge-operations").
export {
  applyPostMergeStateSync,
  type PostMergeStateSyncParams,
  type PostMergeStateSyncDeps,
  type PostMergeStateSyncResult,
} from "./session-merge-status-sync";

// Conflict-detection concern (pre-merge approval/blocker validation)
// extracted to session-merge-conflict-detection.ts (mt#2614). Re-exported
// here for backward compatibility with existing consumers.
export { validateSessionApprovedForMerge } from "./session-merge-conflict-detection";

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

  // For GitHub backend, check approval status via API before proceeding (conflict-detection
  // concern, extracted to session-merge-conflict-detection.ts — mt#2614). Returns the canonical
  // bypass audit signature when an audited force-bypass (mt#2215) was applied; threaded into the
  // merge commit body via mergeOptions further below.
  const { bypassAuditMessage } = await checkGitHubMergeApprovalBlockers(
    sessionRecord,
    repositoryBackend,
    params
  );

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
      // Source the token via the same provider the merge uses, so App-configured
      // environments don't silently fail-open (reviewer #1); fall back to the raw
      // config token.
      const cfg = getConfiguration();
      const tokenProvider = createTokenProvider(cfg.github ?? {}, cfg.github?.token ?? "");
      let token = "";
      try {
        token = (await tokenProvider.getUserToken()) ?? "";
      } catch {
        token = "";
      }
      if (!token) token = cfg.github?.token ?? "";
      if (!owner || !repo || !prNum || !token) {
        log.debug("task-correspondence: skipping check (missing owner/repo/PR-number/token)", {
          hasOwner: !!owner,
          hasRepo: !!repo,
          prNum,
          hasToken: !!token,
        });
        return []; // missing precondition → no refs → no mismatch
      }
      const { createOctokit } = await import("../repository/github-pr-operations");
      const octokit = createOctokit(token);
      // Paginate so a PR with >100 commits cannot bypass the check (reviewer BLOCKING).
      const commits = await octokit.paginate(octokit.rest.pulls.listCommits, {
        owner,
        repo,
        pull_number: prNum,
        per_page: 100,
      });
      return commits.map((c) => (c.commit?.message ?? "").split("\n")[0] ?? "");
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
