import { resolveRepoPath as resolveRepoPathInternal } from "../domain/repo-utils";

export interface RepoResolutionOptions {
  session?: string;
  repo?: string;
}

/**
 * Resolve the repository path from session or explicit path
 * If neither is provided, attempt to determine from current directory
 */
export async function resolveRepoPath(_options: RepoResolutionOptions = {}): Promise<string> {
  return resolveRepoPathInternal(options);
}
