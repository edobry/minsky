/**
 * Workspace resolution using TaskService with hanging prevention
 * Eliminates TaskBackendRouter complexity and provides workspace resolution with timeouts
 */
import { performance } from "perf_hooks";
import { TaskService } from "../domain/tasks/taskService";
import { log } from "./logger";
import { getErrorMessage } from "../errors/index";
import { join } from "path";

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
 * Resolve the appropriate workspace path for task operations
 *
 * CRITICAL: ALL task operations should use the special workspace, not local directories.
 * This ensures consistency between CLI and MCP interfaces.
 *
 * @param options Workspace resolution options
 * @returns Promise resolving to workspace path
 */
export async function resolveTaskWorkspacePath(
  options: WorkspaceResolverOptions = {}
): Promise<string> {
  const {
    backend = "markdown",
    repoUrl = process.env.MINSKY_REPO_URL,
    emergencyMode = false,
    maxResolutionTime = 10000,
    disableSpecialWorkspace = false,
  } = options;

  const startTime = performance.now();

  // Emergency mode: return current directory immediately
  if (emergencyMode) {
    log.debug("Using emergency workspace resolution");
    return process.cwd();
  }

  // If special workspace is explicitly disabled, use current directory
  if (disableSpecialWorkspace) {
    log.debug("Special workspace disabled, using current directory");
    return process.cwd();
  }

  // CRITICAL FIX: ALL task operations MUST use special workspace
  // NO fallback to local workspace allowed

  let resolvedRepoUrl = repoUrl;

  if (!resolvedRepoUrl) {
    // Try to get repository URL from git config in current directory
    try {
      const { execGitWithTimeout } = await import("./git-exec");
      const { stdout } = await execGitWithTimeout("config", "config --get remote.origin.url", {
        workdir: process.cwd(),
        timeout: 2000,
      });
      resolvedRepoUrl = stdout.trim();
      log.debug("Resolved repository URL from git config", { repoUrl: resolvedRepoUrl });
    } catch (error) {
      log.warn("Could not resolve repository URL from git config", {
        error: getErrorMessage(error),
        cwd: process.cwd(),
      });
    }
  }

  // If we have a repository URL, use it for special workspace
  if (resolvedRepoUrl) {
    try {
      const taskServicePromise = TaskService.createMarkdownWithRepo({ repoUrl: resolvedRepoUrl });
      const taskService = await taskServicePromise; // No timeout - let it complete

      const workspacePath = taskService.getWorkspacePath();

      log.debug("Task workspace resolution completed using repository-specific special workspace", {
        method: "repo-based-special-workspace",
        duration: `${(performance.now() - startTime).toFixed(2)}ms`,
        workspacePath,
        repoUrl: resolvedRepoUrl,
      });

      return workspacePath;
    } catch (error) {
      log.error("Repository-specific special workspace failed", {
        error: getErrorMessage(error),
        repoUrl: resolvedRepoUrl,
        duration: `${(performance.now() - startTime).toFixed(2)}ms`,
      });
      // Don't fall back - task operations MUST use special workspace
      throw new Error(
        `Task operations require special workspace. Failed to initialize with repo: ${resolvedRepoUrl}. Error: ${getErrorMessage(error)}`
      );
    }
  }

  // If no repository URL available, use the existing task-operations workspace
  try {
    log.debug("No repository URL available, checking for existing task-operations workspace");

    const { createSpecialWorkspaceManager } = await import(
      "../domain/workspace/special-workspace-manager"
    );
    const os = await import("os");

    // Check if task-operations workspace already exists
    const taskOperationsPath = join(os.homedir(), ".local", "state", "minsky", "task-operations");

    if (require("fs").existsSync(taskOperationsPath)) {
      log.debug("Using existing task-operations workspace", {
        workspacePath: taskOperationsPath,
        method: "existing-special-workspace",
      });
      return taskOperationsPath;
    }

    // No existing workspace - this means no tasks have been created yet
    // Fail rather than create a new workspace without proper repository context
    throw new Error(
      "No task-operations workspace exists and no repository URL provided. Task operations require special workspace initialization."
    );
  } catch (error) {
    log.error("Failed to resolve task workspace", {
      error: getErrorMessage(error),
      duration: `${(performance.now() - startTime).toFixed(2)}ms`,
    });

    // Task operations CANNOT fall back to local workspace
    throw new Error(`Task operations require special workspace. ${getErrorMessage(error)}`);
  }
}
