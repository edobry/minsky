/**
 * Shared PersistenceService singleton for cockpit (mt#2102).
 *
 * All cockpit widgets and server endpoints use this single instance instead of
 * creating their own. Prevents connection-pool exhaustion on the Supabase
 * transaction pooler (max: 3 per instance × N instances = deadlock risk).
 *
 * Init-coalescing: concurrent callers await the same initialization promise.
 * Failure-reset: if initialize() rejects, the promise is cleared so retries work.
 */
import type { PersistenceService } from "../domain/persistence/service";
import type { PersistenceProvider } from "../domain/persistence/types";

let _instance: PersistenceService | null = null;
let _initPromise: Promise<PersistenceService> | null = null;

export async function getSharedPersistenceService(): Promise<PersistenceService> {
  if (_instance) return _instance;
  if (_initPromise) return _initPromise;

  _initPromise = (async () => {
    try {
      const { PersistenceService } = await import("../domain/persistence/service");
      const svc = new PersistenceService();
      await svc.initialize();
      _instance = svc;
      return svc;
    } catch (err) {
      _initPromise = null;
      throw err;
    }
  })();

  return _initPromise;
}

export async function getSharedProvider(): Promise<PersistenceProvider> {
  const svc = await getSharedPersistenceService();
  return svc.getProvider();
}
