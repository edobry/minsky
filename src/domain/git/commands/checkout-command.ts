import { join } from "node:path";
import { normalizeRepoName } from "../repo-utils";
import { createSessionProvider } from "../../session";
import { log } from "../../../utils/logger";
import { createGitService } from "../git";
import { promisify } from "node:util";
import { exec } from "node:child_process";

const execAsync = promisify(exec);

/**
 * Checkout a branch from parameters
 */
export async function checkoutFromParams(params: {
  branch: string;
  session?: string;
  repo?: string;
  preview?: boolean;
  autoResolve?: boolean;
  conflictStrategy?: string;
}): Promise<{ 
  workdir: string; 
  switched: boolean; 
  conflicts: boolean; 
  conflictDetails?: string; 
  warning?: { wouldLoseChanges: boolean; recommendedAction: string } 
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
  
  // Check if there are uncommitted changes
  const hasUncommittedChanges = await gitService.hasUncommittedChanges(repoPath);
  
  if (hasUncommittedChanges && !params.preview) {
    // Stash changes first
    await gitService.stashChanges(repoPath);
  }
  
  // Perform the checkout
  try {
    const { stdout, stderr } = await execAsync(`git checkout ${params.branch}`, {
      cwd: repoPath,
      timeout: 30000,
    });
    
    log("Branch checkout completed", { 
      branch: params.branch,
      repoPath,
      stdout,
      stderr 
    });
    
    return {
      workdir: repoPath,
      switched: true,
      conflicts: false,
      warning: hasUncommittedChanges ? {
        wouldLoseChanges: true,
        recommendedAction: "Changes were stashed automatically"
      } : undefined
    };
  } catch (error: any) {
    // Handle checkout conflicts
    const errorMessage = error.message || "";
    const isConflict = errorMessage.includes("conflict") || 
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
          recommendedAction: "Commit or stash your changes before switching branches"
        }
      };
    }
    
    throw error;
  }
} 
