/**
 * Attention stub widget (mt#1144)
 *
 * Placeholder for the Attention subsystem (mt#1034 / Asks subsystem).
 * Returns degraded state until the real Attention widget lands.
 */
import type { WidgetModule, WidgetContext, WidgetData } from "../types";

export const attentionStubWidget: WidgetModule = {
  id: "attention-stub",
  title: "Attention (pending mt#1034)",
  updateMode: { type: "manual" },
  async fetch(_ctx: WidgetContext): Promise<WidgetData> {
    return {
      state: "degraded",
      reason: "Pending mt#1034 (Asks subsystem)",
    };
  },
};
