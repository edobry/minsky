import type { SessionProviderInterface } from "../../session/types";
import { log } from "../../../utils/logger";
import { createGitService } from "../../git";
import { EnhancedMergeResult } from "../types";

/**
 * Merge branches from parameters
 */
export async function mergeFromParams(
  params: {
    sourceBranch: string;
    targetBranch?: string;
    session?: string;
    repo?: string;
    preview?: boolean;
    autoResolve?: boolean;
    conflictStrategy?: string;
  },
  deps: { sessionProvider: SessionProviderInterface }
): Promise<EnhancedMergeResult> {
  const gitService = createGitService();

  let repoPath = params.repo;

  if (params.session && !repoPath) {
    const session = await deps.sessionProvider.getSession(params.session);

    if (!session) {
      throw new Error(`Session not found: ${params.session}`);
    }

    repoPath = await deps.sessionProvider.getSessionWorkdir(params.session);
  }

  // Default to current directory if no repo specified
  if (!repoPath) {
    repoPath = process.cwd();
  }

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
