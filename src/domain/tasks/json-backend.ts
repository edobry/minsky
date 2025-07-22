/**
 * Enhanced JSON Task Backend
 *
 * This backend handles its own workspace resolution internally,
 * eliminating the need for external TaskBackendRouter complexity.
 */

import { join } from "path";
import { existsSync } from "fs";
import { JsonFileTaskBackend } from "./jsonFileTaskBackend";
import { createSpecialWorkspaceManager } from "../workspace/special-workspace-manager";
import type { TaskBackend } from "./taskBackend";
import type { JsonConfig, WorkspaceResolutionResult } from "./backend-config";
import type { JsonFileTaskBackendOptions } from "./jsonFileTaskBackend";
import { log } from "../../utils/logger";

/**
 * Resolve workspace path and database file path using configuration
 */
async function resolveWorkspacePath(config: WorkspaceResolvingJsonConfig): Promise<WorkspaceResolutionResult & { dbFilePath: string }> {
  // 1. Explicit workspace path override
  if (config.workspacePath) {
    const dbFilePath = config.dbFilePath || join(config.workspacePath, "process", "tasks.json");
    return {
      workspacePath: config.workspacePath,
      method: "explicit",
      description: "Using explicitly provided workspace path",
      dbFilePath
    };
  }

  // 2. Repository URL provided - use special workspace
  if (config.repoUrl) {
    const specialWorkspaceManager = createSpecialWorkspaceManager({
      repoUrl: config.repoUrl
    });

    // Initialize the workspace if it doesn't exist
    await specialWorkspaceManager.initialize();

    const workspacePath = specialWorkspaceManager.getWorkspacePath();
    const dbFilePath = config.dbFilePath || join(workspacePath, "process", "tasks.json");

    return {
      workspacePath,
      method: "special-workspace",
      description: `Using special workspace for repository: ${config.repoUrl}`,
      dbFilePath
    };
  }

  // 3. Check for local tasks.json file in process directory
  const currentDir = (process as any).cwd();
  const localTasksPath = join(currentDir, "process", "tasks.json");

  if (existsSync(localTasksPath)) {
    return {
      workspacePath: currentDir,
      method: "local-tasks-md",
      description: "Using current directory with existing tasks.json file",
      dbFilePath: config.dbFilePath || localTasksPath
    };
  }

  // 4. Default to current directory
  const dbFilePath = config.dbFilePath || join(currentDir, "process", "tasks.json");
  return {
    workspacePath: currentDir,
    method: "current-directory",
    description: "Using current directory as default workspace",
    dbFilePath
  };
}

/**
 * JSON backend with workspace resolution metadata
 */
export class WorkspaceResolvingJsonBackend extends JsonFileTaskBackend {
  constructor(
    config: JsonFileTaskBackendOptions,
    private workspaceResolutionResult: WorkspaceResolutionResult
  ) {
    super(config);
  }

  /**
   * Get information about how workspace was resolved
   */
  getWorkspaceResolutionInfo(): WorkspaceResolutionResult {
    return this.workspaceResolutionResult;
  }

  /**
   * This backend manages its own workspace resolution
   * Determine based on resolution method
   */
  isInTreeBackend(): boolean {
    return this.workspaceResolutionResult.method === "special-workspace" ||
           this.workspaceResolutionResult.method === "local-tasks-md";
  }
}

/**
 * Create an enhanced JSON backend
 * This factory function handles async workspace resolution before backend creation
 */
export async function createWorkspaceResolvingJsonBackend(config: WorkspaceResolvingJsonConfig): Promise<TaskBackend> {
  // Resolve workspace path and database file path first
  const resolutionResult = await resolveWorkspacePath(config);

  log.debug("JSON workspace resolution completed", {
    method: resolutionResult.method,
    path: resolutionResult.workspacePath,
    dbFilePath: resolutionResult.dbFilePath,
    description: resolutionResult.description
  });

  // Create backend with resolved workspace and database file path
  const backendConfig: JsonFileTaskBackendOptions = {
    ...config,
    workspacePath: resolutionResult.workspacePath,
    dbFilePath: resolutionResult.dbFilePath
  };

  return new WorkspaceResolvingJsonBackend(backendConfig, resolutionResult);
}

/**
 * Convenience factory for common use cases
 */
export async function createSelfContainedJsonBackend(config: {
  name: string;
  repoUrl?: string;
  workspacePath?: string;
  dbFilePath?: string;
}): Promise<TaskBackend> {
  return createWorkspaceResolvingJsonBackend(config);
}
