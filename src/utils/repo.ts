import { resolveRepoPath as resolveRepoPathInternal } from "../domain/repo-utils";
import { getSharedSessionProvider } from "../domain/session/session-provider-cache";
import type { SessionProviderInterface } from "../domain/session/index";

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
export async function resolveRepoPath(
  options: RepoResolutionOptions = {},
  sessionProvider?: SessionProviderInterface,
): Promise<string> {
  const provider = sessionProvider ?? (await getSharedSessionProvider());
  return resolveRepoPathInternal(options, { sessionProvider: provider });
}
