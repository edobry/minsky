/**
 * Test seams for session-provider-cache.
 *
 * This module exists ONLY for tests that need to inject or reset the
 * cached session provider singleton (e.g., for hermetic tests that use
 * `FakeSessionProvider`). Production code MUST NOT import from this
 * module.
 *
 * @module session-provider-cache-seams
 */

import type { SessionProviderInterface } from "./types";
import { _setProviderForTesting } from "./session-provider-cache";

/**
 * @internal Test-only: inject a custom session provider into the shared cache.
 * Use this in `beforeEach` to wire up a `FakeSessionProvider` for hermetic
 * tests. Always pair with `resetSharedSessionProvider()` in `afterEach`.
 */
export function setSharedSessionProvider(provider: SessionProviderInterface): void {
  _setProviderForTesting(provider);
}

/**
 * @internal Test-only: reset the cached provider to `null`. Use in `afterEach`
 * to prevent state leakage between tests.
 */
export function resetSharedSessionProvider(): void {
  _setProviderForTesting(null);
}
