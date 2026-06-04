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

  // Single aggregated query — cheaper than 4 parallel queries and avoids
  // gratuitous connection-pool churn under polling load. (mt#2183: the 4-query
  // form was correct but unnecessarily noisy.)
  const rows = await sql`
    SELECT
      (SELECT count(*)::int FROM tasks) AS tasks_total,
      (SELECT count(*)::int FROM tasks_embeddings) AS tasks_indexed,
      (SELECT count(*)::int FROM memories) AS memories_total,
      (SELECT count(*)::int FROM memories_embeddings) AS memories_indexed
  `;
  const row = (rows[0] ?? {}) as {
    tasks_total?: number;
    tasks_indexed?: number;
    memories_total?: number;
    memories_indexed?: number;
  };

  return {
    tasks: {
      total: row.tasks_total ?? 0,
      indexed: row.tasks_indexed ?? 0,
    },
    memories: {
      total: row.memories_total ?? 0,
      indexed: row.memories_indexed ?? 0,
    },
  };
}

export const embeddingsHealthWidget: WidgetModule = {
  id: "embeddings-health",
  title: "Embeddings",
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
