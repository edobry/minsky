import { log } from "../../../utils/logger";
import { createGitService } from "../../git";
import { execGitWithTimeout } from "../../../utils/git-exec";

/**
 * Checkout a branch from parameters.
 * Session must be resolved to a repo path before calling this function.
 */
export async function checkoutFromParams(params: {
  branch: string;
  repo?: string;
  preview?: boolean;
  autoResolve?: boolean;
  conflictStrategy?: string;
}): Promise<{
  workdir: string;
  switched: boolean;
  conflicts: boolean;
  conflictDetails?: string;
  warning?: { wouldLoseChanges: boolean; recommendedAction: string };
}> {
  const gitService = createGitService();

  // Default to current directory if no repo specified
  const repoPath = params.repo ?? process.cwd();

  // Check if there are uncommitted changes
  const hasUncommittedChanges = await gitService.hasUncommittedChanges(repoPath);

  if (hasUncommittedChanges && !params.preview) {
    // Stash changes first
    await gitService.stashChanges(repoPath);
  }

  // Perform the checkout
  try {
    const { stdout, stderr } = await execGitWithTimeout(
      "checkout-command",
      `checkout ${params.branch}`,
      {
        workdir: repoPath,
        timeout: 30000,
      }
    );

    log.debug("Branch checkout completed", {
      branch: params.branch,
      repoPath,
      stdout,
      stderr,
    });

    return {
      workdir: repoPath,
      switched: true,
      conflicts: false,
      warning: hasUncommittedChanges
        ? {
            wouldLoseChanges: true,
            recommendedAction: "Changes were stashed automatically",
          }
        : undefined,
    };
  } catch (error: unknown) {
    // Handle checkout conflicts
    const errorMessage = (error instanceof Error ? error.message : String(error)) || "";
    const isConflict =
      errorMessage.includes("conflict") ||
      errorMessage.includes("would be overwritten") ||
      errorMessage.includes("uncommitted changes");

    if (isConflict) {
      return {
        workdir: repoPath,
        switched: false,
        conflicts: true,
        conflictDetails: errorMessage,
        warning: {
          wouldLoseChanges: true,
          recommendedAction: "Commit or stash your changes before switching branches",
        },
      };
    }

    throw error;
  }
}
