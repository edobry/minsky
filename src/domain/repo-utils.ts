import { type SessionProviderInterface } from "./session";
import { getCurrentWorkingDirectory } from "../utils/process";
import { normalizeRepoName } from "./repository-uri";
import { execAsync } from "../utils/exec";

export interface RepoResolutionOptions {
  session?: string;
  repo?: string;
}

export interface RepoUtilsDependencies {
  sessionProvider: SessionProviderInterface;
  execCwd: (command: string) => Promise<{ stdout: string; stderr: string }>;
  getCurrentDirectory: () => string;
}

/**
 * Partial deps where sessionProvider is required but other fields can be defaulted
 */
export interface RepoUtilsPartialDeps {
  sessionProvider: SessionProviderInterface;
  execCwd?: (command: string) => Promise<{ stdout: string; stderr: string }>;
  getCurrentDirectory?: () => string;
}

/**
 * @deprecated Use normalizeRepositoryURI from repository-uri.ts instead
 */
export { normalizeRepoName };

/**
 * Resolves a repository path from options
 * Uses dependency injection for better testability
 */
export async function resolveRepoPath(
  options: RepoResolutionOptions,
  deps: RepoUtilsPartialDeps
): Promise<string> {
  // Set up default dependencies, sessionProvider is required from caller
  const resolvedDeps: RepoUtilsDependencies = {
    sessionProvider: deps.sessionProvider,
    execCwd: deps.execCwd ?? execAsync,
    getCurrentDirectory: deps.getCurrentDirectory ?? getCurrentWorkingDirectory,
  };

  if (options.repo) {
    return options.repo;
  }

  if (options.session) {
    const record = await resolvedDeps.sessionProvider.getSession(options.session);
    if (!record) {
      throw new Error(`Session '${options.session}' not found.`);
    }
    return record.repoUrl;
  }

  // Fallback: use current git repo
  try {
    const { stdout } = await resolvedDeps.execCwd("git rev-parse --show-toplevel");
    return stdout.trim();
  } catch (_error) {
    // If git command fails, fall back to process.cwd()
    return resolvedDeps.getCurrentDirectory();
  }
}
