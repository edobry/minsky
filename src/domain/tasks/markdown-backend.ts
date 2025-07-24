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
async function resolveWorkspacePath(config: MarkdownConfig, isReadOperation: boolean = false): Promise<WorkspaceResolutionResult> {
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

      // Use read-only initialization for read operations to avoid locking
      const initPromise = isReadOperation
        ? specialWorkspaceManager.initializeReadOnly()
        : specialWorkspaceManager.initialize();

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

  // 3. ALWAYS use special workspace for task operations - NO FALLBACKS
  // Task operations MUST be consistent across CLI and MCP interfaces
  log.debug("Task operations require special workspace - waiting for initialization");

  const specialWorkspaceManager = createSpecialWorkspaceManager({
    repoUrl: "https://github.com/local/minsky-tasks.git", // Default repo for tasks
    workspaceName: "task-operations",
    lockTimeoutMs: 30000, // Wait up to 30 seconds for lock
  });

  // Use read-only initialization for read operations to avoid locking
  if (isReadOperation) {
    await specialWorkspaceManager.initializeReadOnly();
  } else {
    await specialWorkspaceManager.initialize();
  }

  return {
    workspacePath: specialWorkspaceManager.getWorkspacePath(),
    method: "special-workspace",
    description: "Using special workspace for consistent task operations",
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
 * Create markdown backend with workspace resolution
 */
export async function createMarkdownBackend(config: MarkdownConfig, isReadOperation: boolean = false): Promise<TaskBackend> {
  // Resolve workspace path first
  const resolutionResult = await resolveWorkspacePath(config, isReadOperation);

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
}, isReadOperation: boolean = false): Promise<TaskBackend> {
  return createMarkdownBackend(config, isReadOperation);
}
