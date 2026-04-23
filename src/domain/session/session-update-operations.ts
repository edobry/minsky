import {
  MinskyError,
  ResourceNotFoundError,
  ValidationError,
  getErrorMessage,
} from "../../errors/index";
import { parsePrDescriptionFromCommitMessage } from "./session-utils";
import type { SessionUpdateParameters } from "../../domain/schemas";
import { log } from "../../utils/logger";
import { type GitServiceInterface } from "../git";
import { ConflictDetectionService } from "../git/conflict-detection";
import type { SessionProviderInterface, SessionRecord, Session } from "../session";
import { resolveSessionContextWithFeedback } from "./session-context-resolver";
import { gitFetchWithTimeout } from "../../utils/git-exec";
import { assertSessionMutable } from "./session-mutability";
import { taskIdToBranchName } from "../tasks/task-id";

export interface UpdateSessionDependencies {
  gitService: GitServiceInterface;
  sessionDB: SessionProviderInterface;
  getCurrentSession: (repoPath?: string) => Promise<string | undefined>;
}

/**
 * Implementation of session update operation
 * Extracted from session.ts for better maintainability
 */
export async function updateSessionImpl(
  params: SessionUpdateParameters,
  deps: UpdateSessionDependencies
): Promise<Session> {
  const {
    name,
    branch,
    remote,
    noStash,
    noPush,
    force,
    skipConflictCheck: _skipConflictCheck,
    autoResolveDeleteConflicts,
    dryRun,
    skipIfAlreadyMerged,
  } = params;

  log.debug("updateSessionImpl called", { params });

  // Use unified session context resolver for consistent auto-detection
  let sessionId: string;
  try {
    const resolvedContext = await resolveSessionContextWithFeedback({
      session: name,
      task: params.task,
      repo: params.repo,
      sessionProvider: deps.sessionDB,
      allowAutoDetection: !name, // Only allow auto-detection if no name provided
      getCurrentSessionFn: deps.getCurrentSession,
    });
    sessionId = resolvedContext.sessionId;
    log.debug("Session resolved", { sessionId, resolvedBy: resolvedContext.resolvedBy });
  } catch (error) {
    log.debug("Failed to resolve session", { error, name, task: params.task });
    if (error instanceof ValidationError) {
      throw new ValidationError(
        "Session ID is required. Either provide a session ID (--name), task ID (--task), or run this command from within a session workspace."
      );
    }
    throw error;
  }

  log.debug("Dependencies set up", {
    hasGitService: !!deps.gitService,
    hasSessionDB: !!deps.sessionDB,
  });

  log.debug("Session update requested", {
    sessionId,
    branch,
    remote,
    noStash,
    noPush,
    force,
  });

  try {
    // Get session record
    log.debug("Getting session record", { name: sessionId });
    let sessionRecord = await deps.sessionDB.getSession(sessionId);

    // TASK #168 FIX: Self-repair logic for orphaned sessions
    if (!sessionRecord && sessionId) {
      log.debug("Session not found in database, attempting self-repair", { sessionId });
      const currentDir = process.cwd();

      // Check if we're in a session workspace
      if (currentDir.includes("/sessions/") && currentDir.includes(sessionId)) {
        log.debug("Detected orphaned session workspace, attempting to register", {
          sessionId,
          currentDir,
        });

        try {
          // Get repository URL from git remote
          const remoteOutput = await deps.gitService.execInRepository(
            currentDir,
            "git remote get-url origin"
          );
          const repoUrl = remoteOutput.trim();

          // Extract repo name from URL or path
          const repoName = repoUrl.includes("/")
            ? repoUrl.split("/").pop()?.replace(".git", "") || "unknown"
            : "local-minsky";

          // Extract task ID from session ID - simpler and more reliable approach
          const taskId = sessionId.startsWith("task#") ? sessionId : undefined;

          // Create session record
          const newSessionRecord: SessionRecord = {
            session: sessionId,
            repoName,
            repoUrl,
            createdAt: new Date().toISOString(),
            taskId,
            branch: taskId ? taskIdToBranchName(taskId) : sessionId,
          };

          await deps.sessionDB.addSession(newSessionRecord);
          sessionRecord = newSessionRecord;

          log.cli(`🔧 Self-repair: Registered orphaned session '${sessionId}' in database`);
        } catch (repairError) {
          log.warn("Failed to self-repair orphaned session", {
            sessionId,
            error: repairError instanceof Error ? repairError.message : String(repairError),
          });
        }
      }
    }

    if (!sessionRecord) {
      throw new ResourceNotFoundError(`Session '${sessionId}' not found`, "session", sessionId);
    }

    log.debug("Session record found", { sessionRecord });

    // Enforce merged-PR-freeze invariant
    assertSessionMutable(sessionRecord, "update the session");

    // Get session workdir
    const workdir = await deps.sessionDB.getSessionWorkdir(sessionId);
    log.debug("Session workdir resolved", { workdir });

    // Get current branch
    const currentBranch = await deps.gitService.getCurrentBranch(workdir);
    log.debug("Current branch", { currentBranch });

    // Validate current state if not forced
    if (!force) {
      const hasUncommittedChanges = await deps.gitService.hasUncommittedChanges(workdir);
      if (hasUncommittedChanges && !noStash) {
        log.debug("Stashing uncommitted changes", { workdir });
        await deps.gitService.stashChanges(workdir);
        log.debug("Changes stashed");
      }
    }

    try {
      // Fetch latest changes
      log.debug("Fetching latest changes", { workdir, remote: remote || "origin" });
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      await deps.gitService.fetchLatest!(workdir, remote || "origin");
      log.debug("Latest changes fetched");

      // Determine target branch for merge - use actual default branch from repo instead of hardcoding "main"
      const branchToMerge = branch || (await deps.gitService.fetchDefaultBranch(workdir));
      const remoteBranchToMerge = `${remote || "origin"}/${branchToMerge}`;

      // Enhanced conflict detection and smart merge handling
      if (dryRun) {
        log.cli("🔍 Performing dry run conflict check...");

        const conflictPrediction = await ConflictDetectionService.predictConflicts(
          workdir,
          currentBranch,
          remoteBranchToMerge
        );

        if (conflictPrediction.hasConflicts) {
          log.cli("⚠️  Conflicts detected during dry run:");
          log.cli(conflictPrediction.userGuidance);
          log.cli("\n🛠️  Recovery commands:");
          conflictPrediction.recoveryCommands.forEach((cmd) => log.cli(`   ${cmd}`));

          throw new MinskyError(
            "Dry run detected conflicts. Use the guidance above to resolve them."
          );
        } else {
          log.cli("✅ No conflicts detected. Safe to proceed with update.");
          return sessionRecord as Session;
        }
      }

      // Fix for origin/origin/main bug: Pass base branch name without origin/ prefix
      // ConflictDetectionService expects plain branch names and adds origin/ internally
      const normalizedBaseBranch = branchToMerge;

      // Use smart session update for enhanced conflict handling (only if not forced)
      if (!force) {
        const updateResult = await ConflictDetectionService.smartSessionUpdate(
          workdir,
          currentBranch,
          normalizedBaseBranch,
          {
            skipIfAlreadyMerged,
            autoResolveConflicts: autoResolveDeleteConflicts,
          }
        );

        if (!updateResult.updated && updateResult.skipped) {
          log.cli(`✅ ${updateResult.reason}`);

          if (updateResult.reason?.includes("already in base")) {
            log.cli("\n💡 Your session changes are already merged. Proceeding with PR creation...");
          }

          return sessionRecord as Session;
        }

        if (!updateResult.updated && updateResult.conflictDetails) {
          // Enhanced conflict guidance
          log.cli("🚫 Update failed due to merge conflicts:");
          log.cli(updateResult.conflictDetails);

          if (updateResult.divergenceAnalysis) {
            const analysis = updateResult.divergenceAnalysis;
            log.cli("\n📊 Branch Analysis:");
            log.cli(`   • Session ahead: ${analysis.aheadCommits} commits`);
            log.cli(`   • Session behind: ${analysis.behindCommits} commits`);
            log.cli(`   • Recommended action: ${analysis.recommendedAction}`);

            if (analysis.sessionChangesInBase) {
              log.cli(`\n💡 Your changes appear to already be in ${branchToMerge}. Try:`);
            }
          }

          // Make output more human-friendly (avoid raw JSON)
          throw new MinskyError(updateResult.conflictDetails);
        }

        log.debug("Enhanced merge completed successfully", { updateResult });
      } else {
        log.debug("Skipping conflict detection due to force flag", { force });
        // When forced, perform a simple merge without conflict detection
        try {
          await deps.gitService.mergeBranch(workdir, normalizedBaseBranch);
          log.debug("Forced merge completed");
        } catch (mergeError) {
          log.debug("Forced merge failed, but continuing due to force flag", {
            error: getErrorMessage(mergeError),
          });
        }
      }

      // Push changes if needed
      if (!noPush) {
        log.debug("Pushing changes to remote", { workdir, remote: remote || "origin" });
        await deps.gitService.push({
          repoPath: workdir,
          remote: remote || "origin",
        });
        log.debug("Changes pushed to remote");
      }

      // Restore stashed changes if we stashed them
      if (!noStash) {
        try {
          log.debug("Restoring stashed changes", { workdir });
          await deps.gitService.popStash(workdir);
          log.debug("Stashed changes restored");
        } catch (error) {
          log.warn("Failed to restore stashed changes", {
            error: getErrorMessage(error),
            workdir,
          });
          // Don't fail the entire operation if stash pop fails
        }
      }

      log.cli(`Session '${sessionId}' updated successfully`);

      return sessionRecord as Session;
    } catch (error) {
      // If there's an error during update, try to clean up any stashed changes
      if (!noStash) {
        try {
          await deps.gitService.popStash(workdir);
          log.debug("Restored stashed changes after error");
        } catch (stashError) {
          log.warn("Failed to restore stashed changes after error", {
            stashError: getErrorMessage(stashError),
          });
        }
      }
      throw error;
    }
  } catch (error) {
    log.error("Session update failed", {
      error: getErrorMessage(error),
      name: sessionId,
    });
    if (error instanceof MinskyError) {
      throw error;
    } else {
      throw new MinskyError(`Failed to update session: ${getErrorMessage(error)}`, error);
    }
  }
}

