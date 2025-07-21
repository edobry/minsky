/**
 * Workspace-Resolving TaskService Implementation
 * 
 * This enhanced TaskService integrates with workspace-resolving backends,
 * eliminating the need for external workspace resolution and providing 
 * a simplified one-step creation pattern.
 */

import { TaskService, type TaskServiceOptions } from "./taskService";
import { createWorkspaceResolvingMarkdownBackend } from "./workspace-resolving-markdown-backend";
import type { 
  WorkspaceResolvingMarkdownConfig, 
  WorkspaceResolvingJsonConfig,
  BackendManagedTaskServiceOptions 
} from "./workspace-resolving-backend-config";
import type { TaskBackend } from "../tasks";
import { log } from "../../utils/logger";

/**
 * Enhanced TaskService with workspace-resolving backend support
 */
export class WorkspaceResolvingTaskService extends TaskService {
  
  /**
   * Create TaskService with workspace-resolving backend configuration
   * This eliminates the need for external workspace resolution
   */
  static async createWithWorkspaceResolvingBackend(
    options: BackendManagedTaskServiceOptions
  ): Promise<TaskService> {
    const { backend, backendConfig, customBackends } = options;

    log.debug("Creating TaskService with workspace-resolving backend", {
      backend,
      hasConfig: !!backendConfig,
      hasCustomBackends: !!customBackends
    });

    // If custom backends provided, use traditional pattern
    if (customBackends) {
      return new TaskService({
        customBackends,
        backend
      });
    }

    // Create workspace-resolving backend based on type
    let resolvedBackend: any; // Using any for now since workspace-resolving backends extend the interface
    
    switch (backend) {
    case "markdown": {
      if (!backendConfig) {
        throw new Error("Backend configuration required for markdown backend");
      }
        
      resolvedBackend = await createWorkspaceResolvingMarkdownBackend(
          backendConfig as WorkspaceResolvingMarkdownConfig
      );
      break;
    }
      
    case "json-file": {
      // TODO: Implement workspace-resolving JSON backend (Task #306)
      throw new Error("Workspace-resolving JSON backend not yet implemented (see Task #306)");
    }
      
    default: {
      throw new Error(`Workspace-resolving backend not available for type: ${backend}`);
    }
    }

    // Create TaskService with the resolved backend
    const taskServiceOptions: TaskServiceOptions = {
      workspacePath: resolvedBackend.getWorkspacePath(),
      backend,
      customBackends: [resolvedBackend]
    };

    return new TaskService(taskServiceOptions);
  }

  /**
   * Convenience method for markdown backends with repo URLs
   */
  static async createMarkdownWithRepo(config: {
    repoUrl: string;
    forceSpecialWorkspace?: boolean;
  }): Promise<TaskService> {
    return WorkspaceResolvingTaskService.createWithWorkspaceResolvingBackend({
      backend: "markdown",
      backendConfig: {
        name: "markdown",
        repoUrl: config.repoUrl,
        forceSpecialWorkspace: config.forceSpecialWorkspace
      }
    });
  }

  /**
   * Convenience method for markdown backends with explicit workspace paths
   */
  static async createMarkdownWithWorkspace(config: {
    workspacePath: string;
  }): Promise<TaskService> {
    return WorkspaceResolvingTaskService.createWithWorkspaceResolvingBackend({
      backend: "markdown", 
      backendConfig: {
        name: "markdown",
        workspacePath: config.workspacePath
      }
    });
  }

  /**
   * Convenience method for current directory workspace detection
   */
  static async createMarkdownWithAutoDetection(): Promise<TaskService> {
    return WorkspaceResolvingTaskService.createWithWorkspaceResolvingBackend({
      backend: "markdown",
      backendConfig: {
        name: "markdown"
        // No explicit config - will auto-detect workspace
      }
    });
  }
}

/**
 * Factory function for backward compatibility
 */
export async function createWorkspaceResolvingTaskService(
  options: BackendManagedTaskServiceOptions
): Promise<TaskService> {
  return WorkspaceResolvingTaskService.createWithWorkspaceResolvingBackend(options);
}

/**
 * Example usage patterns enabled by this architecture:
 * 
 * // Repository-based workflow
 * const taskService = await WorkspaceResolvingTaskService.createMarkdownWithRepo({
 *   repoUrl: "https://github.com/user/repo.git"
 * });
 * 
 * // Explicit workspace
 * const taskService = await WorkspaceResolvingTaskService.createMarkdownWithWorkspace({
 *   workspacePath: "/path/to/workspace"
 * });
 * 
 * // Auto-detection
 * const taskService = await WorkspaceResolvingTaskService.createMarkdownWithAutoDetection();
 * 
 * // Full configuration
 * const taskService = await WorkspaceResolvingTaskService.createWithWorkspaceResolvingBackend({
 *   backend: "markdown",
 *   backendConfig: {
 *     name: "markdown",
 *     repoUrl: "https://github.com/user/repo.git",
 *     forceSpecialWorkspace: true
 *   }
 * });
 */ 
