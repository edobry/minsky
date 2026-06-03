import type { WidgetModule, WidgetContext, WidgetData } from "../types";
import { getSharedPersistenceService } from "../shared-persistence";
import type { MemoryServiceSurface } from "@minsky/domain/memory/memory-service";
import type { MemorySearchResult } from "@minsky/domain/memory/types";

export interface MemoriesSearchPayload {
  results: MemorySearchResult[];
  backend: "embeddings" | "lexical" | "none";
  degraded: boolean;
  query: string;
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

export const memoriesSearchWidget: WidgetModule = {
  id: "memories-search",
  title: "Memories — Search",
  updateMode: { type: "manual" },
  async fetch(ctx: WidgetContext): Promise<WidgetData> {
    const searchQuery = ctx.query?.q ?? "";

    if (!searchQuery.trim()) {
      return {
        state: "ok",
        payload: {
          results: [],
          backend: "none",
          degraded: false,
          query: "",
        } satisfies MemoriesSearchPayload,
      };
    }

    try {
      const memSvc = await getMemoryService();
      if (!memSvc) {
        return {
          state: "degraded",
          reason: "Memory service unavailable — DB not connected",
        };
      }

      const limit = ctx.query?.limit ? parseInt(ctx.query.limit, 10) : 20;

      const response = await memSvc.search(searchQuery, { limit });

      const payload: MemoriesSearchPayload = {
        results: response.results,
        backend: response.backend,
        degraded: response.degraded,
        query: searchQuery,
      };

      return { state: "ok", payload };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { state: "degraded", reason: `memories search error: ${message}` };
    }
  },
};
