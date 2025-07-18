import { getMinskyStateDir, getSessionDir } from "../../utils/paths";
import {
  MinskyError,
  ResourceNotFoundError,
  ValidationError,
  getErrorMessage,
} from "../../errors/index";
import type { SessionUpdateParams } from "../../schemas/session";
import { log } from "../../utils/logger";
import { type GitServiceInterface } from "../git";
import { getCurrentSession } from "../workspace";
import { ConflictDetectionService } from "../git/conflict-detection";
import type { SessionProviderInterface, SessionRecord, Session } from "../session";
import { resolveSessionContextWithFeedback } from "./session-context-resolver";

export interface UpdateSessionDependencies {
  gitService: GitServiceInterface;
  sessionDB: SessionProviderInterface;
  getCurrentSession: typeof getCurrentSession;
}

/**
 * Implementation of session update operation
 * Extracted from session.ts for better maintainability
 */
export async function updateSessionImpl(
  params: SessionUpdateParams,
  deps: UpdateSessionDependencies
): Promise<Session> {
  let { name, branch, remote, noStash, noPush, force, skipConflictCheck, autoResolveDeleteConflicts, dryRun, skipIfAlreadyMerged } = params;

  log.debug("updateSessionImpl called", { params });

  // Use unified session context resolver for consistent auto-detection
  let sessionName: string;
  try {
    const resolvedContext = await resolveSessionContextWithFeedback({
      session: name,
      task: params.task,
      repo: params.repo,
      sessionProvider: deps.sessionDB,
      allowAutoDetection: !name, // Only allow auto-detection if no name provided
    });
    sessionName = resolvedContext.sessionName;
    log.debug("Session resolved", { sessionName, resolvedBy: resolvedContext.resolvedBy });
  } catch (error) {
    log.debug("Failed to resolve session", { error, name, task: params.task });
    if (error instanceof ValidationError) {
      throw new ValidationError(
        "Session name is required. Either provide a session name (--name), task ID (--task), or run this command from within a session workspace."
      );
    }
    throw error;
  }

  log.debug("Dependencies set up", {
    hasGitService: !!deps.gitService,
    hasSessionDB: !!deps.sessionDB,
  });

  log.debug("Session update requested", {
    sessionName,
    branch,
    remote,
    noStash,
    noPush,
    force,
  });

  try {
    // Get session record
    log.debug("Getting session record", { name: sessionName });
    let sessionRecord = await deps.sessionDB.getSession(sessionName);

    // TASK #168 FIX: Self-repair logic for orphaned sessions
    if (!sessionRecord && sessionName) {
      log.debug("Session not found in database, attempting self-repair", { sessionName });
      const currentDir = process.cwd();

      // Check if we're in a session workspace
      if (currentDir.includes("/sessions/") && currentDir.includes(sessionName)) {
        log.debug("Detected orphaned session workspace, attempting to register", {
          sessionName,
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

          // Extract task ID from session name - simpler and more reliable approach
          const taskId = sessionName.startsWith("task#") ? sessionName : undefined;

          // Create session record
          const newSessionRecord: SessionRecord = {
            session: sessionName,
            repoName,
            repoUrl,
            createdAt: new Date().toISOString(),
            taskId,
            branch: sessionName,
          };

          await deps.sessionDB.addSession(newSessionRecord);
          sessionRecord = newSessionRecord;

          log.cli(`🔧 Self-repair: Registered orphaned session '${sessionName}' in database`);
        } catch (repairError) {
          log.warn("Failed to self-repair orphaned session", {
            sessionName,
            error: repairError instanceof Error ? repairError.message : String(repairError),
          });
        }
      }
    }

    if (!sessionRecord) {
      throw new ResourceNotFoundError(`Session '${sessionName}' not found`, "session", sessionName);
    }

    log.debug("Session record found", { sessionRecord });

    // Get session workdir
    const workdir = await deps.sessionDB.getSessionWorkdir(sessionName);
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
      // Pull latest changes
      log.debug("Pulling latest changes", { workdir, remote: remote || "origin" });
      await deps.gitService.pullLatest(workdir, remote || "origin");
      log.debug("Latest changes pulled");

      // Determine target branch for merge - use actual default branch from repo instead of hardcoding "main"
      const branchToMerge = branch || await deps.gitService.fetchDefaultBranch(workdir);
      const remoteBranchToMerge = `${remote || "origin"}/${branchToMerge}`;

      // Enhanced conflict detection and smart merge handling
      if (dryRun) {
        log.cli("🔍 Performing dry run conflict check...");

        const conflictPrediction = await ConflictDetectionService.predictConflicts(
          workdir, currentBranch, remoteBranchToMerge
        );

        if (conflictPrediction.hasConflicts) {
          log.cli("⚠️  Conflicts detected during dry run:");
          log.cli(conflictPrediction.userGuidance);
          log.cli("\n🛠️  Recovery commands:");
          conflictPrediction.recoveryCommands.forEach(cmd => log.cli(`   ${cmd}`));

          throw new MinskyError("Dry run detected conflicts. Use the guidance above to resolve them.");
        } else {
          log.cli("✅ No conflicts detected. Safe to proceed with update.");
          return {
            session: sessionName,
            repoName: sessionRecord.repoName || "unknown",
            repoUrl: sessionRecord.repoUrl,
            branch: currentBranch,
            createdAt: sessionRecord.createdAt,
            taskId: sessionRecord.taskId,
          };
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
            autoResolveConflicts: autoResolveDeleteConflicts
          }
        );

        if (!updateResult.updated && updateResult.skipped) {
          log.cli(`✅ ${updateResult.reason}`);

          if (updateResult.reason?.includes("already in base")) {
            log.cli("\n💡 Your session changes are already merged. You can create a PR with --skip-update:");
            log.cli("   minsky session pr --title \"Your PR title\" --skip-update");
          }

          return {
            session: sessionName,
            repoName: sessionRecord.repoName || "unknown",
            repoUrl: sessionRecord.repoUrl,
            branch: currentBranch,
            createdAt: sessionRecord.createdAt,
            taskId: sessionRecord.taskId,
          };
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
              log.cli("   minsky session pr --title \"Your PR title\" --skip-update");
            }
          }

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
          log.debug("Forced merge failed, but continuing due to force flag", { error: getErrorMessage(mergeError) });
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

      log.cli(`Session '${sessionName}' updated successfully`);

      return {
        session: sessionName,
        repoName: sessionRecord.repoName || "unknown",
        repoUrl: sessionRecord.repoUrl,
        branch: currentBranch,
        createdAt: sessionRecord.createdAt,
        taskId: sessionRecord.taskId,
      };
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
      name: sessionName,
    });
    if (error instanceof MinskyError) {
      throw error;
    } else {
      throw new MinskyError(
        `Failed to update session: ${getErrorMessage(error)}`,
        error
      );
    }
  }
}

