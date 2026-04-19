/**
 * Shared session provider cache — canonical lazy singleton.
 *
 * @deprecated All production code should use container.get("sessionProvider")
 * instead. This module survives only for test seams and will be removed once
 * all reach-ins are eliminated.
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
 * This lazy singleton survives only for callers that have not yet migrated
 * to container-based DI. Will be removed once all reach-ins are eliminated.
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
