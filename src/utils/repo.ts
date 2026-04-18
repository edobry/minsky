import { resolveRepoPath as resolveRepoPathInternal } from "../domain/repo-utils";
import type { SessionProviderInterface } from "../domain/session/index";

export interface RepoResolutionOptions {
  session?: string;
  repo?: string;
}

/**
 * Resolve the repository path from session or explicit path
 * If neither is provided, attempt to determine from current directory
 *
 * @param options - Resolution options (session ID or explicit repo path)
 * @param sessionProvider - The session provider for resolving session paths
 */
export async function resolveRepoPath(
  options: RepoResolutionOptions = {},
  sessionProvider: SessionProviderInterface
): Promise<string> {
  return resolveRepoPathInternal(options, { sessionProvider });
}
