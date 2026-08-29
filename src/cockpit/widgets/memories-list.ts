import type { WidgetModule, WidgetContext, WidgetData } from "../types";
import { getSharedMemoryService } from "./shared-memory-service";
import { describeWidgetDegradedReason } from "../db-providers";
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

      // Project scope (mt#4727): ?project=<slug> resolved to a project uuid,
      // defaulting to ALL_PROJECTS when omitted/"all" — same resolution
      // rules as every other cockpit project-scoped read (mt#2418 pattern,
      // task-list.ts:91-93). resolveCockpitProjectScope owns its own
      // db-fetch and never throws (fail-open — PR #2056 R1), so a scoping
      // problem can never take this widget down.
      const { resolveCockpitProjectScope } = await import("../project-scope");
      const projectScope = await resolveCockpitProjectScope(query?.project);

      let records: MemoryRecord[] = await memSvc.list({
        type,
        scope,
        excludeSuperseded,
        projectScope,
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
      return { state: "degraded", reason: describeWidgetDegradedReason("memories list", err) };
    }
  },
};