/**
 * Helper function to check if a PR branch exists for a session
 * Note: This function assumes pr/ format for legacy compatibility
 * For backend-aware checks, use checkPrBranchExistsOptimized
 */
export async function checkPrBranchExists(
  sessionId: string,
  gitService: GitServiceInterface,
  currentDir: string,
  branch?: string
): Promise<boolean> {
  const prBranch = `pr/${branch || sessionId}`;

  try {
    // Check if branch exists locally
    const localBranchOutput = await gitService.execInRepository(
      currentDir,
      `git show-ref --verify --quiet refs/heads/${prBranch} || echo "not-exists"`
    );
    const localBranchExists = localBranchOutput.trim() !== "not-exists";

    if (localBranchExists) {
      return true;
    }

    // Check if branch exists remotely
    const remoteBranchOutput = await gitService.execInRepository(
      currentDir,
      `git ls-remote --heads origin ${prBranch}`
    );
    const remoteBranchExists = remoteBranchOutput.trim().length > 0;

    return remoteBranchExists;
  } catch (error) {
    log.debug("Error checking PR branch existence", {
      error: getErrorMessage(error),
      prBranch,
      sessionId,
    });
    return false;
  }
}

/**
 * Check if PR state cache is stale (older than 5 minutes)
 */
function isPrStateStale(prState: { lastChecked: string }): boolean {
  const STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes
  const lastChecked = new Date(prState.lastChecked).getTime();
  const now = Date.now();
  return now - lastChecked > STALE_THRESHOLD_MS;
}

