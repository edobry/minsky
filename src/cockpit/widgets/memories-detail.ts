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

      // Resolve the record FIRST, then fan out on its canonical uuid.
      //
      // `id` here is a raw route param and may be a `mem#N` short id
      // (mt#3259). `get` accepts both forms, but `lineage`/`similar` are
      // uuid-only — issuing all three against the raw param left the two
      // rejected promises to be swallowed by `allSettled` into empty
      // lineage/similar, so a short-id URL would have rendered a record with
      // silently missing relationships rather than an error. Sequencing the
      // resolve first costs one round-trip and makes the fan-out
      // unambiguously uuid-keyed.
      const record = await memSvc.get(id);
      if (!record) {
        return { state: "degraded", reason: `Memory not found: ${id}` };
      }

      const [lineageResult, similarResult] = await Promise.allSettled([
        memSvc.lineage(record.id),
        memSvc.similar(record.id, { limit: 5 }),
      ]);

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