/**
 * Helper function to check if a PR branch exists for a session
 */
export async function checkPrBranchExists(
  sessionName: string,
  gitService: GitServiceInterface,
  currentDir: string
): Promise<boolean> {
  const prBranch = `pr/${sessionName}`;

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
      sessionName,
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
  return (now - lastChecked) > STALE_THRESHOLD_MS;
}

/**
 * Optimized PR branch existence check using cached state
 */
export async function checkPrBranchExistsOptimized(
  sessionName: string,
  gitService: GitServiceInterface,
  currentDir: string,
  sessionDB: SessionProviderInterface
): Promise<boolean> {
  const sessionRecord = await sessionDB.getSession(sessionName);

  // If no session record, fall back to git operations
  if (!sessionRecord) {
    log.debug("No session record found, falling back to git operations", { sessionName });
    return checkPrBranchExists(sessionName, gitService, currentDir);
  }

  // Check if we have cached PR state and it's not stale
  if (sessionRecord.prState && !isPrStateStale(sessionRecord.prState)) {
    log.debug("Using cached PR state", {
      sessionName,
      exists: sessionRecord.prState.exists,
      lastChecked: sessionRecord.prState.lastChecked
    });
    return sessionRecord.prState.exists;
  }

  // Cache is stale or missing, perform git operations and update cache
  log.debug("PR state cache is stale or missing, refreshing", {
    sessionName,
    hasState: !!sessionRecord.prState,
    isStale: sessionRecord.prState ? isPrStateStale(sessionRecord.prState) : false
  });

  const exists = await checkPrBranchExists(sessionName, gitService, currentDir);

  // Update the session record with fresh PR state
  const prBranch = `pr/${sessionName}`;
  const updatedPrState = {
    branchName: prBranch,
    exists,
    lastChecked: new Date().toISOString(),
    createdAt: sessionRecord.prState?.createdAt || (exists ? new Date().toISOString() : undefined),
    mergedAt: sessionRecord.prState?.mergedAt
  };

  await sessionDB.updateSession(sessionName, { prState: updatedPrState });

  log.debug("Updated PR state cache", {
    sessionName,
    exists,
    lastChecked: updatedPrState.lastChecked
  });

  return exists;
}

