/**
 * Merge Simulation
 *
 * Provides merge simulation functionality extracted from ConflictDetectionService
 * for better maintainability and focused responsibility.
 */
import { execAsync, safeShellQuote } from "@minsky/shared/exec";
import { access } from "fs/promises";
import { join } from "path";
import { log } from "@minsky/shared/logger";
import type { ConflictFile } from "./conflict-detection-types";
import { analyzeConflictFiles } from "./conflict-analysis-operations";

export async function simulateMergeImpl(
  repoPath: string,
  sourceBranch: string,
  targetBranch: string
): Promise<ConflictFile[]> {
  log.debug("Simulating merge", { repoPath, sourceBranch, targetBranch });

  // mt#1829: repoPath is operator-controlled (CLI input / session path),
  // sourceBranch and targetBranch are PR/operator-controlled. All git
  // -C interpolations below use safeShellQuote per the mt#1742 pattern.
  const qRepoPath = safeShellQuote(repoPath);
  const qSourceBranch = safeShellQuote(sourceBranch);
  const qTargetBranch = safeShellQuote(targetBranch);

  try {
    // Capture the caller's current HEAD so we can restore it in finally.
    // `rev-parse --abbrev-ref HEAD` returns the branch name when on a branch,
    // or the literal string "HEAD" when in detached-HEAD state.
    let originalCheckout: string;
    const abbrevRef = (
      await execAsync(`git -C ${qRepoPath} rev-parse --abbrev-ref HEAD`)
    ).stdout.trim();
    if (abbrevRef === "HEAD") {
      // Detached HEAD — capture the SHA so we can restore the exact commit.
      originalCheckout = (await execAsync(`git -C ${qRepoPath} rev-parse HEAD`)).stdout.trim();
    } else {
      originalCheckout = abbrevRef;
    }

    // Create a temporary branch for simulation. Internally generated
    // (timestamp-based) but quote consistently.
    const tempBranch = `conflict-simulation-${Date.now()}`;
    const qTempBranch = safeShellQuote(tempBranch);

    try {
      // Create temp branch from target
      await execAsync(`git -C ${qRepoPath} checkout -b ${qTempBranch} ${qTargetBranch}`);

      // Attempt merge
      try {
        await execAsync(`git -C ${qRepoPath} merge --no-commit --no-ff ${qSourceBranch}`);

        // If merge succeeds, reset and return no conflicts
        await execAsync(`git -C ${qRepoPath} reset --hard HEAD`);
        return [];
      } catch (mergeError) {
        // Merge failed, analyze conflicts
        const conflictFiles = await analyzeConflictFiles(repoPath);

        // Only abort merge if there's actually a merge in progress
        // --no-commit flag means merge might not have started a transaction.
        // mt#1829: use fs.access() programmatically instead of
        // `execAsync("test -f ${repoPath}/.git/MERGE_HEAD")` so shell
        // metacharacters in repoPath cannot escape the test command.
        let mergeHeadExists = true;
        try {
          await access(join(repoPath, ".git", "MERGE_HEAD"));
        } catch {
          mergeHeadExists = false;
        }
        if (mergeHeadExists) {
          // If MERGE_HEAD exists, we can safely abort
          await execAsync(`git -C ${qRepoPath} merge --abort`);
        } else {
          // No MERGE_HEAD means no merge transaction to abort, just reset
          await execAsync(`git -C ${qRepoPath} reset --hard HEAD`);
        }

        return conflictFiles;
      }
    } finally {
      // Clean up temporary branch and restore the caller's original HEAD.
      try {
        await execAsync(`git -C ${qRepoPath} checkout ${safeShellQuote(originalCheckout)}`);
        await execAsync(`git -C ${qRepoPath} branch -D ${qTempBranch}`);
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
