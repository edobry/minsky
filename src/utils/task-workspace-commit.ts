/**
 * Task Workspace Auto-Commit Utility
 * 
 * Handles auto-commit functionality for task operations with proper support
 * for both regular workspace and special workspace scenarios.
 */
import { createSpecialWorkspaceManager } from "../domain/workspace/special-workspace-manager";
import { autoCommitTaskChanges } from "./auto-commit";
import { log } from "./logger";
import { getErrorMessage } from "../errors/index";

/**
 * Auto-commit task changes with smart workspace detection
 * 
 * This function determines whether to use regular auto-commit or special workspace
 * commit based on the workspace configuration and repository URL.
 * 
 * @param options Configuration for the commit operation
 * @returns Promise<boolean> - true if changes were committed, false if no changes
 */
export async function commitTaskChanges(options: {
  workspacePath: string;
  message: string;
  repoUrl?: string;
  backend?: string;
}): Promise<boolean> {
  const { workspacePath, message, repoUrl, backend = "markdown" } = options;

  // Only apply auto-commit for markdown backend
  if (backend !== "markdown") {
    log.debug("Task auto-commit: Skipping auto-commit for non-markdown backend", { backend });
    return false;
  }

  try {
    // If repoUrl is provided and we're using markdown backend, check if special workspace is being used
    if (repoUrl) {
      // Check if this workspace path is a special workspace by comparing with expected path
      const specialWorkspaceManager = createSpecialWorkspaceManager({
        repoUrl: repoUrl
      });
      
      const specialWorkspacePath = specialWorkspaceManager.getWorkspacePath();
      
      // If workspacePath matches the special workspace path, use special workspace commit
      if (workspacePath === specialWorkspacePath) {
        log.debug("Task auto-commit: Using special workspace commit", { 
          workspacePath, 
          specialWorkspacePath 
        });
        
        try {
          // Ensure the special workspace is up to date before committing
          await specialWorkspaceManager.ensureUpToDate();
          
          // Use special workspace manager's commit and push method
          await specialWorkspaceManager.commitAndPush(message);
          log.info("Task auto-commit: Successfully committed via special workspace", { 
            message, 
            workspacePath 
          });
          return true;
        } catch (error) {
          log.warn("Task auto-commit: Special workspace commit failed, trying fallback", {
            error: getErrorMessage(error),
            workspacePath,
            message
          });
          // Fall through to regular auto-commit as fallback
        }
      } else {
        log.debug("Task auto-commit: Workspace path doesn't match special workspace, using regular commit", {
          workspacePath,
          specialWorkspacePath
        });
      }
    }

    // Use regular auto-commit for non-special workspace scenarios
    log.debug("Task auto-commit: Using regular auto-commit", { workspacePath });
    return await autoCommitTaskChanges(workspacePath, message);

  } catch (error) {
    // Log error but don't throw - auto-commit should not break task operations
    log.error("Task auto-commit: Failed to commit task changes", { 
      workspacePath, 
      message, 
      repoUrl,
      error: getErrorMessage(error) 
    });
    return false;
  }
}
