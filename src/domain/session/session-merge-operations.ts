/**
 * Session Merge Operations (Task #358)
 *
 * This module implements session PR merge functionality that requires
 * PR approval before allowing merge, enabling standard collaborative workflows.
 */

import { log } from "../../utils/logger";
import { MinskyError, ValidationError, ResourceNotFoundError } from "../../errors/index";
import { createSessionProvider, type SessionProviderInterface } from "./session-db-adapter";
import {
  detectRepositoryBackendTypeFromUrl,
  extractGitHubInfoFromUrl,
} from "./repository-backend-detection";
import {
  createRepositoryBackend,
  RepositoryBackendType,
  type RepositoryBackendConfig,
  type MergeInfo,
} from "../repository/index";
import { createConfiguredTaskService } from "../tasks/taskService";
import { createGitService } from "../git";
import { TASK_STATUS } from "../tasks/taskConstants";
import { getErrorMessage } from "../../errors";
import type { SessionRecord } from "./types";
import { cleanupSessionImpl } from "./session-lifecycle-operations";
import { cleanupLocalBranches } from "./session-approve-operations";
import { resolveRepository } from "../repository";

/**
 * CRITICAL: Validate that a session is approved before allowing merge
 *
 * This function enforces the approval requirement across all merge operations.
 * NO MERGE SHOULD EVER BYPASS THIS VALIDATION.
 */
