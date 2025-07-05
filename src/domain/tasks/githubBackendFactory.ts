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
    const [{ getGitHubBackendConfig }, { createGitHubIssuesTaskBackend }] = await (Promise as any).all([
      import("./githubBackendConfig"),
      import("./githubIssuesTaskBackend"),
    ]);

    const config = getGitHubBackendConfig(__workspacePath, { logErrors: shouldLogErrors });
    if (!config || !(config as any).githubToken || !(config as any).owner || !(config as any).repo) {
      return null as any;
    }

    return createGitHubIssuesTaskBackend({
      name: "github-issues",
      workspacePath: __workspacePath,
      githubToken: (config as any).githubToken,
      owner: (config as any).owner,
      repo: (config as any).repo,
      statusLabels: (config as any).statusLabels,
    });
  } catch (_error) {
    // Return null if GitHub modules are not available
    return null as any;
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
