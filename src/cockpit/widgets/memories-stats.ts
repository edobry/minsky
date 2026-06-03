import type { WidgetModule, WidgetContext, WidgetData } from "../types";
import { getSharedMemoryService } from "./shared-memory-service";
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

// Drizzle's pg driver returns Date objects in-process, but the same domain types
// are serialized to ISO strings when crossing HTTP/JSON boundaries (e.g., if a
// future call-path proxies these records through a serializer). Tolerating both
// shapes defensively prevents a class of silent NaN bugs at the date arithmetic
// boundary.
function toEpochMs(value: Date | string): number {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

export const memoriesStatsWidget: WidgetModule = {
  id: "memories-stats",
  title: "Memories — Statistics",
  updateMode: { type: "polling", intervalMs: 60_000 },
  async fetch(_ctx: WidgetContext): Promise<WidgetData> {
    try {
      const memSvc = await getSharedMemoryService();
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
        if (toEpochMs(rec.createdAt) >= sevenDaysAgo) recentCount++;
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
