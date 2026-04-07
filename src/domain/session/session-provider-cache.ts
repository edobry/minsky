/**
 * Shared session provider cache — canonical lazy singleton.
 *
 * Used by non-class command handlers and as the default provider source
 * for the session command class hierarchy.
 */
import { createSessionProvider, type SessionProviderInterface } from "./session-db-adapter";

let _cachedProvider: SessionProviderInterface | null = null;

export async function getSharedSessionProvider(): Promise<SessionProviderInterface> {
  if (!_cachedProvider) {
    _cachedProvider = await createSessionProvider();
  }
  return _cachedProvider;
}

/** Reset the cached provider (for testing). @internal */
export function _resetSharedSessionProvider(): void {
  _cachedProvider = null;
}

/** Inject a custom session provider (for testing). @internal */
export function _setSharedSessionProvider(provider: SessionProviderInterface): void {
  _cachedProvider = provider;
}
