import { log } from "../../../utils/logger";
import { createGitService } from "../../git";

/**
 * Commits changes from parameters.
 * Session must be resolved to a repo path before calling this function.
 */
export async function commitChangesFromParams(params: {
  message: string;
  repo?: string;
  all?: boolean;
  amend?: boolean;
  noStage?: boolean;
}): Promise<{ commitHash: string; message: string }> {
  const gitService = createGitService();

  // Default to current directory if no repo specified
  const repoPath = params.repo ?? process.cwd();

  // Stage changes if requested
  if (params.all && !params.noStage) {
    if (!gitService.stageAll) throw new Error("Git service does not support stageAll operation");
    await gitService.stageAll(repoPath);
  } else if (!params.noStage) {
    if (!gitService.stageModified)
      throw new Error("Git service does not support stageModified operation");
    await gitService.stageModified(repoPath);
  }

  // Commit changes
  if (!gitService.commit) throw new Error("Git service does not support commit operation");
  const commitHash = await gitService.commit(params.message, repoPath, params.amend);

  log.debug("Changes committed successfully", {
    commitHash,
    message: params.message,
    repoPath,
    all: params.all,
    amend: params.amend,
  });

  return {
    commitHash,
    message: params.message,
  };
}
