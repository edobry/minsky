/**
 * Git operations helpers for the Markdown Task Backend.
 * Encapsulates the stash/commit/push workflow used by task mutations.
 */

import { log } from "../../utils/logger";
import type { GitServiceInterface } from "../git";

/**
 * Execute a task mutation inside a git stash/commit/push workflow.
 *
 * 1. Stash any uncommitted changes
 * 2. Run the provided `action` callback (which must modify files on disk)
 * 3. Stage, commit, and push the changes
 * 4. Restore the stash regardless of outcome
 *
 * @returns The value returned by `action`.
 */
export async function withGitStashCommitPush<T>(opts: {
  gitService: GitServiceInterface;
  workdir: string;
  commitMessage: string;
  action: () => Promise<T>;
}): Promise<T> {
  const { gitService, workdir, commitMessage, action } = opts;
  let hasStashedChanges = false;

  // ---- Stash ----
  try {
    const hasUncommittedChanges = await gitService.hasUncommittedChanges(workdir);
    if (hasUncommittedChanges) {
      log.cli("📦 Stashing uncommitted changes...");
      log.debug("Stashing uncommitted changes", { workdir });
      const stashResult = await gitService.stashChanges(workdir);
      hasStashedChanges = stashResult.stashed;
      if (hasStashedChanges) {
        log.cli("✅ Changes stashed successfully");
      }
      log.debug("Changes stashed", { stashed: hasStashedChanges });
    }
  } catch (statusError) {
    log.debug("Could not check/stash git status", { error: statusError });
  }

  try {
    // ---- Action ----
    const result = await action();

    // ---- Commit & Push ----
    await commitAndPush(gitService, workdir, commitMessage);

    return result;
  } finally {
    // ---- Restore stash ----
    if (hasStashedChanges) {
      await restoreStash(gitService, workdir);
    }
  }
}

/**
 * Stage all changes, commit with the given message, and push.
 * Failures are logged as warnings but do not throw.
 */
export async function commitAndPush(
  gitService: GitServiceInterface,
  workdir: string,
  commitMessage: string
): Promise<void> {
  try {
    const hasChangesToCommit = await gitService.hasUncommittedChanges(workdir);
    if (hasChangesToCommit) {
      log.cli("💾 Committing changes...");
      await gitService.execInRepository(workdir, "git add -A");
      await gitService.execInRepository(workdir, `git commit -m "${commitMessage}"`);
      log.cli("📤 Pushing changes...");
      await gitService.execInRepository(workdir, "git push");
      log.cli("✅ Changes committed and pushed successfully");
    }
  } catch (commitError) {
    log.warn("Failed to commit/push changes", { error: commitError });
    log.cli(`⚠️ Warning: Failed to commit changes: ${commitError}`);
  }
}

/**
 * Pop the git stash, logging warnings on failure.
 */
async function restoreStash(gitService: GitServiceInterface, workdir: string): Promise<void> {
  try {
    log.cli("📂 Restoring stashed changes...");
    log.debug("Restoring stashed changes");
    await gitService.popStash(workdir);
    log.cli("✅ Stashed changes restored successfully");
    log.debug("Stashed changes restored");
  } catch (popError) {
    log.warn("Failed to restore stashed changes", { error: popError });
    log.cli(`⚠️ Warning: Failed to restore stashed changes: ${popError}`);
  }
}
