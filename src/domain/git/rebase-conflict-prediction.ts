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
} from "./conflict-detection-types";

import { FileConflictStatus } from "./conflict-detection-types";

import { analyzeConflictFiles } from "./conflict-analysis-operations";

/**
 * Determines the complexity of conflicts for a single commit
 */
export function determineCommitComplexity(
  conflictFiles: ConflictFile[]
): "simple" | "moderate" | "complex" {
  if (conflictFiles.length === 0) {
    return "simple";
  }

  const hasComplexConflicts = conflictFiles.some(
    (file) =>
      file.status === FileConflictStatus.RENAMED ||
      (file.conflictRegions && file.conflictRegions.length > 5)
  );

  if (hasComplexConflicts) {
    return "complex";
  }

  if (
    conflictFiles.length > 3 ||
    conflictFiles.some(
      (file) =>
        file.status === FileConflictStatus.DELETED_BY_US ||
        file.status === FileConflictStatus.DELETED_BY_THEM
    )
  ) {
    return "moderate";
  }

  return "simple";
}

/**
 * Determines the overall complexity across all conflicting commits
 */
export function determineOverallComplexity(
  conflictingCommits: ConflictingCommit[]
): "simple" | "moderate" | "complex" {
  if (conflictingCommits.length === 0) {
    return "simple";
  }

  if (conflictingCommits.some((commit) => commit.complexity === "complex")) {
    return "complex";
  }

  if (
    conflictingCommits.some((commit) => commit.complexity === "moderate") ||
    conflictingCommits.length > 3
  ) {
    return "moderate";
  }

  return "simple";
}

/**
 * Estimates the time required to resolve conflicts across commits
 */
export function estimateResolutionTime(conflictingCommits: ConflictingCommit[]): string {
  if (conflictingCommits.length === 0) {
    return "0 minutes";
  }

  const timeEstimates = {
    simple: 5,
    moderate: 15,
    complex: 30,
  };

  const totalMinutes = conflictingCommits.reduce(
    (total, commit) => total + timeEstimates[commit.complexity],
    0
  );

  if (totalMinutes < 60) {
    return `${totalMinutes} minutes`;
  }

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours} hour${hours > 1 ? "s" : ""}${minutes > 0 ? ` ${minutes} minutes` : ""}`;
}

/**
 * Generates recommendations for rebase operations
 */
export function generateRebaseRecommendations(
  conflictingCommits: ConflictingCommit[],
  overallComplexity: "simple" | "moderate" | "complex",
  canAutoResolve: boolean
): string[] {
  if (conflictingCommits.length === 0) {
    return ["Rebase should complete without conflicts."];
  }

  const recommendations: string[] = [
    `${conflictingCommits.length} commit(s) may cause conflicts during rebase.`,
  ];

  if (canAutoResolve) {
    recommendations.push("All conflicts appear simple and might be auto-resolvable.");
  } else if (overallComplexity === "complex") {
    recommendations.push(
      "Consider using interactive rebase (`git rebase -i`) to handle complex conflicts one by one.",
      "You may want to squash related commits before rebasing to reduce conflict points."
    );
  } else {
    recommendations.push(
      "Use `git rebase --continue` after resolving each conflict.",
      "Consider stashing any uncommitted changes before rebasing."
    );
  }

  const complexCommits = conflictingCommits.filter((c) => c.complexity === "complex");
  if (complexCommits.length > 0) {
    const commitShas = complexCommits.map((c) => c.sha.substring(0, 8)).join(", ");
    recommendations.push(`Pay special attention to complex commits: ${commitShas}`);
  }

  return recommendations;
}

export async function predictRebaseConflictsImpl(
  repoPath: string,
  baseBranch: string,
  featureBranch: string
): Promise<RebaseConflictPrediction> {
  log.debug("Predicting rebase conflicts", {
    repoPath,
    baseBranch,
    featureBranch,
  });

  try {
    // Find the common ancestor commit
    const { stdout: mergeBase } = await execAsync(
      `git -C ${repoPath} merge-base ${baseBranch} ${featureBranch}`
    );
    const commonAncestor = mergeBase.toString().trim();

    // Get commits in feature branch that are not in base branch
    const { stdout: commitsOutput } = await execAsync(
      `git -C ${repoPath} log --format="%H|%s|%an" ${commonAncestor}..${featureBranch}`
    );

    // Parse commit information
    const commitInfos = commitsOutput
      .toString()
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
      await execAsync(`git -C ${repoPath} checkout -b ${tempBranch} ${baseBranch}`);

      // Simulate cherry-picking each commit to detect conflicts
      for (const commit of commitInfos) {
        try {
          await execAsync(`git -C ${repoPath} cherry-pick --no-commit ${commit.sha}`);

          // No conflict for this commit, clean up and continue
          await execAsync(`git -C ${repoPath} reset --hard HEAD`);
        } catch (cherryPickError) {
          // Cherry-pick failed, analyze conflicts
          const conflictFiles = await analyzeConflictFiles(repoPath);

          // Determine complexity based on conflict files
          const complexity = determineCommitComplexity(conflictFiles);

          conflictingCommits.push({
            sha: commit.sha,
            message: commit.message,
            author: commit.author,
            conflictFiles: conflictFiles.map((f) => f.path),
            complexity,
          });

          // Abort the cherry-pick
          await execAsync(`git -C ${repoPath} cherry-pick --abort`);
        }
      }
    } finally {
      // Clean up temporary branch
      try {
        await execAsync(`git -C ${repoPath} checkout ${featureBranch}`);
        await execAsync(`git -C ${repoPath} branch -D ${tempBranch}`);
      } catch (cleanupError) {
        log.warn("Failed to clean up temporary branch", {
          tempBranch,
          cleanupError,
        });
      }
    }

    // Determine overall complexity and estimated resolution time
    const overallComplexity = determineOverallComplexity(conflictingCommits);
    const estimatedResolutionTime = estimateResolutionTime(conflictingCommits);
    const canAutoResolve = conflictingCommits.every((commit) => commit.complexity === "simple");

    // Generate recommendations
    const recommendations = generateRebaseRecommendations(
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
