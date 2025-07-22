/**
 * Task Workspace Commit Utility
 *
 * Handles auto-commit for task operations with proper workspace detection
 * and synchronization between special workspace and main workspace.
 */

import { autoCommitTaskChanges } from "./auto-commit";
import { createSpecialWorkspaceManager } from "../domain/workspace/special-workspace-manager";
import { log } from "./logger";

export interface TaskWorkspaceCommitOptions {
  workspacePath: string;
  message: string;
  repoUrl?: string;
  backend?: string;
}

/**
 * Commit task changes with intelligent workspace detection
 *
 * This function solves the synchronization issue between special workspace
 * and main workspace by:
 * 1. Detecting if we're in a special workspace context
 * 2. Using SpecialWorkspaceManager for special workspace scenarios
 * 3. Falling back to regular auto-commit for main workspace scenarios
 *
 * @param options Commit options including workspace path and repo URL
 * @returns Promise resolving to true if successful
 */
export async function commitTaskChanges(options: TaskWorkspaceCommitOptions): Promise<boolean> {
  const { workspacePath, message, repoUrl, backend } = options;

  // Only apply auto-commit for markdown backend operations
  if (backend && backend !== "markdown") {
    log.debug("Skipping auto-commit for non-markdown backend", { backend });
    return true;
  }

  // Smart detection of special workspace
  if (repoUrl) {
    try {
      const specialWorkspaceManager = createSpecialWorkspaceManager({ repoUrl });
      const specialWorkspacePath = specialWorkspaceManager.getWorkspacePath();

      if (workspacePath === specialWorkspacePath) {
        log.debug("Using special workspace atomic operations", {
          workspacePath,
          specialWorkspacePath,
        });

        // Use special workspace atomic operations
        await specialWorkspaceManager.ensureUpToDate();
        await specialWorkspaceManager.commitAndPush(message);
        return true;
      }
    } catch (error) {
      log.warn("Special workspace operations failed, falling back to regular auto-commit", {
        error: error instanceof Error ? error.message : String(error),
        workspacePath,
        repoUrl,
      });
      // Fall through to regular auto-commit
    }
  }

  // Fallback to regular auto-commit for main workspace
  log.debug("Using regular auto-commit", { workspacePath });
  return await autoCommitTaskChanges(workspacePath, message);
}

/**
 * Fix task spec path synchronization issues
 *
 * This function addresses the core issue where task spec commands
 * use stale or generated spec paths instead of the actual stored ones.
 *
 * @param task Task data object
 * @param workspacePath Workspace path for fallback generation
 * @returns Corrected spec path
 */
export function fixTaskSpecPath(task: any, workspacePath: string): string {
  // Always prefer the stored specPath from the database
  if (task.specPath && typeof task.specPath === "string" && task.specPath.trim()) {
    log.debug("Using stored spec path from database", {
      taskId: task.id,
      specPath: task.specPath,
    });
    return task.specPath;
  }

  // Fallback: generate spec path if none stored (legacy tasks)
  const { getTaskSpecRelativePath } = require("../domain/tasks/taskIO");
  const generatedPath = getTaskSpecRelativePath(task.id, task.title, workspacePath);

  log.warn("Generated spec path for task missing specPath", {
    taskId: task.id,
    title: task.title,
    generatedPath,
  });

  return generatedPath;
}
