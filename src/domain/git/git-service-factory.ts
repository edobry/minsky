/**
 * Git Service Factory
 *
 * Factory function for creating GitService instances.
 * Extracted from git.ts to support modular architecture.
 */
import { type GitServiceInterface } from "./types";

/**
 * Creates a default GitService implementation
 * This factory function provides a consistent way to get a git service with optional customization
 *
 * @param options Optional configuration options for the git service
 * @returns A GitServiceInterface implementation
 */
export function createGitService(options?: { baseDir?: string }): GitServiceInterface {
  // Use lazy static import to avoid circular dependency and hanging during MCP startup
  try {
    const { GitService } = require("../git");

    if (!GitService) {
      throw new Error("GitService class not found - check git.ts exports");
    }

    return new GitService(options?.baseDir);
  } catch (error) {
    // If require fails during MCP startup, provide a minimal fallback
    throw new Error(
      `Failed to load GitService: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Create GitService with custom configuration
 */
export function createConfiguredGitService(config: {
  baseDir?: string;
  timeout?: number;
  retries?: number;
}): GitServiceInterface {
  // For now, just pass baseDir - in future, could handle more complex configuration
  return createGitService({ baseDir: config.baseDir });
}
