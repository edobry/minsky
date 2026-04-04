/**
 * Canonical session directory resolution utility
 *
 * Centralizes the scattered pattern of: create provider -> lookup session -> resolve path
 * that was previously duplicated in SessionPathResolver, BaseGitOperation, and other code paths.
 * See mt#562 for background on the bugs caused by inconsistent implementations.
 */

import { createSessionProvider, type SessionProviderInterface } from "./session-db-adapter";
import { log } from "../../utils/logger";

/** Lazily-initialized session provider singleton for directory resolution */
let _cachedProvider: SessionProviderInterface | null = null;

/**
 * Get or create the session provider (lazy async init).
 * Uses a module-level cache so repeated calls avoid re-creating the provider.
 */
async function getOrCreateProvider(): Promise<SessionProviderInterface> {
  if (!_cachedProvider) {
    _cachedProvider = await createSessionProvider();
  }
  return _cachedProvider;
}

/**
 * Resolve a session ID to its absolute filesystem directory path.
 *
 * This is the single canonical way to go from a session ID (e.g. "task-mt#123")
 * to the absolute path of its working directory on disk. It handles:
 *   1. Lazy async creation of the session provider
 *   2. Session record lookup (with clear error if not found)
 *   3. Filesystem path resolution via getRepoPath
 *
 * @param sessionId - The session identifier (e.g. "task-mt#123")
 * @returns The absolute filesystem path to the session's working directory
 * @throws Error if the session is not found or the path cannot be resolved
 */
export async function resolveSessionDirectory(sessionId: string): Promise<string> {
  log.debug(`Resolving session directory for: ${sessionId}`);

  const provider = await getOrCreateProvider();

  const session = await provider.getSession(sessionId);
  if (!session) {
    throw new Error(`Session "${sessionId}" not found`);
  }

  const repoPath = await provider.getRepoPath(session);
  log.debug(`Resolved session "${sessionId}" to path: ${repoPath}`);

  return repoPath;
}

/**
 * Reset the cached provider (for testing purposes).
 * @internal
 */
export function _resetCachedProvider(): void {
  _cachedProvider = null;
}
