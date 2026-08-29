import type { WidgetModule, WidgetContext, WidgetData } from "../types";
import { getSharedMemoryService } from "./shared-memory-service";
import { describeWidgetDegradedReason } from "../db-providers";
import type { MemorySearchResult } from "@minsky/domain/memory/types";
import type { MemoryServiceSurface } from "@minsky/domain/memory/memory-service";
import type { ScopeResolverDb } from "@minsky/domain/project/scope-resolver";

export interface MemoriesSearchPayload {
  results: MemorySearchResult[];
  backend: "embeddings" | "lexical" | "none";
  degraded: boolean;
  query: string;
}

/**
 * Factory: returns a WidgetModule backed by the given memory-service getter.
 * Mirrors `memories-list.ts`'s `createMemoriesListWidget` (mt#4727 test seam).
 */
export function createMemoriesSearchWidget(
  getMemService: () => Promise<MemoryServiceSurface | null>,
  getProjectScopeDb?: () => Promise<ScopeResolverDb | null>
): WidgetModule {
  return {
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
        const memSvc = await getMemService();
        if (!memSvc) {
          return {
            state: "degraded",
            reason: "Memory service unavailable — DB not connected",
          };
        }

        const limit = ctx.query?.limit ? parseInt(ctx.query.limit, 10) : 20;

        // Project scope (mt#4727): ?project=<slug> resolved to a project uuid,
        // defaulting to ALL_PROJECTS when omitted/"all" — same resolution
        // rules as every other cockpit project-scoped read (mt#2418 pattern,
        // task-list.ts:91-93). resolveCockpitProjectScope owns its own
        // db-fetch and never throws (fail-open — PR #2056 R1), so a scoping
        // problem can never take this widget down.
        const { resolveCockpitProjectScope } = await import("../project-scope");
        const projectScope = await resolveCockpitProjectScope(ctx.query?.project, {
          getDb: getProjectScopeDb,
        });

        const response = await memSvc.search(searchQuery, {
          limit,
          filter: { projectScope },
        });

        const payload: MemoriesSearchPayload = {
          results: response.results,
          backend: response.backend,
          degraded: response.degraded,
          query: searchQuery,
        };

        return { state: "ok", payload };
      } catch (err) {
        return { state: "degraded", reason: describeWidgetDegradedReason("memories search", err) };
      }
    },
  };
}

/** Default production widget — the real shared MemoryService singleton. */
export const memoriesSearchWidget: WidgetModule =
  createMemoriesSearchWidget(getSharedMemoryService);
