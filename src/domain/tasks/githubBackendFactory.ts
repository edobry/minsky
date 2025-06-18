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
    // Use runtime require to avoid TypeScript module resolution issues
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { getGitHubBackendConfig } = require("./githubBackendConfig");
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { createGitHubIssuesTaskBackend } = require("./githubIssuesTaskBackend");

    const config = getGitHubBackendConfig(workspacePath);
    if (!config) {
      return null;
    }

    return createGitHubIssuesTaskBackend({
      name: "github-issues",
      workspacePath,
      ...config
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
