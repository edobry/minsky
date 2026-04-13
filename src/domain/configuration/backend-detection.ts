/**
 * Backend Detection Service
 *
 * Provides backend detection functionality using the custom configuration system
 * while preserving existing detection logic and capabilities.
 */

/**
 * Task backend types supported by Minsky
 */
export enum TaskBackend {
  GITHUB_ISSUES = "github-issues",
  GITHUB = "github",
  MINSKY = "minsky",
  DB = "db",
}

export interface BackendDetectionService {
  detectBackend(workingDir: string): Promise<TaskBackend>;
  githubRemoteExists(workingDir: string): Promise<boolean>;
}

export class DefaultBackendDetectionService implements BackendDetectionService {
  /**
   * Detect the most appropriate backend based on project structure.
   * Defaults to MINSKY since file-based backends have been removed.
   */
  async detectBackend(_workingDir: string): Promise<TaskBackend> {
    return TaskBackend.MINSKY;
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
