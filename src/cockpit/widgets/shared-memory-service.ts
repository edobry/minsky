import type { MemoryServiceSurface } from "@minsky/domain/memory/memory-service";
import { getSharedPersistenceService } from "../shared-persistence";

let _cachedMemorySvc: MemoryServiceSurface | null = null;

/**
 * Per-process MemoryService singleton for Cockpit widget backends.
 *
 * All five `memories-*` widget modules (list, search, stats, detail, health)
 * share this instance, avoiding 4× duplicated bootstrap logic and 4× separate
 * caches. Returns `null` when the backing persistence provider has no SQL
 * capability (Cockpit gracefully degrades — widgets return `state: "degraded"`).
 */
export async function getSharedMemoryService(): Promise<MemoryServiceSurface | null> {
  if (_cachedMemorySvc) return _cachedMemorySvc;

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

    _cachedMemorySvc = new MemoryService({ db, embeddingService, vectorStorage });
    return _cachedMemorySvc;
  } catch {
    return null;
  }
}

/**
 * Resets the cached MemoryService. Test-only — production callers should
 * never need this since the cache is keyed on process lifetime.
 */
export function resetSharedMemoryServiceForTesting(): void {
  _cachedMemorySvc = null;
}
