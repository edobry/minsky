import type { WidgetModule, WidgetContext, WidgetData } from "../types";
import { EmbeddingsHealthTracker } from "@minsky/domain/ai/embeddings-health-tracker";

export interface MemoriesHealthPayload {
  provider: string;
  status: "healthy" | "degraded" | "exhausted";
  degradedReason: string | null;
  fallbackActive: boolean;
  fallbackProvider: string | null;
  errorCountLastHour: number;
  lastErrorAt: string | null;
}

export const memoriesHealthWidget: WidgetModule = {
  id: "memories-health",
  title: "Memories — Embeddings Health",
  updateMode: { type: "polling", intervalMs: 15_000 },
  async fetch(_ctx: WidgetContext): Promise<WidgetData> {
    try {
      const summary = EmbeddingsHealthTracker.getInstance().getSummary();
      const payload: MemoriesHealthPayload = {
        provider: summary.provider,
        status: summary.status,
        degradedReason: summary.degradedReason,
        fallbackActive: summary.fallbackActive,
        fallbackProvider: summary.fallbackProvider,
        errorCountLastHour: summary.errorCountLastHour,
        lastErrorAt: summary.lastErrorAt,
      };
      return { state: "ok", payload };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { state: "degraded", reason: `memories health error: ${message}` };
    }
  },
};
