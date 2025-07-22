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
import type { MarkdownConfig, WorkspaceResolutionResult } from "./backend-config";
import type { TaskBackendConfig } from "../../types/tasks/taskData";
import { log } from "../../utils/logger";

/**
 * Resolve workspace path using configuration
 */
async function resolveWorkspacePath(config: MarkdownConfig): Promise<WorkspaceResolutionResult> {
  // 1. Explicit workspace path override
  if (config.workspacePath) {
    return {
      workspacePath: config.workspacePath,
      method: "explicit",
      description: "Using explicitly provided workspace path",
    };
  }

  // 2. Repository URL provided - use special workspace with timeout protection
  if (config.repoUrl) {
    try {
      const specialWorkspaceManager = createSpecialWorkspaceManager({
        repoUrl: config.repoUrl,
      });

      // Add timeout protection for initialization
      const initTimeout = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("Special workspace initialization timeout")), 10000); // 10 second timeout
      });

      const initPromise = specialWorkspaceManager.initialize();

      await Promise.race([initPromise, initTimeout]);

      return {
        workspacePath: specialWorkspaceManager.getWorkspacePath(),
        method: "special-workspace",
        description: `Using special workspace for repository: ${config.repoUrl}`,
      };
    } catch (error) {
      log.warn("Special workspace failed, falling back to current directory", {
        error: error instanceof Error ? error.message : String(error),
        repoUrl: config.repoUrl,
      });
      // Fall through to current directory fallback
    }
  }

  // 3. Check for local tasks.md file (if not forcing special workspace)
  if (!config.forceSpecialWorkspace) {
    const currentDir = (process as any).cwd();
    const localTasksPath = join(currentDir, "process", "tasks.md");

    if (existsSync(localTasksPath)) {
      return {
        workspacePath: currentDir,
        method: "local-tasks-md",
        description: "Using current directory with existing tasks.md file",
      };
    }
  }

  // 4. Default to current directory
  return {
    workspacePath: (process as any).cwd(),
    method: "current-directory",
    description: "Using current directory as default workspace",
  };
}

/**
 * Markdown backend with workspace resolution metadata
 */
export class ConfigurableMarkdownBackend extends MarkdownTaskBackend {
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
    return (
      this.workspaceResolutionResult.method === "special-workspace" ||
      this.workspaceResolutionResult.method === "local-tasks-md"
    );
  }
}

/**
 * Create a markdown backend
 * This factory function handles async workspace resolution before backend creation
 */
export async function createMarkdownBackend(config: MarkdownConfig): Promise<TaskBackend> {
  // Resolve workspace path first
  const resolutionResult = await resolveWorkspacePath(config);

  log.debug("Workspace resolution completed", {
    method: resolutionResult.method,
    path: resolutionResult.workspacePath,
    description: resolutionResult.description,
  });

  // Create backend with resolved workspace
  const backendConfig: TaskBackendConfig = {
    ...config,
    workspacePath: resolutionResult.workspacePath,
  };

  return new ConfigurableMarkdownBackend(backendConfig, resolutionResult);
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
