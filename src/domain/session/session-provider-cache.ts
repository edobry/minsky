/**
 * Shared session provider cache — test infrastructure only.
 *
 * @deprecated Zero production callers remain. This module exists solely for
 * test seams (setSharedSessionProvider/resetSharedSessionProvider) used by
 * taskCommands.test.ts. Can be removed once that test migrates to the test
 * container (createTestContainer).
 */
import { createSessionProvider, type SessionProviderInterface } from "./session-db-adapter";
import type { PersistenceProvider } from "../persistence/types";

/**
 * @internal Mutable cache holder exported for test seams only.
 * Production code MUST NOT access this directly — use getSharedSessionProvider()
 * or preferably container.get("sessionProvider").
 */
export const _cache: { provider: SessionProviderInterface | null } = { provider: null };

/**
 * @deprecated Use container.get("sessionProvider") instead.
 * Zero production callers remain — kept only for test seam compatibility.
 */
export async function getSharedSessionProvider(
  persistenceProvider?: PersistenceProvider
): Promise<SessionProviderInterface> {
  if (!_cache.provider) {
    if (!persistenceProvider) {
      throw new Error(
        "getSharedSessionProvider requires a persistenceProvider argument. " +
          "Use container.get('sessionProvider') instead."
      );
    }
    _cache.provider = await createSessionProvider(undefined, persistenceProvider);
  }
  return _cache.provider;
}
