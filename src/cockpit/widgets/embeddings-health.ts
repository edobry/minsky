import type { WidgetModule, WidgetContext, WidgetData } from "../types";
import { EmbeddingsHealthTracker } from "@minsky/domain/ai/embeddings-health-tracker";
import { getSharedPersistenceService } from "../shared-persistence";

export interface EmbeddingsHealthPayload {
  provider: string;
  status: "healthy" | "degraded" | "exhausted";
  lastErrorAt: string | null;
  errorCountLastHour: number;
  degradedReason: string | null;
  coverage: {
    tasks: { indexed: number; total: number };
    memories: { indexed: number; total: number };
  } | null;
}

async function fetchCoverage(): Promise<EmbeddingsHealthPayload["coverage"]> {
  const svc = await getSharedPersistenceService();
  const provider = svc.getProvider();

  if (!provider.capabilities.sql) {
    return null;
  }

  const rawSql = await provider.getRawSqlConnection?.();
  if (!rawSql) return null;

  const sql = rawSql as import("postgres").Sql;

  const [tasksTotal, tasksIndexed, memoriesTotal, memoriesIndexed] = await Promise.all([
    sql.unsafe("SELECT count(*)::int AS cnt FROM tasks"),
    sql.unsafe("SELECT count(*)::int AS cnt FROM tasks_embeddings"),
    sql.unsafe("SELECT count(*)::int AS cnt FROM memories"),
    sql.unsafe("SELECT count(*)::int AS cnt FROM memories_embeddings"),
  ]);

  return {
    tasks: {
      total: tasksTotal[0]?.cnt ?? 0,
      indexed: tasksIndexed[0]?.cnt ?? 0,
    },
    memories: {
      total: memoriesTotal[0]?.cnt ?? 0,
      indexed: memoriesIndexed[0]?.cnt ?? 0,
    },
  };
}

export const embeddingsHealthWidget: WidgetModule = {
  id: "embeddings-health",
  title: "Memory & Embeddings",
  updateMode: { type: "polling", intervalMs: 15_000 },
  async fetch(_ctx: WidgetContext): Promise<WidgetData> {
    try {
      const summary = EmbeddingsHealthTracker.getInstance().getSummary();
      let coverage: EmbeddingsHealthPayload["coverage"] = null;
      try {
        coverage = await fetchCoverage();
      } catch {
        // DB unavailable — show health without coverage
      }

      const payload: EmbeddingsHealthPayload = {
        ...summary,
        coverage,
      };

      return { state: "ok", payload };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { state: "degraded", reason: `embeddings health error: ${message}` };
    }
  },
};
