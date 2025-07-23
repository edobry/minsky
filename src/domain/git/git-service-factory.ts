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
  // Dynamic import to avoid circular dependency - GitService is defined in git.ts
  const GitServiceModule = require("../git");
  const GitService = GitServiceModule.GitService || GitServiceModule.default?.GitService;
  
  if (!GitService) {
    throw new Error("GitService class not found - check git.ts exports");
  }
  
  return new GitService(options?.baseDir);
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