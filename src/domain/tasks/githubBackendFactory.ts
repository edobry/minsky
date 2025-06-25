/**
 * GitHub Backend Factory
 * Handles dynamic loading of GitHub backend to avoid hard dependencies
 */

import type { TaskBackend } from "./taskBackend";

/**
 * Try to create a GitHub backend instance
 * @param workspacePath Workspace path
 * @param shouldLogErrors Whether to log errors when configuration is not available
 * @returns GitHub backend or null if not available
 */
export async function tryCreateGitHubBackend(
  __workspacePath: string,
  shouldLogErrors = false
): Promise<TaskBackend | null> {
  try {
    // Dynamic import to avoid hard dependency
    const [{ getGitHubBackendConfig }, { createGitHubIssuesTaskBackend }] = await Promise.all([
      import("./githubBackendConfig"),
      import("./githubIssuesTaskBackend"),
    ]);

    const config = getGitHubBackendConfig(__workspacePath, { logErrors: shouldLogErrors });
    if (!config || !config.githubToken || !config.owner || !config.repo) {
      return null;
    }

    return createGitHubIssuesTaskBackend({
      name: "github-issues",
      workspacePath: __workspacePath,
      githubToken: config.githubToken,
      owner: config.owner,
      repo: config.repo,
      statusLabels: config.statusLabels,
    });
  } catch (_error) {
    console.log('[DEBUG] Caught error in src/domain/tasks/githubBackendFactory.ts:38:', typeof error !== 'undefined' ? 'error defined' : 'error undefined', typeof _error !== 'undefined' ? '_error defined' : '_error undefined');
    // Return null if GitHub modules are not available
    return null;
  }
}

/**
 * Check if GitHub backend is available
 * @param workspacePath Workspace path
 * @returns True if GitHub backend can be created
 */
export async function isGitHubBackendAvailable(__workspacePath: string): Promise<boolean> {
  const backend = await tryCreateGitHubBackend(__workspacePath);
  return backend !== null;
}
