import type { WidgetModule, WidgetContext, WidgetData } from "../types";
import { getSharedMemoryService } from "./shared-memory-service";
import type { MemorySearchResult } from "@minsky/domain/memory/types";

export interface MemoriesSearchPayload {
  results: MemorySearchResult[];
  backend: "embeddings" | "lexical" | "none";
  degraded: boolean;
  query: string;
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
      const memSvc = await getSharedMemoryService();
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
