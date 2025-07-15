/**
 * Rebase Conflict Prediction
 *
 * Provides rebase conflict prediction functionality extracted from ConflictDetectionService
 * for better maintainability and focused responsibility.
 */
import { execAsync } from "../../utils/exec";
import { log } from "../../utils/logger";
import type {
  RebaseConflictPrediction,
  ConflictingCommit,
  ConflictFile,
} from "./conflict-detection";

export interface RebasePredictionDependencies {
  execAsync: typeof execAsync;
  analyzeConflictFiles: (repoPath: string) => Promise<ConflictFile[]>;
  determineCommitComplexity: (conflictFiles: ConflictFile[]) => "simple" | "moderate" | "complex";
  determineOverallComplexity: (conflictingCommits: ConflictingCommit[]) => "simple" | "moderate" | "complex";
  estimateResolutionTime: (conflictingCommits: ConflictingCommit[]) => string;
  generateRebaseRecommendations: (
    conflictingCommits: ConflictingCommit[],
    overallComplexity: "simple" | "moderate" | "complex",
    canAutoResolve: boolean
  ) => string[];
}

export async function predictRebaseConflictsImpl(
  repoPath: string,
  baseBranch: string,
  featureBranch: string,
  deps: RebasePredictionDependencies
): Promise<RebaseConflictPrediction> {
  log.debug("Predicting rebase conflicts", {
    repoPath,
    baseBranch,
    featureBranch,
  });

  try {
    // Find the common ancestor commit
    const { stdout: mergeBase } = await deps.execAsync(
      `git -C ${repoPath} merge-base ${baseBranch} ${featureBranch}`
    );
    const commonAncestor = mergeBase.trim();

    // Get commits in feature branch that are not in base branch
    const { stdout: commitsOutput } = await deps.execAsync(
      `git -C ${repoPath} log --format="%H|%s|%an" ${commonAncestor}..${featureBranch}`
    );

    // Parse commit information
    const commitInfos = commitsOutput
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const parts = line.split("|");
        const sha = parts[0] || "";
        const message = parts[1] || "(no commit message)";
        const author = parts[2] || "(unknown)";
        return { sha, message, author };
      })
      .reverse(); // Order from oldest to newest for rebase simulation

    if (commitInfos.length === 0) {
      // No commits to rebase, so no conflicts
      return {
        baseBranch,
        featureBranch,
        conflictingCommits: [],
        overallComplexity: "simple",
        estimatedResolutionTime: "0 minutes",
        canAutoResolve: true,
        recommendations: ["No rebase needed, branches are already in sync."],
      };
    }

    // Create a temporary branch for simulation
    const tempBranch = `rebase-simulation-${Date.now()}`;
    const conflictingCommits: ConflictingCommit[] = [];

    try {
      // Create temp branch from base
      await deps.execAsync(
        `git -C ${repoPath} checkout -b ${tempBranch} ${baseBranch}`
      );

      // Simulate cherry-picking each commit to detect conflicts
      for (const commit of commitInfos) {
        try {
          await deps.execAsync(
            `git -C ${repoPath} cherry-pick --no-commit ${commit.sha}`
          );

          // No conflict for this commit, clean up and continue
          await deps.execAsync(`git -C ${repoPath} reset --hard HEAD`);
        } catch (cherryPickError) {
          // Cherry-pick failed, analyze conflicts
          const conflictFiles = await deps.analyzeConflictFiles(repoPath);

          // Determine complexity based on conflict files
          const complexity = deps.determineCommitComplexity(conflictFiles);

          conflictingCommits.push({
            sha: commit.sha,
            message: commit.message,
            author: commit.author,
            conflictFiles: conflictFiles.map((f) => f.path),
            complexity,
          });

          // Abort the cherry-pick
          await deps.execAsync(`git -C ${repoPath} cherry-pick --abort`);
        }
      }
    } finally {
      // Clean up temporary branch
      try {
        await deps.execAsync(`git -C ${repoPath} checkout ${featureBranch}`);
        await deps.execAsync(`git -C ${repoPath} branch -D ${tempBranch}`);
      } catch (cleanupError) {
        log.warn("Failed to clean up temporary branch", {
          tempBranch,
          cleanupError,
        });
      }
    }

    // Determine overall complexity and estimated resolution time
    const overallComplexity = deps.determineOverallComplexity(conflictingCommits);
    const estimatedResolutionTime = deps.estimateResolutionTime(conflictingCommits);
    const canAutoResolve = conflictingCommits.every(
      (commit) => commit.complexity === "simple"
    );

    // Generate recommendations
    const recommendations = deps.generateRebaseRecommendations(
      conflictingCommits,
      overallComplexity,
      canAutoResolve
    );

    return {
      baseBranch,
      featureBranch,
      conflictingCommits,
      overallComplexity,
      estimatedResolutionTime,
      canAutoResolve,
      recommendations,
    };
  } catch (error) {
    log.error("Error predicting rebase conflicts", {
      error,
      repoPath,
      baseBranch,
      featureBranch,
    });
    throw error;
  }
}
