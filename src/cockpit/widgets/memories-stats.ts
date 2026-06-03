import type { WidgetModule, WidgetContext, WidgetData } from "../types";
import { getSharedPersistenceService } from "../shared-persistence";
import type { MemoryServiceSurface } from "@minsky/domain/memory/memory-service";
import type { MemoryRecord } from "@minsky/domain/memory/types";

export interface MemoriesStatsPayload {
  total: number;
  supersededCount: number;
  byType: {
    user: number;
    feedback: number;
    project: number;
    reference: number;
  };
  recentCount: number;
  topAccessed: Array<{
    id: string;
    name: string;
    accessCount: number;
  }>;
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

export const memoriesStatsWidget: WidgetModule = {
  id: "memories-stats",
  title: "Memories — Statistics",
  updateMode: { type: "polling", intervalMs: 60_000 },
  async fetch(_ctx: WidgetContext): Promise<WidgetData> {
    try {
      const memSvc = await getMemoryService();
      if (!memSvc) {
        return {
          state: "degraded",
          reason: "Memory service unavailable — DB not connected",
        };
      }

      // Fetch all records without excludeSuperseded so we get totals
      const allRecords: MemoryRecord[] = await memSvc.list({});

      const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;

      const byType = { user: 0, feedback: 0, project: 0, reference: 0 };
      let supersededCount = 0;
      let recentCount = 0;

      for (const rec of allRecords) {
        byType[rec.type] = (byType[rec.type] ?? 0) + 1;
        if (rec.supersededBy != null) supersededCount++;
        if (rec.createdAt.getTime() >= sevenDaysAgo) recentCount++;
      }

      const topAccessed = allRecords
        .filter((r) => r.accessCount > 0)
        .sort((a, b) => b.accessCount - a.accessCount)
        .slice(0, 3)
        .map((r) => ({ id: r.id, name: r.name, accessCount: r.accessCount }));

      const payload: MemoriesStatsPayload = {
        total: allRecords.length,
        supersededCount,
        byType,
        recentCount,
        topAccessed,
      };

      return { state: "ok", payload };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { state: "degraded", reason: `memories stats error: ${message}` };
    }
  },
};
