import { log } from "../../../utils/logger";
import { createGitService } from "../../git";
import { EnhancedMergeResult } from "../types";

/**
 * Merge branches from parameters.
 * Session must be resolved to a repo path before calling this function.
 */
export async function mergeFromParams(params: {
  sourceBranch: string;
  targetBranch?: string;
  repo?: string;
  preview?: boolean;
  autoResolve?: boolean;
  conflictStrategy?: string;
}): Promise<EnhancedMergeResult> {
  const gitService = createGitService();

  // Default to current directory if no repo specified
  const repoPath = params.repo ?? process.cwd();

  // Default target branch to current branch if not specified
  let targetBranch = params.targetBranch;
  if (!targetBranch) {
    targetBranch = await gitService.getCurrentBranch(repoPath);
  }

  // Perform the merge with conflict prevention
  const result = await gitService.mergeWithConflictPrevention(
    repoPath,
    params.sourceBranch,
    targetBranch,
    {
      skipConflictCheck: params.preview ? true : false,
      autoResolveDeleteConflicts: params.autoResolve || false,
      dryRun: params.preview || false,
    }
  );

  log.info("Merge operation completed", {
    sourceBranch: params.sourceBranch,
    targetBranch,
    repoPath,
    result,
  });

  return result;
}
