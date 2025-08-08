/**
 * Backend Detection Service
 *
 * Provides backend detection functionality using the custom configuration system
 * while preserving existing detection logic and capabilities.
 */

import { existsSync } from "fs";
import { join } from "path";

/**
 * Task backend types supported by Minsky
 */
export enum TaskBackend {
  MARKDOWN = "markdown",
  JSON_FILE = "json-file", 
  GITHUB_ISSUES = "github-issues",
}

export interface BackendDetectionService {
  detectBackend(workingDir: string): Promise<TaskBackend>;
  tasksMdExists(workingDir: string): Promise<boolean>;
  jsonFileExists(workingDir: string): Promise<boolean>;
  githubRemoteExists(workingDir: string): Promise<boolean>;
}

export class DefaultBackendDetectionService implements BackendDetectionService {
  /**
   * Detect the most appropriate backend based on project structure
   * Uses hardcoded detection logic - this is core application behavior, not user configuration
   */
  async detectBackend(workingDir: string): Promise<TaskBackend> {
    // Check for markdown task backend (process/tasks.md exists)
    if (await this.tasksMdExists(workingDir)) {
      return TaskBackend.MARKDOWN;
    }

    // Check for JSON file task backend (.minsky/tasks.json exists)
    if (await this.jsonFileExists(workingDir)) {
      return TaskBackend.JSON_FILE;
    }

    // Default fallback - prefer markdown for new projects
    return TaskBackend.MARKDOWN;
  }



  /**
   * Check if process/tasks.md exists
   */
  async tasksMdExists(workingDir: string): Promise<boolean> {
    const tasksPath = join(workingDir, "process", "tasks.md");
    return existsSync(tasksPath);
  }

  /**
   * Check if .minsky/tasks.json exists
   */
  async jsonFileExists(workingDir: string): Promise<boolean> {
    const jsonPath = join(workingDir, ".minsky", "tasks.json");
    return existsSync(jsonPath);
  }

  /**
   * Check if GitHub remote exists (disabled for auto-detection)
   */
  async githubRemoteExists(_workingDir: string): Promise<boolean> {
    // GitHub Issues detection is disabled for auto-detection
    // to prevent automatic selection of this backend
    return false;
  }
}

// Export singleton instance
export const _backendDetectionService = new DefaultBackendDetectionService();
