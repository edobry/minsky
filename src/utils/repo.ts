import { resolveRepoPath as resolveRepoPathInternal } from "../domain/repo-utils";
import { getSharedSessionProvider } from "../domain/session/session-provider-cache";

export interface RepoResolutionOptions {
  session?: string;
  repo?: string;
}

/**
 * Resolve the repository path from session or explicit path
 * If neither is provided, attempt to determine from current directory
 *
 * Note: This is a composition boundary — uses the shared session provider cache.
 */
export async function resolveRepoPath(options: RepoResolutionOptions = {}): Promise<string> {
  const sessionProvider = await getSharedSessionProvider();
  return resolveRepoPathInternal(options, { sessionProvider });
}