/**
 * Optimized PR branch existence check using cached state
 */
export async function checkPrBranchExistsOptimized(
  sessionId: string,
  gitService: GitServiceInterface,
  currentDir: string,
  sessionDB: SessionProviderInterface
): Promise<boolean> {
  const sessionRecord = await sessionDB.getSession(sessionId);

  // If no session record, fall back to git operations (legacy pr/ format)
  if (!sessionRecord) {
    log.debug("No session record found, falling back to git operations", { sessionId });
    return checkPrBranchExists(sessionId, gitService, currentDir);
  }

  // Check if we have cached PR state and it's not stale
  if (sessionRecord.prState && !isPrStateStale(sessionRecord.prState)) {
    log.debug("Using cached PR state", {
      sessionId,
      exists: !!sessionRecord.prState.exists,
      lastChecked: sessionRecord.prState.lastChecked,
    });
    return !!sessionRecord.prState.exists;
  }

  // Cache is stale or missing, perform git operations and update cache
  log.debug("PR state cache is stale or missing, refreshing", {
    sessionId,
    hasState: !!sessionRecord.prState,
    isStale: sessionRecord.prState ? isPrStateStale(sessionRecord.prState) : false,
  });

  const exists = await checkPrBranchExists(sessionId, gitService, currentDir, sessionRecord.branch);

  // Update the session record with fresh PR state
  const prBranch =
    sessionRecord.backendType === "github" ? sessionId : `pr/${sessionRecord.branch || sessionId}`;
  const updatedPrState = {
    branchName: prBranch,
    exists,
    lastChecked: new Date().toISOString(),
    createdAt: sessionRecord.prState?.createdAt || (exists ? new Date().toISOString() : undefined),
    mergedAt: sessionRecord.prState?.mergedAt,
  };

  await sessionDB.updateSession(sessionId, { prState: updatedPrState });

  log.debug("Updated PR state cache", {
    sessionId,
    exists,
    lastChecked: updatedPrState.lastChecked,
  });

  return exists;
}

