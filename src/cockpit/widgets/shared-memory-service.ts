import type { MemoryServiceSurface } from "@minsky/domain/memory/memory-service";
import { createEpochKeyedCache, getSharedPersistenceService } from "../shared-persistence";

async function resolveMemoryService(): Promise<MemoryServiceSurface | null> {
  try {
    const svc = await getSharedPersistenceService();
    const provider = svc.getProvider();

    if (
      !provider.capabilities.sql ||
      typeof (provider as { getDatabaseConnection?: unknown }).getDatabaseConnection !== "function"
    ) {
      return null;
    }

    const sqlProvider = provider as {
      getDatabaseConnection: () => Promise<import("drizzle-orm/postgres-js").PostgresJsDatabase>;
    };
    const db = await sqlProvider.getDatabaseConnection();
    if (!db) return null;

    const { createEmbeddingServiceFromConfig } = await import(
      "@minsky/domain/ai/embedding-service-factory"
    );
    const { createVectorStorageForDomain } = await import(
      "@minsky/domain/storage/vector/vector-storage-factory"
    );
    const { MemoryService } = await import("@minsky/domain/memory/memory-service");

    const embeddingService = await createEmbeddingServiceFromConfig();
    const vectorStorage = await createVectorStorageForDomain("memory", 1536, provider);

    return new MemoryService({ db, embeddingService, vectorStorage });
  } catch {
    return null;
  }
}

let _getMemorySvc = createEpochKeyedCache(resolveMemoryService);

/**
 * Per-process MemoryService singleton for Cockpit widget backends.
 *
 * All five `memories-*` widget modules (list, search, stats, detail, health)
 * share this instance, avoiding 4× duplicated bootstrap logic and 4× separate
 * caches. Returns `null` when the backing persistence provider has no SQL
 * capability (Cockpit gracefully degrades — widgets return `state: "degraded"`).
 *
 * Cached per persistence epoch, not per process (mt#3721): `MemoryService`
 * closes over the Drizzle `db` handle it was constructed with, so a pool
 * recycle (`recycleSharedPersistence`, mt#3638) leaves it querying a torn-down
 * pool that postgres-js rejects forever. A `null` result is not cached, so a
 * provider that gains SQL capability later is picked up on the next call.
 */
export async function getSharedMemoryService(): Promise<MemoryServiceSurface | null> {
  return _getMemorySvc();
}

/**
 * Resets the cached MemoryService. Test-only — production callers should never
 * need this: the cache self-invalidates on an epoch bump, which is the only
 * event that can invalidate it in production.
 *
 * Rebuilds the cache wrapper rather than nulling a variable, because the cached
 * value now lives inside `createEpochKeyedCache`'s closure.
 */
export function resetSharedMemoryServiceForTesting(): void {
  _getMemorySvc = createEpochKeyedCache(resolveMemoryService);
}
