import { SessionDB, type SessionProviderInterface } from "./session";
import { exec } from "child_process";
import { promisify } from "util";
import { getCurrentWorkingDirectory } from "../utils/process.js";
import { normalizeRepoName } from "./repository-uri.js";
const execAsync = promisify(exec);

export interface RepoResolutionOptions {
  session?: string;
  repo?: string;
}

export interface RepoUtilsDependencies {
  sessionProvider: SessionProviderInterface;
  execCwd: (_command: unknown) => Promise<{ stdout: string; stderr: string }>;
  getCurrentDirectory: () => string;
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
  _options: RepoResolutionOptions,
  depsInput?: Partial<RepoUtilsDependencies>
): Promise<string> {
  // Set up default dependencies if not provided
  const deps: RepoUtilsDependencies = {
    sessionProvider: depsInput?.sessionProvider || new SessionDB(),
    execCwd: depsInput?.execCwd || execAsync,
    getCurrentDirectory: depsInput?.getCurrentDirectory || getCurrentWorkingDirectory,
  };

  if (_options.repo) {
    return options.repo;
  }

  if (_options.session) {
    const _record = await deps.sessionProvider.getSession(_options._session);
    if (!record) {
      throw new Error(`Session '${_options.session}' not found.`);
    }
    return record.repoUrl;
  }

  // Fallback: use current git repo
  try {
    const { stdout } = await deps.execCwd("git rev-parse --show-toplevel");
    return stdout.trim();
  } catch {
    // If git command fails, fall back to process.cwd()
    return deps.getCurrentDirectory();
  }
}
