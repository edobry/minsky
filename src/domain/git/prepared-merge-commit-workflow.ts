import { execGitWithTimeout } from "../../utils/git-exec";
import { MinskyError, getErrorMessage } from "../../errors/index";
import { log } from "../../utils/logger";
import { createSessionProvider, type SessionProviderInterface } from "../session";
import type { PRInfo, MergeInfo } from "../repository/index";

/**
 * Prepared Merge Commit Workflow
 *
 * This module implements the prepared merge commit workflow used by
 * LocalGitBackend and RemoteGitBackend. It creates a PR branch with
 * a prepared merge commit that can be fast-forward merged later.
 */

export interface PreparedMergeCommitOptions {
  title: string;
  body: string;
  sourceBranch: string;
  baseBranch: string;
  workdir: string;
  session?: string;
}

export interface PreparedMergeCommitMergeOptions {
  prIdentifier: string | number;
  workdir: string;
  session?: string;
}

/**
 * Create a pull request using the prepared merge commit workflow
 * This creates a PR branch with a merge commit prepared for approval
 */
export async function createPreparedMergeCommitPR(
  options: PreparedMergeCommitOptions
): Promise<PRInfo> {
  const { title, body, sourceBranch, baseBranch, workdir } = options;

  // Generate PR branch name from title
  const prBranchName = titleToBranchName(title);
  const prBranch = `pr/${prBranchName}`;

  try {
    // Ensure we're on the source branch
    await execGitWithTimeout("switch", `switch ${sourceBranch}`, { workdir, timeout: 30000 });

    // Create and checkout the PR branch
    try {
      await execGitWithTimeout("branch", `branch ${prBranch}`, { workdir, timeout: 30000 });
    } catch (err) {
      // Branch might already exist, try to delete and recreate
      try {
        await execGitWithTimeout("branch", `branch -D ${prBranch}`, { workdir, timeout: 30000 });
        await execGitWithTimeout("branch", `branch ${prBranch}`, { workdir, timeout: 30000 });
      } catch (deleteErr) {
        throw new MinskyError(`Failed to create PR branch: ${getErrorMessage(err as any)}`);
      }
    }

    // Switch to PR branch
    await execGitWithTimeout("switch", `switch ${prBranch}`, { workdir, timeout: 30000 });

    // Create commit message for merge commit
    let commitMessage = title;
    if (body) {
      commitMessage += `\n\n${body}`;
    }

    // Merge source branch INTO PR branch with --no-ff (prepared merge commit)
    const escapedCommitMessage = commitMessage.replace(/"/g, '\\"');
    await execGitWithTimeout(
      "merge",
      `merge --no-ff ${sourceBranch} -m "${escapedCommitMessage}"`,
      { workdir, timeout: 180000 }
    );

    // Push the PR branch to remote
    await execGitWithTimeout("push", `push origin ${prBranch} --force`, {
      workdir,
      timeout: 30000,
    });

    // Switch back to source branch
    await execGitWithTimeout("switch", `switch ${sourceBranch}`, { workdir, timeout: 30000 });

    return {
      number: prBranch, // Use branch name as identifier for local/remote repos
      url: prBranch, // Use branch name as URL for local/remote repos
      state: "open",
      metadata: {
        prBranch,
        baseBranch,
        sourceBranch,
        title,
        body,
        workdir,
        workflow: "prepared-merge-commit",
      },
    };
  } catch (error) {
    // Clean up on error - try to switch back to source branch
    try {
      await execGitWithTimeout("switch", `switch ${sourceBranch}`, { workdir, timeout: 30000 });
    } catch (cleanupErr) {
      log.warn("Failed to switch back to source branch after error", { cleanupErr });
    }

    throw new MinskyError(
      `Failed to create prepared merge commit PR: ${getErrorMessage(error as any)}`
    );
  }
}

/**
 * Merge a pull request using the prepared merge commit workflow
 * This merges the PR branch into the base branch using fast-forward merge
 */
export async function mergePreparedMergeCommitPR(
  options: PreparedMergeCommitMergeOptions
): Promise<MergeInfo> {
  const { prIdentifier, workdir } = options;
  const prBranch = typeof prIdentifier === "string" ? prIdentifier : `pr/${prIdentifier}`;

  try {
    // Determine base branch (default to main if not specified)
    const baseBranch = "main"; // Could be parameterized later

    // Switch to base branch
    await execGitWithTimeout("switch", `switch ${baseBranch}`, { workdir, timeout: 30000 });

    // Pull latest changes
    await execGitWithTimeout("pull", `pull origin ${baseBranch}`, { workdir, timeout: 60000 });

    // Merge the PR branch (this should be a fast-forward since PR branch has the prepared merge commit)
    await execGitWithTimeout("merge", `merge --no-ff ${prBranch}`, { workdir, timeout: 180000 });

    // Get merge information
    const commitHash = (
      await execGitWithTimeout("rev-parse", "rev-parse HEAD", { workdir, timeout: 10000 })
    ).stdout.trim();
    const mergeDate = new Date().toISOString();
    const mergedBy = (
      await execGitWithTimeout("config", "config user.name", { workdir, timeout: 10000 })
    ).stdout.trim();

    // Push the merge to remote
    await execGitWithTimeout("push", `push origin ${baseBranch}`, { workdir, timeout: 60000 });

    // Delete the PR branch from remote
    try {
      await execGitWithTimeout("push", `push origin --delete ${prBranch}`, {
        workdir,
        timeout: 30000,
      });
    } catch (deleteErr) {
      log.warn(`Failed to delete remote PR branch ${prBranch}`, {
        error: getErrorMessage(deleteErr),
      });
    }

    // Delete the local PR branch
    try {
      await execGitWithTimeout("branch", `branch -D ${prBranch}`, { workdir, timeout: 30000 });
    } catch (deleteErr) {
      log.warn(`Failed to delete local PR branch ${prBranch}`, {
        error: getErrorMessage(deleteErr),
      });
    }

    return {
      commitHash,
      mergeDate,
      mergedBy,
      metadata: {
        prBranch,
        baseBranch,
        workdir,
        workflow: "prepared-merge-commit",
      },
    };
  } catch (error) {
    throw new MinskyError(
      `Failed to merge prepared merge commit PR: ${getErrorMessage(error as any)}`
    );
  }
}

/**
 * Convert a PR title to a branch name
 * e.g. "feat: add new feature" -> "feat-add-new-feature"
 */
function titleToBranchName(title: string): string {
  return title
    .toLowerCase()
    .replace(/[\s:/#]+/g, "-") // Replace spaces, colons, slashes, and hashes with dashes
    .replace(/[^\w-]/g, "")
    .replace(/--+/g, "-")
    .replace(/^-|-$/g, ""); // Remove leading and trailing dashes
}
