/**
 * Session Merge Operations (Task #358)
 *
 * This module implements session PR merge functionality that requires
 * PR approval before allowing merge, enabling standard collaborative workflows.
 */

import { log } from "../../utils/logger";
import { ValidationError, ResourceNotFoundError } from "../../errors/index";
import { type SessionProviderInterface } from "./session-db-adapter";
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
import { getErrorMessage } from "../../errors";
import type { SessionRecord } from "./types";
import { SessionStatus } from "./types";
import { cleanupSessionImpl } from "./session-lifecycle-operations";
import { cleanupLocalBranches } from "./session-approve-operations";
import { resolveRepository } from "../repository";
import type { PersistenceProvider, SqlCapablePersistenceProvider } from "../persistence/types";
import { ProvenanceService } from "../provenance/provenance-service";
import { AuthorshipTier } from "../provenance/types";
import { buildMergeTrailers, type MergeIdentity } from "../provenance/authorship-labels";
import { resolveMergeToken } from "../provenance/merge-token-resolution";
import { AuthorshipJudge } from "../provenance/authorship-judge";
import { TranscriptService } from "../provenance/transcript-service";
import { createCompletionService } from "../ai/service-factory";
import { createTokenProvider } from "../auth";
import { getConfiguration } from "../configuration/index";
import type { ResolvedConfig } from "../configuration/types";

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
}

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
    sessionIdToUse = sessionByTask.session;
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
        const branchProtection = required > 0 ? `enabled (requires ${required})` : `not configured`;
        const approvalLine =
          required > 0
            ? `${approvals}/${required} approvals`
            : approvals > 0
              ? `${approvals} approvals`
              : `no approvals required`;
        log.cli(`• Approval status: ${approvalLine}`);
        log.cli(`• Branch protection: ${branchProtection}`);
      }

      if (!approvalStatus.isApproved) {
        // Concise, actionable guidance without noisy transport logs
        throw new ValidationError(
          `❌ GitHub PR #${sessionRecord.pullRequest.number} does not meet approval requirements.` +
            `\n\n` +
            `💡 Next steps:` +
            `\n   1. View the PR: ${sessionRecord.pullRequest.url}` +
            `\n   2. Request required reviews` +
            `\n   3. Address any changes requested` +
            `\n   4. Re-run merge when approvals are sufficient`
        );
      }

      if (!params.json) {
        log.cli(`✅ PR is approved and mergeable`);
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
          const transcriptService = new TranscriptService(db);
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

  // Update task status to DONE if we have a task ID and it's not already DONE
  const taskId = sessionRecord.taskId;
  if (taskId && taskService.setTaskStatus && taskService.getTaskStatus) {
    try {
      const currentStatus = await taskService.getTaskStatus(taskId);
      if (currentStatus !== TASK_STATUS.DONE) {
        if (!params.json) {
          log.cli(`📋 Updating task ${taskId} status to DONE...`);
        }
        log.debug(`Updating task ${taskId} status from ${currentStatus} to DONE`);
        await taskService.setTaskStatus(taskId, TASK_STATUS.DONE);
        // Do not perform git commits here; persistence is handled by the task backend
        if (!params.json) {
          log.cli("✅ Task status updated");
        }
      } else if (!params.json) {
        log.cli("ℹ️  Task is already marked as DONE");
      }
    } catch (error) {
      const errorMsg = `Failed to update task status: ${getErrorMessage(error)}`;
      log.error(errorMsg, { taskId, error });
      if (!params.json) {
        log.cli(`⚠️  Warning: ${errorMsg}`);
      }
    }
  }

  // Update session activity state to MERGED before cleanup
  try {
    await sessionDB.updateSession(sessionIdToUse, {
      lastActivityAt: new Date().toISOString(),
      status: SessionStatus.MERGED,
    });
  } catch (e) {
    log.debug("Failed to update session activity state on PR merge", { error: e });
  }

  // Session cleanup after successful merge (default: enabled)
  let sessionCleanup: SessionMergeResult["sessionCleanup"];

  if (params.cleanupSession !== false) {
    try {
      // Removed noise padding for cleanup operations

      const cleanupResult = await cleanupSessionImpl(
        {
          sessionId: sessionIdToUse,
          taskId: sessionRecord.taskId,
          force: true, // After successful merge, we can force cleanup
        },
        { sessionDB: sessionDB }
      );

      sessionCleanup = {
        performed: true,
        directoriesRemoved: cleanupResult.directoriesRemoved,
        errors: cleanupResult.errors,
      };

      if (!params.json) {
        if (cleanupResult.directoriesRemoved.length > 0) {
          log.cli(`✅ Cleaned up ${cleanupResult.directoriesRemoved.length} session directories`);
        }
        if (cleanupResult.errors.length > 0) {
          log.cli(`⚠️  ${cleanupResult.errors.length} cleanup errors occurred`);
        }
        // Session record deletion is an implementation detail - no user output needed
      }
    } catch (cleanupError) {
      const errorMsg = `Session cleanup failed: ${getErrorMessage(cleanupError)}`;
      log.error(errorMsg, { sessionId: sessionIdToUse, error: cleanupError });

      sessionCleanup = {
        performed: false,
        directoriesRemoved: [],
        errors: [errorMsg],
      };

      if (!params.json) {
        log.cli(`⚠️  Warning: ${errorMsg}`);
        log.cli(`💡 You can manually clean up with: minsky session delete ${sessionIdToUse}`);
      }
    }
  }

  return {
    session: sessionIdToUse,
    taskId: sessionRecord.taskId,
    prBranch: sessionRecord.prBranch,
    mergeInfo,
    sessionCleanup,
  };
}
