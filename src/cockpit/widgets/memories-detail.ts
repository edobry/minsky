import type { WidgetModule, WidgetContext, WidgetData } from "../types";
import { getSharedMemoryService } from "./shared-memory-service";
import type { MemoryRecord, MemorySearchResult } from "@minsky/domain/memory/types";

export interface MemoriesDetailPayload {
  record: MemoryRecord;
  lineage: MemoryRecord[];
  lineageTruncated: boolean;
  similar: MemorySearchResult[];
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
      const memSvc = await getSharedMemoryService();
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
