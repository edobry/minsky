import { resolveRepoPath as resolveRepoPathInternal } from "../domain/repo-utils";
import { createSessionProvider } from "../domain/session";

export interface RepoResolutionOptions {
  session?: string;
  repo?: string;
}

/**
 * Resolve the repository path from session or explicit path
 * If neither is provided, attempt to determine from current directory
 *
 * Note: This is a composition boundary — creates a sessionProvider for the domain function.
 */
export async function resolveRepoPath(options: RepoResolutionOptions = {}): Promise<string> {
  const sessionProvider = await createSessionProvider();
  return resolveRepoPathInternal(options, { sessionProvider });
}
