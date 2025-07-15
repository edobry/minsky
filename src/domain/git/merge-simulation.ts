/**
 * Merge Simulation
 * 
 * Provides merge simulation functionality extracted from ConflictDetectionService
 * for better maintainability and focused responsibility.
 */
import { execAsync } from "../../utils/exec";
import { log } from "../../utils/logger";
import type { ConflictFile } from "./conflict-detection";

export interface MergeSimulationDependencies {
  execAsync: typeof execAsync;
  analyzeConflictFiles: (repoPath: string) => Promise<ConflictFile[]>;
}

export async function simulateMergeImpl(
  repoPath: string,
  sourceBranch: string,
  targetBranch: string,
  deps: MergeSimulationDependencies
): Promise<ConflictFile[]> {
  log.debug("Simulating merge", { repoPath, sourceBranch, targetBranch });

  try {
    // Create a temporary branch for simulation
    const tempBranch = `conflict-simulation-${Date.now()}`;

    try {
      // Create temp branch from target
      await deps.execAsync(
        `git -C ${repoPath} checkout -b ${tempBranch} ${targetBranch}`
      );

      // Attempt merge
      try {
        await deps.execAsync(
          `git -C ${repoPath} merge --no-commit --no-ff ${sourceBranch}`
        );

        // If merge succeeds, reset and return no conflicts
        await deps.execAsync(`git -C ${repoPath} reset --hard HEAD`);
        return [];
      } catch (mergeError) {
        // Merge failed, analyze conflicts
        const conflictFiles = await deps.analyzeConflictFiles(repoPath);

        // Abort the merge
        await deps.execAsync(`git -C ${repoPath} merge --abort`);

        return conflictFiles;
      }
    } finally {
      // Clean up temporary branch
      try {
        await deps.execAsync(`git -C ${repoPath} checkout ${targetBranch}`);
        await deps.execAsync(`git -C ${repoPath} branch -D ${tempBranch}`);
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
