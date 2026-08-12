/**
 * Guard-health cockpit widget (mt#2812).
 *
 * Minimal operator-facing surface for guard-layer failure escalation —
 * mirrors the embeddings-health widget's pattern exactly (a Tracker
 * singleton's getSummary(), wrapped in a try/catch that degrades to
 * `{ state: "degraded" }` on any error). Per the task's "keep it minimal"
 * instruction: no new widget architecture, no new route — this is the same
 * registry-gated WidgetModule shape every other widget uses (mt#2294: no
 * per-widget enable flag, the data endpoint is served automatically once
 * registered in widget-registry.ts).
 */
import type { WidgetModule, WidgetContext, WidgetData } from "../types";
import { GuardHealthTracker } from "../../mcp/guard-health-tracker";
import { describeWidgetDegradedReason } from "../db-providers";

export const guardHealthWidget: WidgetModule = {
  id: "guard-health",
  title: "Guard Health",
  updateMode: { type: "polling", intervalMs: 15_000 },
  async fetch(_ctx: WidgetContext): Promise<WidgetData> {
    try {
      const payload = GuardHealthTracker.getInstance().getSummary();
      return { state: "ok", payload };
    } catch (err) {
      return { state: "degraded", reason: describeWidgetDegradedReason("guard health", err) };
    }
  },
};
