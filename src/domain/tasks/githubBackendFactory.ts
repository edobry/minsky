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
  workspacePath: string,
  shouldLogErrors = false
): Promise<TaskBackend | null> {
  try {
    // Dynamic import to avoid hard dependency
    const [{ getGitHubBackendConfig }, { createGitHubIssuesTaskBackend }] = await (Promise as unknown).all([
      import("./githubBackendConfig"),
      import("./githubIssuesTaskBackend"),
    ]);

    const config = getGitHubBackendConfig(workspacePath, { logErrors: shouldLogErrors });
    if (!config || !(config as unknown)!.githubToken || !(config as unknown)!.owner || !(config as unknown)!.repo) {
      return null;
    }

    return createGitHubIssuesTaskBackend({
      name: "github-issues",
      workspacePath: workspacePath,
      githubToken: (config as unknown)!.githubToken,
      owner: (config as unknown)!.owner,
      repo: (config as unknown)!.repo,
      statusLabels: (config as unknown)!.statusLabels,
    });
  } catch (_error) {
    // Return null if GitHub modules are not available
    return null;
  }
}

/**
 * Check if GitHub backend is available
 * @param workspacePath Workspace path
 * @returns True if GitHub backend can be created
 */
export async function isGitHubBackendAvailable(workspacePath: string): Promise<boolean> {
  const backend = await tryCreateGitHubBackend(workspacePath);
  return backend !== null;
}
