/**
 * Shared session provider cache — canonical lazy singleton.
 *
 * Used by non-class command handlers and as the default provider source
 * for the session command class hierarchy.
 *
 * Note: test-facing API for injecting/resetting the cached provider lives
 * in `./session-provider-cache-seams.ts`. Production code MUST NOT import
 * from that module.
 */
import { createSessionProvider, type SessionProviderInterface } from "./session-db-adapter";

let _cachedProvider: SessionProviderInterface | null = null;

export async function getSharedSessionProvider(): Promise<SessionProviderInterface> {
  if (!_cachedProvider) {
    _cachedProvider = await createSessionProvider();
  }
  return _cachedProvider;
}

/**
 * @internal Test-only: low-level helper used by `session-provider-cache-seams.ts`
 * to inject or reset the cached provider. Production code MUST NOT call this.
 * Direct use from production would defeat the singleton semantics.
 */
export function _setProviderForTesting(provider: SessionProviderInterface | null): void {
  _cachedProvider = provider;
}
