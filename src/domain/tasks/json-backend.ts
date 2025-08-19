/**
 * Simplified JSON Task Backend
 *
 * Operates directly in the main workspace.
 */

import { join } from "path";
import { JsonFileTaskBackend } from "./jsonFileTaskBackend";
import type { TaskBackend } from "./types";
import type { JsonConfig, WorkspaceResolutionResult } from "./backend-config";
import type { JsonFileTaskBackendOptions } from "./jsonFileTaskBackend";
import { log } from "../../utils/logger";

/**
 * Resolve workspace path and database file path using configuration
 */
function resolveWorkspacePath(
  config: JsonConfig
): WorkspaceResolutionResult & { dbFilePath: string } {
  // 1. Use explicitly provided workspace path
  if (config.workspacePath) {
    const dbFilePath = config.dbFilePath || join(config.workspacePath, "process", "tasks.json");
    return {
      workspacePath: config.workspacePath,
      method: "explicit",
      description: "Using explicitly provided workspace path",
      dbFilePath,
    };
  }

  // 2. Use current working directory as default
  const workspacePath = process.cwd();
  const dbFilePath = config.dbFilePath || join(workspacePath, "process", "tasks.json");

  return {
    workspacePath,
    method: "current-directory",
    description: "Using current working directory",
    dbFilePath,
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
   * This backend operates in-tree (in the main workspace)
   */
  isInTreeBackend(): boolean {
    return true;
  }
}

/**
 * Create a simplified JSON backend
 */
export function createWorkspaceResolvingJsonBackend(config: JsonConfig): TaskBackend {
  // Resolve workspace path and database file path
  const resolutionResult = resolveWorkspacePath(config);

  log.debug("JSON workspace resolution completed", {
    method: resolutionResult.method,
    path: resolutionResult.workspacePath,
    dbFilePath: resolutionResult.dbFilePath,
    description: resolutionResult.description,
  });

  // Create backend with resolved workspace and database file path
  const backendConfig: JsonFileTaskBackendOptions = {
    ...config,
    workspacePath: resolutionResult.workspacePath,
    dbFilePath: resolutionResult.dbFilePath,
  };

  return new WorkspaceResolvingJsonBackend(backendConfig, resolutionResult);
}

/**
 * Convenience factory for common use cases
 */
export function createSelfContainedJsonBackend(config: {
  name: string;
  workspacePath?: string;
  dbFilePath?: string;
}): TaskBackend {
  return createWorkspaceResolvingJsonBackend(config);
}