/**
 * Update PR state when a PR branch is created
 */
export async function updatePrStateOnCreation(
  sessionName: string,
  sessionDB: SessionProviderInterface
): Promise<void> {
  const prBranch = `pr/${sessionName}`;
  const now = new Date().toISOString();

  const prState = {
    branchName: prBranch,
    exists: true,
    lastChecked: now,
    createdAt: now,
    mergedAt: undefined
  };

  await sessionDB.updateSession(sessionName, { prState });

  log.debug("Updated PR state on creation", {
    sessionName,
    prBranch,
    createdAt: now
  });
}

/**
 * Update PR state when a PR branch is merged
 */
export async function updatePrStateOnMerge(
  sessionName: string,
  sessionDB: SessionProviderInterface
): Promise<void> {
  const now = new Date().toISOString();

  const sessionRecord = await sessionDB.getSession(sessionName);
  if (!sessionRecord?.prState) {
    log.debug("No PR state found for session, cannot update merge state", { sessionName });
    return;
  }

  const updatedPrState = {
    ...sessionRecord.prState,
    exists: false,
    lastChecked: now,
    mergedAt: now
  };

  await sessionDB.updateSession(sessionName, { prState: updatedPrState });

  log.debug("Updated PR state on merge", {
    sessionName,
    mergedAt: now
  });
}

/**
 * Helper function to extract title and body from existing PR branch
 * Fixed to prevent title duplication in body content
 */
export async function extractPrDescription(
  sessionName: string,
  gitService: GitServiceInterface,
  currentDir: string
): Promise<{ title: string; body: string } | null> {
  const prBranch = `pr/${sessionName}`;

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
      await gitService.execInRepository(currentDir, `git fetch origin ${prBranch}`);

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

    // Parse the commit message more intelligently to prevent title duplication
    const lines = commitMessage.trim().split("\n");
    const title = lines[0] || "";
    
    // Filter out empty lines and prevent title duplication in body
    const bodyLines = lines.slice(1).filter(line => line.trim() !== "");
    
    // Check if first line of body duplicates the title
    let body = "";
    if (bodyLines.length > 0) {
      // If first body line is identical to title, skip it to prevent duplication
      const firstBodyLine = bodyLines[0]?.trim() || "";
      if (firstBodyLine === title.trim()) {
        body = bodyLines.slice(1).join("\n").trim();
        log.debug("Removed duplicate title from PR body", {
          sessionName,
          originalTitle: title,
          duplicatedLine: firstBodyLine,
        });
      } else {
        body = bodyLines.join("\n").trim();
      }
    }

    return { title, body };
  } catch (error) {
    log.debug("Error extracting PR description", {
      error: getErrorMessage(error),
      prBranch,
      sessionName,
    });
    return null;
  }
} 
