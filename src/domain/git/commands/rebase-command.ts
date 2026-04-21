import { log } from "../../../utils/logger";
import { createGitService } from "../../git";
import { execGitWithTimeout } from "../../../utils/git-exec";

/**
 * Rebase branches from parameters.
 * Session must be resolved to a repo path before calling this function.
 */
export async function rebaseFromParams(params: {
  baseBranch: string;
  featureBranch?: string;
  repo?: string;
  preview?: boolean;
  autoResolve?: boolean;
  conflictStrategy?: string;
}): Promise<{
  workdir: string;
  rebased: boolean;
  conflicts: boolean;
  conflictDetails?: string;
  prediction?: {
    canAutoResolve: boolean;
    recommendations: string[];
    overallComplexity: string;
  };
}> {
  const gitService = createGitService();

  // Default to current directory if no repo specified
  const repoPath = params.repo ?? process.cwd();

  // Get current branch if feature branch not specified
  let featureBranch = params.featureBranch;
  if (!featureBranch) {
    featureBranch = await gitService.getCurrentBranch(repoPath);
  }

  // Check if there are uncommitted changes
  const hasUncommittedChanges = await gitService.hasUncommittedChanges(repoPath);

  if (hasUncommittedChanges && !params.preview) {
    // Stash changes first
    await gitService.stashChanges(repoPath);
  }

  // Predict conflicts if requested
  let prediction;
  if (params.preview) {
    try {
      const conflictPrediction = await gitService.predictMergeConflicts(
        repoPath,
        featureBranch,
        params.baseBranch
      );

      prediction = {
        canAutoResolve: conflictPrediction.canAutoResolve,
        recommendations: conflictPrediction.recommendations,
        overallComplexity: conflictPrediction.overallComplexity,
      };
    } catch (error) {
      log.debug("Could not predict conflicts", { error });
    }
  }

  // Perform the rebase
  try {
    const { stdout, stderr } = await execGitWithTimeout(
      "rebase-command",
      `rebase ${params.baseBranch}`,
      {
        workdir: repoPath,
        timeout: 60000,
      }
    );

    log.debug("Rebase completed successfully", {
      baseBranch: params.baseBranch,
      featureBranch,
      repoPath,
      stdout,
      stderr,
    });

    return {
      workdir: repoPath,
      rebased: true,
      conflicts: false,
      prediction,
    };
  } catch (error: unknown) {
    // Handle rebase conflicts
    const errorMessage = (error instanceof Error ? error.message : String(error)) || "";
    const isConflict =
      errorMessage.includes("conflict") ||
      errorMessage.includes("CONFLICT") ||
      errorMessage.includes("could not apply");

    if (isConflict) {
      return {
        workdir: repoPath,
        rebased: false,
        conflicts: true,
        conflictDetails: errorMessage,
        prediction,
      };
    }

    throw error;
  }
}
