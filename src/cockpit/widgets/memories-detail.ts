import type { WidgetModule, WidgetContext, WidgetData } from "../types";
import { getSharedPersistenceService } from "../shared-persistence";
import type { MemoryServiceSurface } from "@minsky/domain/memory/memory-service";
import type { MemoryRecord, MemorySearchResult } from "@minsky/domain/memory/types";

export interface MemoriesDetailPayload {
  record: MemoryRecord;
  lineage: MemoryRecord[];
  lineageTruncated: boolean;
  similar: MemorySearchResult[];
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

export const memoriesDetailWidget: WidgetModule = {
  id: "memories-detail",
  title: "Memories — Detail",
  updateMode: { type: "manual" },
  async fetch(ctx: WidgetContext): Promise<WidgetData> {
    const id = ctx.query?.id;
    if (!id) {
      return { state: "degraded", reason: "Missing required query param: id" };
    }

    try {
      const memSvc = await getMemoryService();
      if (!memSvc) {
        return {
          state: "degraded",
          reason: "Memory service unavailable — DB not connected",
        };
      }

      // Fetch record, lineage, and similar in parallel
      const [recordResult, lineageResult, similarResult] = await Promise.allSettled([
        memSvc.get(id),
        memSvc.lineage(id),
        memSvc.similar(id, { limit: 5 }),
      ]);

      if (recordResult.status === "rejected") {
        const msg =
          recordResult.reason instanceof Error
            ? recordResult.reason.message
            : String(recordResult.reason);
        if (msg.includes("not found") || msg.includes("Memory not found")) {
          return { state: "degraded", reason: `Memory not found: ${id}` };
        }
        return { state: "degraded", reason: `Failed to fetch memory: ${msg}` };
      }

      const record = recordResult.value;
      if (!record) {
        return { state: "degraded", reason: `Memory not found: ${id}` };
      }

      const lineage =
        lineageResult.status === "fulfilled"
          ? lineageResult.value
          : { chain: [], truncated: false };
      const similar = similarResult.status === "fulfilled" ? similarResult.value : [];

      const payload: MemoriesDetailPayload = {
        record,
        lineage: lineage.chain,
        lineageTruncated: lineage.truncated,
        similar,
      };

      return { state: "ok", payload };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { state: "degraded", reason: `memories detail error: ${message}` };
    }
  },
};
