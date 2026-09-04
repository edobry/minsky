import type { WidgetModule, WidgetContext, WidgetData } from "../types";
import { getSharedMemoryService } from "./shared-memory-service";
import { describeWidgetDegradedReason } from "../db-providers";
import type { MemoryRecord } from "@minsky/domain/memory/types";
import type { MemoryServiceSurface } from "@minsky/domain/memory/memory-service";
import type { ScopeResolverDb } from "@minsky/domain/project/scope-resolver";

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

// Drizzle's pg driver returns Date objects in-process, but the same domain types
// are serialized to ISO strings when crossing HTTP/JSON boundaries (e.g., if a
// future call-path proxies these records through a serializer). Tolerating both
// shapes defensively prevents a class of silent NaN bugs at the date arithmetic
// boundary.
function toEpochMs(value: Date | string): number {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

/**
 * Explicit limit for the pre-mt#4761 fallback path below (PR #3488 R1
 * NON-BLOCKING 1). `MemoryService.list()` now defaults to `DEFAULT_LIST_CAP`
 * (500) when no `limit` is given — a bound the fallback's own client-side
 * aggregation predates and never accounted for. Without an explicit limit
 * here, a `MemoryServiceSurface` fake lacking `getListStats` (this branch's
 * only caller) would silently undercount every total once the corpus passed
 * 500 rows. Set well above any real corpus size this widget will see; if the
 * corpus ever approaches this, the fallback needs a real fix, not a bigger
 * number.
 */
const STATS_FALLBACK_LIMIT = 1_000_000;

/**
 * Factory: returns a WidgetModule backed by the given memory-service getter.
 * Mirrors `memories-list.ts`'s `createMemoriesListWidget` (mt#4727 test seam).
 */
export function createMemoriesStatsWidget(
  getMemService: () => Promise<MemoryServiceSurface | null>,
  getProjectScopeDb?: () => Promise<ScopeResolverDb | null>
): WidgetModule {
  return {
    id: "memories-stats",
    title: "Memories — Statistics",
    updateMode: { type: "polling", intervalMs: 60_000 },
    async fetch(ctx: WidgetContext): Promise<WidgetData> {
      try {
        const memSvc = await getMemService();
        if (!memSvc) {
          return {
            state: "degraded",
            reason: "Memory service unavailable — DB not connected",
          };
        }

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

        let payload: MemoriesStatsPayload;

        if (memSvc.getListStats) {
          // mt#4761: SQL aggregates — five numbers computed in Postgres
          // instead of fetching every matching row (with full `content`) to
          // compute them client-side (the pre-mt#4761 behavior below, kept
          // as the fallback for a MemoryServiceSurface fake that predates
          // `getListStats`, e.g. the mt#4727 two-project-fixture test).
          const stats = await memSvc.getListStats({ projectScope });
          payload = {
            total: stats.total,
            supersededCount: stats.supersededCount,
            byType: stats.byType,
            recentCount: stats.recentCount,
            topAccessed: stats.topAccessed,
          };
        } else {
          // Fetch all records in scope without excludeSuperseded so we get totals.
          // Explicit `limit` (PR #3488 R1 NON-BLOCKING 1): see STATS_FALLBACK_LIMIT.
          const allRecords: MemoryRecord[] = await memSvc.list({
            projectScope,
            limit: STATS_FALLBACK_LIMIT,
          });

          const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;

          const byType = { user: 0, feedback: 0, project: 0, reference: 0 };
          let supersededCount = 0;
          let recentCount = 0;

          for (const rec of allRecords) {
            byType[rec.type] = (byType[rec.type] ?? 0) + 1;
            if (rec.supersededBy != null) supersededCount++;
            if (toEpochMs(rec.createdAt) >= sevenDaysAgo) recentCount++;
          }

          const topAccessed = allRecords
            .filter((r) => r.accessCount > 0)
            .sort((a, b) => b.accessCount - a.accessCount)
            .slice(0, 3)
            .map((r) => ({ id: r.id, name: r.name, accessCount: r.accessCount }));

          payload = {
            total: allRecords.length,
            supersededCount,
            byType,
            recentCount,
            topAccessed,
          };
        }

        return { state: "ok", payload };
      } catch (err) {
        return { state: "degraded", reason: describeWidgetDegradedReason("memories stats", err) };
      }
    },
  };
}

/** Default production widget — the real shared MemoryService singleton. */
export const memoriesStatsWidget: WidgetModule = createMemoriesStatsWidget(getSharedMemoryService);
