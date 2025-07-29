/**
 * Self-Contained Backend Configuration Interfaces
 *
 * This file defines configuration interfaces that allow backends
 * to handle their own workspace resolution, eliminating the need for
 * external TaskBackendRouter complexity.
 */

import type { TaskBackendConfig } from "../../types/tasks/taskData";

/**
 * Configuration for markdown backends with internal workspace resolution
 */
export interface WorkspaceResolvingMarkdownConfig extends Omit<TaskBackendConfig, "workspacePath"> {
  name: string;

  /**
   * Repository URL for workspace resolution
   */
  repoUrl?: string;

  /**
   * Explicit workspace path override
   * When provided, takes precedence over repoUrl resolution
   */
  workspacePath?: string;

  /**
   * Force workspace selection behavior
   * Default: false (use local if available)
   */
}

/**
 * Configuration for JSON file backends with internal workspace resolution
 */
export interface WorkspaceResolvingJsonConfig extends Omit<TaskBackendConfig, "workspacePath"> {
  name: string;

  /**
   * Database file path
   * Can be absolute or relative to resolved workspace
   */
  dbFilePath?: string;

  /**
   * Repository URL for in-tree storage (optional)
   * When provided, backend will use special workspace
   */
  repoUrl?: string;

  /**
   * Explicit workspace path override
   */
  workspacePath?: string;
}

/**
 * TaskService options for backends that manage their own workspaces
 */
export interface BackendManagedTaskServiceOptions {
  /**
   * Backend type to use
   */
  backend: string;

  /**
   * Backend-specific configuration
   * Backend handles workspace resolution internally
   */
  backendConfig?: WorkspaceResolvingMarkdownConfig | WorkspaceResolvingJsonConfig;

  /**
   * Custom backend instances (for testing or advanced use cases)
   */
  customBackends?: any[];
}

/**
 * Workspace resolution result
 */
export interface WorkspaceResolutionResult {
  workspacePath: string;
  method: "explicit" | "current-directory" | "local-tasks-md";
  description: string;
}
