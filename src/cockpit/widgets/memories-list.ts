import type { WidgetModule, WidgetContext, WidgetData } from "../types";
import { getSharedPersistenceService } from "../shared-persistence";
import type { MemoryServiceSurface } from "@minsky/domain/memory/memory-service";
import type { MemoryRecord, MemoryType, MemoryScope } from "@minsky/domain/memory/types";

export interface MemoriesListPayload {
  records: MemoryRecord[];
  total: number;
}

let _cachedMemorySvc: MemoryServiceSurface | null = null;

async function getMemoryService(): Promise<MemoryServiceSurface | null> {
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

export const memoriesListWidget: WidgetModule = {
  id: "memories-list",
  title: "Memories — List",
  updateMode: { type: "polling", intervalMs: 30_000 },
  async fetch(ctx: WidgetContext): Promise<WidgetData> {
    try {
      const memSvc = await getMemoryService();
      if (!memSvc) {
        return {
          state: "degraded",
          reason: "Memory service unavailable — DB not connected",
        };
      }

      const { query } = ctx;
      const type = query?.type as MemoryType | undefined;
      const scope = query?.scope as MemoryScope | undefined;
      const excludeSuperseded = query?.excludeSuperseded === "true";
      const limit = query?.limit ? parseInt(query.limit, 10) : undefined;

      let records: MemoryRecord[] = await memSvc.list({
        type,
        scope,
        excludeSuperseded,
      });

      // Apply limit client-side (MemoryListFilter has no limit field)
      if (limit && limit > 0) {
        records = records.slice(0, limit);
      }

      const payload: MemoriesListPayload = {
        records,
        total: records.length,
      };

      return { state: "ok", payload };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { state: "degraded", reason: `memories list error: ${message}` };
    }
  },
};
