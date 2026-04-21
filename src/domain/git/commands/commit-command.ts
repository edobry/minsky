import type { SessionProviderInterface } from "../../session/types";
import { log } from "../../../utils/logger";
import { createGitService } from "../../git";

/**
 * Commits changes from parameters
 */
export async function commitChangesFromParams(
  params: {
    message: string;
    session?: string;
    repo?: string;
    all?: boolean;
    amend?: boolean;
    noStage?: boolean;
  },
  deps: { sessionProvider: SessionProviderInterface }
): Promise<{ commitHash: string; message: string }> {
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
