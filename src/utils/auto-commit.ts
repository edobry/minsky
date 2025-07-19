/**
 * Auto-commit utility for task operations
 * Follows the proven session approve pattern for automatic git operations
 */
import { execGitWithTimeout } from "./git-exec";
import { log } from "./logger";
import { getErrorMessage } from "../errors/index";

/**
 * Auto-commit task changes following session approve pattern
 * 
 * @param workspacePath - The workspace path where changes should be committed
 * @param message - Commit message (should follow conventional commits format)
 * @returns Promise<boolean> - true if changes were committed, false if no changes
 */
export async function autoCommitTaskChanges(
  workspacePath: string, 
  message: string
): Promise<boolean> {
  try {
    // Step 1: Check for changes using git status --porcelain (session approve pattern)
    const statusResult = await execGitWithTimeout("check-status", "status --porcelain", { workdir: workspacePath });
    
    if (statusResult.stdout.trim() === "") {
      // No changes to commit
      log.debug("Auto-commit: No changes detected in workspace", { workspacePath });
      return false;
    }

    // Step 2: Stage task-related files (following session approve pattern)
    // Focus on process/tasks.md and process/tasks/ directory
    const filesToStage = [
      "process/tasks.md",
      "process/tasks/"
    ];

    for (const file of filesToStage) {
      try {
        await execGitWithTimeout("stage-files", `add "${file}"`, { workdir: workspacePath });
      } catch (error) {
        // File might not exist yet, continue
        log.debug(`Auto-commit: Could not stage ${file}`, { error: getErrorMessage(error) });
      }
    }

    // Step 3: Check if anything was actually staged
    const stagedResult = await execGitWithTimeout("check-staged", "diff --cached --name-only", { workdir: workspacePath });
    
    if (stagedResult.stdout.trim() === "") {
      // No task-related changes staged
      log.debug("Auto-commit: No task-related changes to commit", { workspacePath });
      return false;
    }

    // Step 4: Commit with provided message
    await execGitWithTimeout("commit", `commit -m "${message.replace(/"/g, "\\\"")}"`, { workdir: workspacePath });
    log.info("Auto-commit: Successfully committed task changes", { 
      workspacePath, 
      message,
      stagedFiles: stagedResult.stdout.trim().split("\n")
    });

    // Step 5: Push changes (with error handling that doesn't fail main operation)
    try {
      await execGitWithTimeout("push", "push", { workdir: workspacePath });
      log.info("Auto-commit: Successfully pushed changes", { workspacePath });
    } catch (pushError) {
      // Log push failure but don't fail the main operation (session approve pattern)
      log.warn("Auto-commit: Failed to push changes, but commit succeeded", { 
        workspacePath, 
        error: getErrorMessage(pushError) 
      });
      // Still return true because commit succeeded
    }

    return true;
  } catch (error) {
    // Log error but don't throw - auto-commit should not break task operations
    log.error("Auto-commit: Failed to commit task changes", { 
      workspacePath, 
      message, 
      error: getErrorMessage(error) 
    });
    return false;
  }
} 
