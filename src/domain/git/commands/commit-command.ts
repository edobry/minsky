import { join } from "node:path";
import { normalizeRepoName } from "../repo-utils";
import { createSessionProvider } from "../../session";
import { log } from "../../../utils/logger";
import { createGitService } from "../../git";

/**
 * Commits changes from parameters
 */
export async function commitChangesFromParams(params: {
  message: string;
  session?: string;
  repo?: string;
  all?: boolean;
  amend?: boolean;
  noStage?: boolean;
}): Promise<{ commitHash: string; message: string }> {
  const gitService = createGitService();
  
  let repoPath = params.repo;
  
  if (params.session && !repoPath) {
    const sessionProvider = createSessionProvider();
    const session = await sessionProvider.getSession(params.session);
    
    if (!session) {
      throw new Error(`Session not found: ${params.session}`);
    }
    
    repoPath = session.workdir;
  }
  
  // Default to current directory if no repo specified
  if (!repoPath) {
    repoPath = process.cwd();
  }
  
  // Stage changes if requested
  if (params.all && !params.noStage) {
    await gitService.stageAll(repoPath);
  } else if (!params.noStage) {
    await gitService.stageModified(repoPath);
  }
  
  // Commit changes
  const commitHash = await gitService.commit(params.message, repoPath, params.amend);
  
  log("Changes committed successfully", { 
    commitHash,
    message: params.message,
    repoPath,
    all: params.all,
    amend: params.amend 
  });
  
  return {
    commitHash,
    message: params.message,
  };
} 
