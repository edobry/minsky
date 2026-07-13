/**
 * Session Branch Cleanup (mt#2614)
 *
 * Extracted from session-approve-operations.ts, where this function lived
 * alongside an unrelated legacy merge-and-approve implementation
 * (now session-approve-legacy-operations.ts). This is the live call path:
 * session-merge-operations.ts's mergeSessionPr() imports cleanupLocalBranches
 * for post-merge local-branch cleanup.
 */

import { getErrorMessage } from "../errors/index";
import { log } from "@minsky/shared/logger";
import { type GitServiceInterface } from "../git";

/**
 * Clean up local branches after successful merge
 * Handles failures gracefully to not break the overall approval process
 */
export async function cleanupLocalBranches(
  gitService: GitServiceInterface,
  workingDirectory: string,
  prBranch: string,
  sessionId: string,
  taskId?: string
): Promise<void> {
  // Clean up the PR branch (e.g., pr/task#265)
  try {
    await gitService.execInRepository(workingDirectory, `git branch -d ${prBranch}`);
    log.debug(`Successfully deleted local PR branch: ${prBranch}`);
  } catch (error) {
    // Check if it's because branch is not fully merged
    const errorMessage = getErrorMessage(error);
    if (errorMessage.includes("not fully merged")) {
      // Try force delete
      try {
        await gitService.execInRepository(workingDirectory, `git branch -D ${prBranch}`);
        log.debug(`Successfully force-deleted local PR branch: ${prBranch}`);
      } catch (forceError) {
        log.debug(
          `Failed to force-delete local PR branch ${prBranch}: ${getErrorMessage(forceError)}`
        );
      }
    } else {
      log.debug(`Failed to delete local PR branch ${prBranch}: ${errorMessage}`);
    }
  }

  // For task branches, be smarter about which ones to try
  // First, check what branches actually exist locally
  try {
    const allBranchesOutput = await gitService.execInRepository(
      workingDirectory,
      'git branch --format="%(refname:short)"'
    );
    const existingBranches: string[] = allBranchesOutput
      .split("\n")
      .map((b) => b.trim())
      .filter((b) => b && b !== prBranch);

    // Extract task ID from session ID if not provided and session follows task# pattern
    const taskBranchName = taskId ? taskId.replace("#", "") : sessionId.replace("task#", "");

    // Build list of possible task branch names
    const possibleTaskBranches: string[] = [];

    // Add sessionId if it looks like a task branch and exists
    if (sessionId && sessionId !== prBranch && existingBranches.includes(sessionId)) {
      possibleTaskBranches.push(sessionId);
    }

    // Add numeric version if it exists
    if (
      taskBranchName &&
      taskBranchName !== sessionId &&
      existingBranches.includes(taskBranchName)
    ) {
      possibleTaskBranches.push(taskBranchName);
    }

    // Add task prefix versions if they exist
    if (taskBranchName) {
      const taskVariants: string[] = [`task${taskBranchName}`, `task#${taskBranchName}`];
      for (const variant of taskVariants) {
        if (variant !== sessionId && existingBranches.includes(variant)) {
          possibleTaskBranches.push(variant);
        }
      }
    }

    // Only try to delete branches that actually exist
    for (const branch of possibleTaskBranches) {
      try {
        await gitService.execInRepository(workingDirectory, `git branch -d ${branch}`);
        log.debug(`Successfully deleted local task branch: ${branch}`);
        break; // Stop after first successful deletion
      } catch (error) {
        const errorMessage = getErrorMessage(error);
        if (errorMessage.includes("not fully merged")) {
          // Try force delete
          try {
            await gitService.execInRepository(workingDirectory, `git branch -D ${branch}`);
            log.debug(`Successfully force-deleted local task branch: ${branch}`);
            break; // Stop after successful force deletion
          } catch (forceError) {
            log.debug(
              `Failed to force-delete local task branch ${branch}: ${getErrorMessage(forceError)}`
            );
          }
        } else {
          log.debug(`Failed to delete local task branch ${branch}: ${errorMessage}`);
        }
      }
    }
  } catch (listError) {
    // If we can't list branches, fall back to trying common patterns (but only warn, don't error)
    log.debug(`Could not list local branches for cleanup: ${getErrorMessage(listError)}`);
  }
}