/**
 * Update PR state when a PR branch is created
 */
export async function updatePrStateOnCreation(
  sessionId: string,
  sessionDB: SessionProviderInterface
): Promise<void> {
  // Get session record to determine backend type
  const sessionRecord = await sessionDB.getSession(sessionId);
  if (!sessionRecord) {
    log.warn(`Cannot update PR state: session '${sessionId}' not found`);
    return;
  }

  // Determine correct branch name based on backend type
  const prBranch =
    sessionRecord.backendType === "github" ? sessionId : `pr/${sessionRecord.branch || sessionId}`;

  const now = new Date().toISOString();

  const prState = {
    branchName: prBranch,
    exists: true,
    lastChecked: now,
    createdAt: now,
    mergedAt: undefined,
  };

  await sessionDB.updateSession(sessionId, {
    prBranch,
    prState,
  });

  log.debug("Updated PR state on creation", {
    sessionId,
    prBranch,
    backendType: sessionRecord.backendType,
    createdAt: now,
  });
}

/**
 * Project an existing prState blob down to the current type's allowed keys.
 * Prevents stale fields in persisted JSON from surviving a partial update.
 */
export function projectPrState(
  existing: NonNullable<SessionRecord["prState"]>
): NonNullable<SessionRecord["prState"]> {
  return {
    branchName: existing.branchName,
    exists: existing.exists,
    lastChecked: existing.lastChecked,
    createdAt: existing.createdAt,
    mergedAt: existing.mergedAt,
  };
}

/**
 * Update PR state when a PR branch is merged
 */
export async function updatePrStateOnMerge(
  sessionId: string,
  sessionDB: SessionProviderInterface
): Promise<void> {
  const now = new Date().toISOString();

  const sessionRecord = await sessionDB.getSession(sessionId);
  if (!sessionRecord?.prState) {
    log.debug("No PR state found for session, cannot update merge state", { sessionId });
    return;
  }

  // Project to known keys to avoid propagating stale fields from older JSON blobs.
  const updatedPrState = {
    ...projectPrState(sessionRecord.prState),
    exists: false,
    lastChecked: now,
    mergedAt: now,
  };

  await sessionDB.updateSession(sessionId, { prState: updatedPrState });

  log.debug("Updated PR state on merge", {
    sessionId,
    mergedAt: now,
  });
}

/**
 * Helper function to extract title and body from existing PR branch
 * Fixed to prevent title duplication in body content
 */
export async function extractPrDescription(
  sessionId: string,
  gitService: GitServiceInterface,
  currentDir: string,
  sessionDB?: SessionProviderInterface
): Promise<{ title: string; body: string } | null> {
  // Resolve the actual branch name from session record if sessionDB is available
  let branchComponent = sessionId;
  if (sessionDB) {
    try {
      const record = await sessionDB.getSession(sessionId);
      if (record?.branch) {
        branchComponent = record.branch;
      }
    } catch {
      // Ignore errors looking up session record
    }
  }
  const prBranch = `pr/${branchComponent}`;

  try {
    // Try to get from remote first
    const remoteBranchOutput = await gitService.execInRepository(
      currentDir,
      `git ls-remote --heads origin ${prBranch}`
    );
    const remoteBranchExists = remoteBranchOutput.trim().length > 0;

    let commitMessage = "";

    if (remoteBranchExists) {
      // Fetch the PR branch to ensure we have latest
      await gitFetchWithTimeout("origin", prBranch, { workdir: currentDir });

      // Get the commit message from the remote branch's last commit
      commitMessage = await gitService.execInRepository(
        currentDir,
        `git log -1 --pretty=format:%B origin/${prBranch}`
      );
    } else {
      // Check if branch exists locally
      const localBranchOutput = await gitService.execInRepository(
        currentDir,
        `git show-ref --verify --quiet refs/heads/${prBranch} || echo "not-exists"`
      );
      const localBranchExists = localBranchOutput.trim() !== "not-exists";

      if (localBranchExists) {
        // Get the commit message from the local branch's last commit
        commitMessage = await gitService.execInRepository(
          currentDir,
          `git log -1 --pretty=format:%B ${prBranch}`
        );
      } else {
        return null;
      }
    }

    return parsePrDescriptionFromCommitMessage(commitMessage);
  } catch (error) {
    log.debug("Error extracting PR description", {
      error: getErrorMessage(error),
      prBranch,
      sessionId,
    });
    return null;
  }
}
