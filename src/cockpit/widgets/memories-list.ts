import type { WidgetModule, WidgetContext, WidgetData } from "../types";
import { getSharedMemoryService } from "./shared-memory-service";
import type { MemoryRecord, MemoryType, MemoryScope } from "@minsky/domain/memory/types";

export interface MemoriesListPayload {
  records: MemoryRecord[];
  total: number;
}

export const memoriesListWidget: WidgetModule = {
  id: "memories-list",
  title: "Memories — List",
  updateMode: { type: "polling", intervalMs: 30_000 },
  async fetch(ctx: WidgetContext): Promise<WidgetData> {
    try {
      const memSvc = await getSharedMemoryService();
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
