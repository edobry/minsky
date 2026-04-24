/**
 * Merge Simulation
 *
 * Provides merge simulation functionality extracted from ConflictDetectionService
 * for better maintainability and focused responsibility.
 */
import { execAsync } from "../../utils/exec";
import { log } from "../../utils/logger";
import type { ConflictFile } from "./conflict-detection-types";
import { analyzeConflictFiles } from "./conflict-analysis-operations";

export async function simulateMergeImpl(
  repoPath: string,
  sourceBranch: string,
  targetBranch: string
): Promise<ConflictFile[]> {
  log.debug("Simulating merge", { repoPath, sourceBranch, targetBranch });

  try {
    // Capture the caller's current HEAD so we can restore it in finally.
    // `rev-parse --abbrev-ref HEAD` returns the branch name when on a branch,
    // or the literal string "HEAD" when in detached-HEAD state.
    let originalCheckout: string;
    const abbrevRef = (
      await execAsync(`git -C ${repoPath} rev-parse --abbrev-ref HEAD`)
    ).stdout.trim();
    if (abbrevRef === "HEAD") {
      // Detached HEAD — capture the SHA so we can restore the exact commit.
      originalCheckout = (await execAsync(`git -C ${repoPath} rev-parse HEAD`)).stdout.trim();
    } else {
      originalCheckout = abbrevRef;
    }

    // Create a temporary branch for simulation
    const tempBranch = `conflict-simulation-${Date.now()}`;

    try {
      // Create temp branch from target
      await execAsync(`git -C ${repoPath} checkout -b ${tempBranch} ${targetBranch}`);

      // Attempt merge
      try {
        await execAsync(`git -C ${repoPath} merge --no-commit --no-ff ${sourceBranch}`);

        // If merge succeeds, reset and return no conflicts
        await execAsync(`git -C ${repoPath} reset --hard HEAD`);
        return [];
      } catch (mergeError) {
        // Merge failed, analyze conflicts
        const conflictFiles = await analyzeConflictFiles(repoPath);

        // Only abort merge if there's actually a merge in progress
        // --no-commit flag means merge might not have started a transaction
        try {
          // Check if there's a merge to abort by looking for MERGE_HEAD
          await execAsync(`test -f ${repoPath}/.git/MERGE_HEAD`);
          // If MERGE_HEAD exists, we can safely abort
          await execAsync(`git -C ${repoPath} merge --abort`);
        } catch (mergeHeadError) {
          // No MERGE_HEAD means no merge transaction to abort, just reset
          await execAsync(`git -C ${repoPath} reset --hard HEAD`);
        }

        return conflictFiles;
      }
    } finally {
      // Clean up temporary branch and restore the caller's original HEAD.
      try {
        await execAsync(`git -C ${repoPath} checkout ${originalCheckout}`);
        await execAsync(`git -C ${repoPath} branch -D ${tempBranch}`);
      } catch (cleanupError) {
        log.warn("Failed to clean up temporary branch", {
          tempBranch,
          cleanupError,
        });
      }
    }
  } catch (error) {
    log.error("Error simulating merge", {
      error,
      repoPath,
      sourceBranch,
      targetBranch,
    });
    throw error;
  }
}
