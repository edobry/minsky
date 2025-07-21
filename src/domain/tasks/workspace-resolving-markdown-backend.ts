/**
 * Workspace-Resolving Markdown Task Backend
 * 
 * This backend handles its own workspace resolution internally,
 * eliminating the need for external TaskBackendRouter complexity.
 */

import { join } from "path";
import { existsSync } from "fs";
import { MarkdownTaskBackend } from "./markdownTaskBackend";
import { createSpecialWorkspaceManager } from "../workspace/special-workspace-manager";
import type { TaskBackend } from "./taskBackend";
import type { WorkspaceResolvingMarkdownConfig, WorkspaceResolutionResult } from "./workspace-resolving-backend-config";
import type { TaskBackendConfig } from "../../types/tasks/taskData";
import { log } from "../../utils/logger";

/**
 * Resolve workspace path using configuration
 */
async function resolveWorkspacePath(config: WorkspaceResolvingMarkdownConfig): Promise<WorkspaceResolutionResult> {
  // 1. Explicit workspace path override
  if (config.workspacePath) {
    return {
      workspacePath: config.workspacePath,
      method: "explicit",
      description: "Using explicitly provided workspace path"
    };
  }

  // 2. Repository URL provided - use special workspace
  if (config.repoUrl) {
    const specialWorkspaceManager = createSpecialWorkspaceManager({ 
      repoUrl: config.repoUrl 
    });
    
    // Initialize the workspace if it doesn't exist
    await specialWorkspaceManager.initialize();
    
    return {
      workspacePath: specialWorkspaceManager.getWorkspacePath(),
      method: "special-workspace",
      description: `Using special workspace for repository: ${config.repoUrl}`
    };
  }

  // 3. Check for local tasks.md file (if not forcing special workspace)
  if (!config.forceSpecialWorkspace) {
    const currentDir = (process as any).cwd();
    const localTasksPath = join(currentDir, "process", "tasks.md");
    
    if (existsSync(localTasksPath)) {
      return {
        workspacePath: currentDir,
        method: "local-tasks-md",
        description: "Using current directory with existing tasks.md file"
      };
    }
  }

  // 4. Default to current directory
  return {
    workspacePath: (process as any).cwd(),
    method: "current-directory",
    description: "Using current directory as default workspace"
  };
}

/**
 * Markdown backend with workspace resolution metadata
 */
export class WorkspaceResolvingMarkdownBackend extends MarkdownTaskBackend {
  constructor(
    config: TaskBackendConfig,
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
 * Create a workspace-resolving markdown backend
 * This factory function handles async workspace resolution before backend creation
 */
export async function createWorkspaceResolvingMarkdownBackend(config: WorkspaceResolvingMarkdownConfig): Promise<TaskBackend> {
  // Resolve workspace path first
  const resolutionResult = await resolveWorkspacePath(config);
  
  log.debug("Workspace resolution completed", {
    method: resolutionResult.method,
    path: resolutionResult.workspacePath,
    description: resolutionResult.description
  });

  // Create backend with resolved workspace
  const backendConfig: TaskBackendConfig = {
    ...config,
    workspacePath: resolutionResult.workspacePath
  };

  return new WorkspaceResolvingMarkdownBackend(backendConfig, resolutionResult);
}

/**
 * Convenience factory for common use cases
 */
export async function createSelfContainedMarkdownBackend(config: {
  name: string;
  repoUrl?: string;
  workspacePath?: string;
  forceSpecialWorkspace?: boolean;
}): Promise<TaskBackend> {
  return createWorkspaceResolvingMarkdownBackend(config);
} 
