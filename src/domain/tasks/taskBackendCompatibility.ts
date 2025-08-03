/**
 * Task Backend Compatibility Validation
 * 
 * Implements the compatibility validation rules from Task #357 to ensure
 * task backends work only with compatible repository backends.
 */

import { RepositoryBackendType } from "../repository/index";

/**
 * Validate that a task backend is compatible with a repository backend
 * 
 * Compatibility Matrix:
 * - GitHub Issues Task Backend: Requires GitHub repository backend
 * - Markdown Task Backend: Compatible with any repository backend
 * - JSON File Task Backend: Compatible with any repository backend
 */
export function validateTaskBackendCompatibility(
  repoBackend: RepositoryBackendType,
  taskBackend: string
): void {
  if (taskBackend === "github-issues" && repoBackend !== RepositoryBackendType.GITHUB) {
    throw new Error(
      "GitHub Issues task backend requires GitHub repository backend. " +
        "Current repository backend: " +
        repoBackend +
        "\n\n" +
        "To use GitHub Issues:\n" +
        "1. Use in a GitHub repository (git remote should be github.com)\n" +
        "2. Or switch to a compatible task backend (markdown, json-file)"
    );
  }
}

/**
 * Get compatible task backends for a repository backend type
 */
export function getCompatibleTaskBackends(repoBackend: RepositoryBackendType): string[] {
  const allBackends = ["markdown", "json-file"];
  
  if (repoBackend === RepositoryBackendType.GITHUB) {
    allBackends.push("github-issues");
  }
  
  return allBackends;
}

/**
 * Check if a task backend is compatible with a repository backend
 */
export function isTaskBackendCompatible(
  repoBackend: RepositoryBackendType,
  taskBackend: string
): boolean {
  try {
    validateTaskBackendCompatibility(repoBackend, taskBackend);
    return true;
  } catch {
    return false;
  }
}