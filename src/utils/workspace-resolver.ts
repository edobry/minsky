/**
 * Workspace resolution using TaskService with hanging prevention
 * Eliminates TaskBackendRouter complexity and provides workspace resolution with timeouts
 */
import { TaskService } from "../domain/tasks/taskService";
import { resolveRepoPath } from "../domain/repo-utils";
import { log } from "./logger";
import { performance } from "perf_hooks";

/**
 * Options for workspace resolution
 */
export interface WorkspaceResolverOptions {
  /** Backend name to use */
  backend?: string;
  /** Repository URL override */
  repoUrl?: string;
  /** Maximum time to spend on workspace resolution (ms) */
  maxResolutionTime?: number;
  /** Skip special workspace entirely for maximum speed */
  emergencyMode?: boolean;
  /** Disable special workspace (use current directory) */
  disableSpecialWorkspace?: boolean;
}

/**
 * Workspace resolution with hanging prevention
 * 
 * Uses aggressive timeouts to prevent the 10+ second hangs that were occurring 
 * in task operations due to special workspace initialization delays.
 */
export async function resolveTaskWorkspacePath(options: WorkspaceResolverOptions = {}): Promise<string> {
  const { 
    backend = "markdown", 
    repoUrl,
    maxResolutionTime = 2000, // 2 second default timeout
    emergencyMode = false,
    disableSpecialWorkspace = false
  } = options;

  const startTime = performance.now();

  // Emergency mode: return current directory immediately
  if (emergencyMode) {
    log.debug("Using emergency workspace resolution");
    return process.cwd();
  }

  // For non-markdown backends, use current directory immediately
  if (backend !== "markdown") {
    return process.cwd();
  }

  // If special workspace is disabled, use current directory
  if (disableSpecialWorkspace) {
    log.debug("Special workspace disabled, using current directory");
    return process.cwd();
  }

  // For markdown backend, try special workspace with aggressive timeouts
  if (repoUrl) {
    try {
      // Create aggressive timeout for special workspace operations
      const timeout = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("Workspace resolution timeout")), maxResolutionTime);
      });

      const taskServicePromise = TaskService.createMarkdownWithRepo({ repoUrl });
      const taskService = await Promise.race([taskServicePromise, timeout]);

      const workspacePath = taskService.getWorkspacePath();
      
      log.debug("Workspace resolution completed", {
        method: "repo-based",
        duration: `${(performance.now() - startTime).toFixed(2)}ms`,
        workspacePath
      });
      
      return workspacePath;
    } catch (error) {
      log.warn("Repo-based workspace resolution failed, using fallback", {
        error: error instanceof Error ? error.message : String(error),
        repoUrl,
        timeElapsed: `${(performance.now() - startTime).toFixed(2)}ms`
      });
    }
  }

  // Fallback: Try auto-detection with remaining time budget
  const remainingTime = maxResolutionTime - (performance.now() - startTime);
  if (remainingTime > 200) { // Only try if we have at least 200ms left
    try {
      const timeout = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("Auto-detection timeout")), Math.min(remainingTime, 1000));
      });

      const taskServicePromise = TaskService.createMarkdownWithAutoDetection();
      const taskService = await Promise.race([taskServicePromise, timeout]);

      const workspacePath = taskService.getWorkspacePath();
      
      log.debug("Workspace resolution completed", {
        method: "auto-detection",
        duration: `${(performance.now() - startTime).toFixed(2)}ms`,
        workspacePath
      });
      
      return workspacePath;
    } catch (error) {
      log.warn("Auto-detection workspace resolution failed, using current directory", {
        error: error instanceof Error ? error.message : String(error),
        timeElapsed: `${(performance.now() - startTime).toFixed(2)}ms`
      });
    }
  }

  // Ultimate fallback: current directory
  const result = process.cwd();
  
  log.debug("Workspace resolution completed", {
    method: "current-directory-fallback",
    duration: `${(performance.now() - startTime).toFixed(2)}ms`,
    workspacePath: result
  });

  // Warn if resolution took longer than expected
  const totalTime = performance.now() - startTime;
  if (totalTime > 1000) {
    log.warn("Slow workspace resolution detected", {
      duration: `${totalTime.toFixed(2)}ms`,
      suggestion: "Consider using emergencyMode: true for faster operations"
    });
  }

  return result;
}
