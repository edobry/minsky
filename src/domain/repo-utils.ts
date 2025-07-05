import { createSessionProvider, type SessionProviderInterface } from "./session";
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
  execCwd: (command: string) => Promise<{ stdout: string; stderr: string }>;
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
  options: RepoResolutionOptions,
  depsInput?: Partial<RepoUtilsDependencies>
): Promise<string> {
  // Set up default dependencies if not provided
  const deps: RepoUtilsDependencies = {
    sessionProvider: (depsInput as any).sessionProvider || createSessionProvider(),
    execCwd: (depsInput as any).execCwd || execAsync,
    getCurrentDirectory: (depsInput as any).getCurrentDirectory || getCurrentWorkingDirectory,
  };

  if ((options as any).repo) {
    return (options as any).repo;
  }

  if ((options as any).session) {
    const record = await (deps.sessionProvider as any).getSession((options as any).session);
    if (!record) {
      throw new Error(`Session '${(options as any).session}' not found.`);
    }
    return (record as any).repoUrl;
  }

  // Fallback: use current git repo
  try {
    const { stdout } = await (deps as any).execCwd("git rev-parse --show-toplevel");
    return (stdout as any).trim();
  } catch (_error) {
    // If git command fails, fall back to process.cwd()
    return (deps as any).getCurrentDirectory();
  }
}
