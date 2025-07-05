import { join } from "node:path";
import { normalizeRepoName } from "../../repo-utils";
import { createSessionProvider } from "../../session";
import { log } from "../../../utils/logger";
import { createGitService } from "../../git";
import { promisify } from "node:util";
import { exec } from "node:child_process";

const execAsync = promisify(exec);

/**
 * Rebase branches from parameters
 */
export async function rebaseFromParams(params: {
  baseBranch: string;
  featureBranch?: string;
  session?: string;
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
      log("Could not predict conflicts", { error });
    }
  }
  
  // Perform the rebase
  try {
    const { stdout, stderr } = await execAsync(`git rebase ${params.baseBranch}`, {
      cwd: repoPath,
      timeout: 60000,
    });
    
    log("Rebase completed successfully", { 
      baseBranch: params.baseBranch,
      featureBranch,
      repoPath,
      stdout,
      stderr 
    });
    
    return {
      workdir: repoPath,
      rebased: true,
      conflicts: false,
      prediction,
    };
  } catch (error: any) {
    // Handle rebase conflicts
    const errorMessage = error.message || "";
    const isConflict = errorMessage.includes("conflict") || 
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
