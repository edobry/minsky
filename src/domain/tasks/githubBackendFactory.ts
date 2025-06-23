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
  _workspacePath: string,
  shouldLogErrors = false
): Promise<TaskBackend | null> {
  try {
    // Dynamic import to avoid hard dependency
    const [{ getGitHubBackendConfig }, { createGitHubIssuesTaskBackend }] = await Promise.all([
      import("./githubBackendConfig"),
      import("./githubIssuesTaskBackend"),
    ]);

    const _config = getGitHubBackendConfig(_workspacePath, { logErrors: shouldLogErrors });
    if (!config || !config.githubToken || !config.owner || !config.repo) {
      return null;
    }

    return createGitHubIssuesTaskBackend({
      name: "github-issues",
      _workspacePath,
      githubToken: config.githubToken,
      owner: config.owner,
      repo: config.repo,
      statusLabels: config.statusLabels,
    });
  } catch {
    // Return null if GitHub modules are not available
    return null;
  }
}

/**
 * Check if GitHub backend is available
 * @param workspacePath Workspace path
 * @returns True if GitHub backend can be created
 */
export async function isGitHubBackendAvailable(_workspacePath: string): Promise<boolean> {
  const backend = await tryCreateGitHubBackend(_workspacePath);
  return backend !== null;
}