export function validateSessionApprovedForMerge(
  sessionRecord: SessionRecord,
  sessionName: string
): void {
  // For GitHub backend, presence of a recorded PR is sufficient for further checks
  if ((sessionRecord as any).backendType === "github") {
    if (!(sessionRecord as any).pullRequest) {
      throw new ValidationError(
        `❌ MERGE REJECTED: Session "${sessionName}" has no GitHub pull request.\n` +
          `   Create or repair the PR first with 'minsky session pr create' or 'minsky session pr get'`
      );
    }
    // Approval and mergeability are delegated to the GitHub backend in mergeSessionPr()
    return;
  }

  // Local/remote backends require a PR branch and explicit approval flag
  if (!sessionRecord.prBranch) {
    throw new ValidationError(
      `❌ MERGE REJECTED: Session "${sessionName}" has no PR branch.\n` +
        `   Create a PR first with 'minsky session pr create'`
    );
  }

  if (sessionRecord.prApproved !== true) {
    throw new ValidationError(
      `❌ MERGE REJECTED: Invalid approval state for session "${sessionName}". PR must be approved before merging.`
    );
  }

  log.debug("Session approval validation passed", {
    sessionName,
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
 * Merge a session's approved pull request (Task #358)
 *
 * This function:
 * 1. Validates the session has a PR branch
 * 2. Validates the PR is approved (prApproved: true)
 * 3. Calls repositoryBackend.mergePullRequest()
 * 4. Updates session record
 *
 * Requires the PR to be approved first.
 */
export async function mergeSessionPr(
  params: SessionMergeParams,
  deps?: {
    sessionDB?: SessionProviderInterface;
    taskService?: {
      setTaskStatus?: (taskId: string, status: string) => Promise<any>;
      getTaskStatus?: (taskId: string) => Promise<string | undefined>;
      getBackendForTask?: (taskId: string) => Promise<any>;
      getTask?: (taskId: string) => Promise<any>;
    };
    gitService?: any;
    createRepositoryBackend?: (config: RepositoryBackendConfig) => Promise<any>;
  }
): Promise<SessionMergeResult> {
  if (!params.json) {
    log.cli("🔄 Starting session merge...");
  }

  // Set up session provider
  const sessionDB = deps?.sessionDB || createSessionProvider();

  // Resolve session name
  let sessionNameToUse = params.session;

  if (params.task && !sessionNameToUse) {
    const sessionByTask = await sessionDB.getSessionByTaskId(params.task);
    if (!sessionByTask) {
      throw new ResourceNotFoundError(
        `No session found for task ${params.task}`,
        "session",
        params.task
      );
    }
    sessionNameToUse = sessionByTask.session;
  }

  if (!sessionNameToUse) {
    throw new ValidationError("No session detected. Please provide a session name or task ID");
  }

  // Get session record
  const sessionRecord = await sessionDB.getSession(sessionNameToUse);
  if (!sessionRecord) {
    throw new ResourceNotFoundError(
      `Session "${sessionNameToUse}" not found`,
      "session",
      sessionNameToUse
    );
  }

  // CRITICAL SECURITY VALIDATION: Use centralized approval validation
  // This ensures consistent security enforcement across all merge operations
  validateSessionApprovedForMerge(sessionRecord, sessionNameToUse);

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

  // Set up dependencies with proper task backend configuration
  // Use createConfiguredTaskService to respect the configured backend (like GitHub Issues)
  const taskService =
    deps?.taskService ||
    (await createConfiguredTaskService({
      workspacePath: originalRepoPath,
    }));
  const gitService = deps?.gitService || createGitService();

  // Create repository backend for this session
  // Use stored repoUrl for backend detection to avoid redundant git commands
  const repoUrl = params.repo || sessionRecord.repoUrl || process.cwd();
  const backendType =
    (sessionRecord as any).backendType || detectRepositoryBackendTypeFromUrl(repoUrl);

  // For merge operations, we still need a working directory (session workspace)
  const workingDirectory = await sessionDB.getSessionWorkdir(sessionNameToUse);

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

  const createBackendFunc = deps?.createRepositoryBackend || createRepositoryBackend;
  const repositoryBackend = await createBackendFunc(config);

  if (!params.json) {
    log.cli(`📦 Using ${repositoryBackend.getType()} backend for merge`);
  }

  // Re-check PR existence for merge operation
  const hasLocalPr = sessionRecord.prBranch;
  const hasGitHubPr = sessionRecord.pullRequest && sessionRecord.backendType === "github";

  // For GitHub backend, check approval status via API before proceeding
  if (hasGitHubPr && sessionRecord.pullRequest) {
    if (!params.json) {
      log.cli(`🔍 Checking GitHub PR approval & branch protection...`);
    }

    try {
      const approvalStatus = await repositoryBackend.getPullRequestApprovalStatus(
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
  if ((sessionRecord as any).backendType === "github" && (sessionRecord as any).pullRequest) {
    prIdentifier = (sessionRecord as any).pullRequest.number as number;
  }

  if (!params.json) {
    const displayId = typeof prIdentifier === "number" ? `#${prIdentifier}` : String(prIdentifier);
    log.cli(`🔀 Merging ${displayId}`);
  }

  if (prIdentifier === undefined) {
    throw new ValidationError("No PR identifier available for merge");
  }

  const mergeInfo = await repositoryBackend.mergePullRequest(prIdentifier, sessionNameToUse);

  if (!params.json) {
    log.cli("✅ Session PR merged successfully!");
    log.cli(`📝 Merge commit: ${mergeInfo.commitHash.substring(0, 8)}...`);
  }

  // Clean up local branches in main repository after successful merge
  try {
    if (!params.json) {
      log.cli("🧹 Cleaning up local branches...");
    }

    // For branch cleanup, we need to work in the main repository, not session workspace
    const mainRepoPath = originalRepoPath;

    await cleanupLocalBranches(
      gitService,
      mainRepoPath,
      sessionRecord.prBranch || "",
      sessionNameToUse,
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
      // Check current status first to avoid unnecessary updates
      const currentStatus = await taskService.getTaskStatus(taskId);

      if (currentStatus !== TASK_STATUS.DONE) {
        if (!params.json) {
          log.cli(`📋 Updating task ${taskId} status to DONE...`);
        }
        log.debug(`Updating task ${taskId} status from ${currentStatus} to DONE`);
        await taskService.setTaskStatus(taskId, TASK_STATUS.DONE);

        // After updating task status, check if there are uncommitted changes that need to be committed
        try {
          const statusOutput = await gitService.execInRepository(
            originalRepoPath,
            "git status --porcelain"
          );
          const hasUncommittedChanges = statusOutput.trim().length > 0;

          if (hasUncommittedChanges) {
            if (!params.json) {
              log.cli("📝 Committing task status update...");
            }
            log.debug("Task status update created uncommitted changes, committing them");

            // Stage the tasks.md file (or any other changed files from task status update)
            await gitService.execInRepository(originalRepoPath, "git add process/tasks.md");

            // Commit the task status update with conventional commits format
            try {
              await gitService.execInRepository(
                originalRepoPath,
                `git commit -m "chore(${taskId}): update task status to DONE"`
              );
              log.debug(`Committed task ${taskId} status update`);

              // Try to push the commit
              try {
                await gitService.execInRepository(originalRepoPath, "git push");
                log.debug(`Pushed task ${taskId} status update`);
                if (!params.json) {
                  log.cli("✅ Task status updated and committed");
                }
              } catch (pushError) {
                // Log but don't fail if push fails
                log.warn("Failed to push task status commit", {
                  taskId,
                  error: getErrorMessage(pushError),
                });
                if (!params.json) {
                  log.cli("⚠️  Task status updated but failed to push");
                }
              }
            } catch (commitError) {
              // Handle pre-commit hook failures gracefully
              const errorMsg = getErrorMessage(commitError as Error);
              if (errorMsg.includes("pre-commit") || errorMsg.includes("lint")) {
                if (!params.json) {
                  log.cli("⚠️  Task status updated but commit had linting issues");
                  log.cli("💡 Run 'bun run lint:fix' to address any remaining issues");
                }
                log.warn("Task status commit failed due to pre-commit checks");
              } else {
                throw commitError;
              }
            }
          } else {
            log.debug("No uncommitted changes from task status update");
            if (!params.json) {
              log.cli("✅ Task status updated");
            }
          }
        } catch (commitError) {
          // Log the error but don't fail the whole operation
          const errorMsg = `Failed to commit task status update: ${getErrorMessage(commitError as Error)}`;
          log.error(errorMsg, { taskId, error: commitError });
          if (!params.json) {
            log.cli(`⚠️  Warning: ${errorMsg}`);
          }
        }
      } else {
        log.debug(`Task ${taskId} is already DONE, skipping status update`);
        if (!params.json) {
          log.cli("ℹ️  Task is already marked as DONE");
        }
      }
    } catch (error) {
      // Log the error but don't fail the whole operation
      const errorMsg = `Failed to update task status: ${getErrorMessage(error)}`;
      log.error(errorMsg, { taskId, error });
      if (!params.json) {
        log.cli(`⚠️  Warning: ${errorMsg}`);
      }
    }
  }

  // Session cleanup after successful merge (default: enabled)
  let sessionCleanup: SessionMergeResult["sessionCleanup"];

  if (params.cleanupSession !== false) {
    try {
      if (!params.json) {
        log.cli("🧹 Cleaning up session artifacts...");
      }

      const cleanupResult = await cleanupSessionImpl(
        {
          sessionName: sessionNameToUse,
          taskId: sessionRecord.taskId,
          force: true, // After successful merge, we can force cleanup
        },
        { sessionDB: sessionDB as any }
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
        if (cleanupResult.sessionDeleted) {
          log.cli("✅ Session record removed from database");
        }
      }
    } catch (cleanupError) {
      const errorMsg = `Session cleanup failed: ${getErrorMessage(cleanupError)}`;
      log.error(errorMsg, { sessionName: sessionNameToUse, error: cleanupError });

      sessionCleanup = {
        performed: false,
        directoriesRemoved: [],
        errors: [errorMsg],
      };

      if (!params.json) {
        log.cli(`⚠️  Warning: ${errorMsg}`);
        log.cli(`💡 You can manually clean up with: minsky session delete ${sessionNameToUse}`);
      }
    }
  }

  return {
    session: sessionNameToUse,
    taskId: sessionRecord.taskId,
    prBranch: sessionRecord.prBranch,
    mergeInfo,
    sessionCleanup,
  };
}
