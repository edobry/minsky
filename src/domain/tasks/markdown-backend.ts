/**
 * Simplified Markdown Task Backend
 *
 * Operates directly in the main workspace without special workspace complexity.
 */

import { join } from "path";
import { existsSync } from "fs";
import { MarkdownTaskBackend } from "./markdownTaskBackend";
import type { TaskBackend } from "./taskBackend";
import type { MarkdownConfig, WorkspaceResolutionResult } from "./backend-config";
import type { TaskBackendConfig } from "../../types/tasks/taskData";
import { log } from "../../utils/logger";

/**
 * Resolve workspace path using configuration
 */
function resolveWorkspacePath(config: MarkdownConfig): WorkspaceResolutionResult {
  // 1. Use explicitly provided workspace path
  if (config.workspacePath) {
    return {
      workspacePath: config.workspacePath,
      method: "explicit",
      description: "Using explicitly provided workspace path",
    };
  }

  // 2. Use current working directory as default
  const workspacePath = process.cwd();

  return {
    workspacePath,
    method: "current-directory",
    description: "Using current working directory",
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
   * This backend operates in-tree (in the main workspace)
   */
  isInTreeBackend(): boolean {
    return true;
  }
}

/**
 * Create markdown backend with workspace resolution
 */
export function createMarkdownBackend(config: MarkdownConfig): TaskBackend {
  // Resolve workspace path
  const resolutionResult = resolveWorkspacePath(config);

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
export function createSelfContainedMarkdownBackend(config: {
  name: string;
  workspacePath?: string;
}): TaskBackend {
  return createMarkdownBackend(config);
}
