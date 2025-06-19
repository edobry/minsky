/**
 * GitHub Backend Factory
 * Handles dynamic loading of GitHub backend to avoid hard dependencies
 */

import type { TaskBackend } from "./taskBackend";

/**
 * Try to create a GitHub backend instance
 * @param workspacePath Workspace path
 * @returns GitHub backend or null if not available
 */
export async function tryCreateGitHubBackend(workspacePath: string): Promise<TaskBackend | null> {
  try {
    // Dynamic import to avoid hard dependency
    const [{ getGitHubBackendConfig }, { createGitHubIssuesTaskBackend }] = await Promise.all([
      import("./githubBackendConfig"),
      import("./githubIssuesTaskBackend"),
    ]);

    const config = getGitHubBackendConfig(workspacePath);
    if (!config || !config.githubToken || !config.owner || !config.repo) {
      return null;
    }

    return createGitHubIssuesTaskBackend({
      name: "github-issues",
      workspacePath,
      githubToken: config.githubToken,
      owner: config.owner,
      repo: config.repo,
      statusLabels: config.statusLabels,
    });
  } catch (error) {
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
