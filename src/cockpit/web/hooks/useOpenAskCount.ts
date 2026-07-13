/**
 * useOpenAskCount — shared hook for the plant board's live open-ask count.
 *
 * Mirrors useReadyCount.ts. Backs the attention-seam "ask pending" pulse/badge
 * AND the S5 "YOU" badge pulse (mt#2590) — the two canon-allowed ambient cues
 * per memory 8d3d4f06 are tank breath and a REAL pending ask; before this hook
 * both pulses ran unconditionally regardless of whether any ask was open.
 *
 * Data source: GET /api/widget/attention/data (`totalPending` field) — the
 * same cohort query used by the Attention overview-grid digest widget.
 *
 * Query key: ["plant-board", "open-ask-count"]
 * staleTime: 5s, refetchInterval: 10s (matches the attention widget's own
 * polling interval so the plant board never shows staler data than the
 * digest widget it borrows from).
 */
import { useQuery } from "@tanstack/react-query";
import { fetchWidgetData } from "../lib/widget-client";

interface AttentionPayload {
  totalPending: number;
}

async function fetchOpenAskCount(): Promise<number> {
  const data = await fetchWidgetData("attention");
  if (data.state !== "ok") {
    throw new Error(`attention widget: ${data.reason}`);
  }
  const payload = data.payload as AttentionPayload;
  return payload.totalPending;
}

export function useOpenAskCount() {
  return useQuery({
    queryKey: ["plant-board", "open-ask-count"],
    queryFn: fetchOpenAskCount,
    staleTime: 5_000,
    refetchInterval: 10_000,
  });
}
