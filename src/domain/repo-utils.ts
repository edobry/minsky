import { SessionDB } from "./session";
import { exec } from "child_process";
import { promisify } from "util";
import { basename } from "path";
import { execAsync as execAsyncUtil } from "../utils/exec.js";
import { getCurrentWorkingDirectory } from "../utils/process.js";
import { normalizeRepositoryURI } from "./repository-uri.js";
const execAsync = promisify(exec);

export interface RepoResolutionOptions {
  session?: string;
  repo?: string;
}

/**
 * Normalizes a repository URL or path into a standardized format.
 * For remote URLs: org/project (e.g., github.com/org/project.git -> org/project)
 * For local paths: local/project (e.g., /Users/edobry/Projects/minsky -> local/minsky)
 * 
 * @deprecated Use normalizeRepositoryURI from repository-uri.ts instead
 */
export function normalizeRepoName(repoUrl: string): string {
  // Use the new standardized function
  return normalizeRepositoryURI(repoUrl);
}

export async function resolveRepoPath(options: RepoResolutionOptions): Promise<string> {
  if (options.repo) {
    return options.repo;
  }
  if (options.session) {
    const db = new SessionDB();
    const record = await db.getSession(options.session);
    if (!record) {
      throw new Error(`Session '${options.session}' not found.`);
    }
    return record.repoUrl;
  }
  // Fallback: use current git repo
  try {
    const { stdout } = await execAsync("git rev-parse --show-toplevel");
    return stdout.trim();
  } catch (error) {
    // If git command fails, fall back to process.cwd()
    return getCurrentWorkingDirectory();
  }
}
