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
 * Query key: ["plant-board", "open-ask-count", selectedSlug] (mt#4731 —
 * selectedSlug in the key so switching projects invalidates and refetches).
 * staleTime: 5s, refetchInterval: 10s (matches the attention widget's own
 * polling interval so the plant board never shows staler data than the
 * digest widget it borrows from).
 */
import { useQuery } from "@tanstack/react-query";
import { fetchWidgetData } from "../lib/widget-client";
import { useProject } from "../lib/project-context";

interface AttentionPayload {
  totalPending: number;
}

async function fetchOpenAskCount(queryParam?: { project: string }): Promise<number> {
  const data = await fetchWidgetData("attention", queryParam);
  if (data.state !== "ok") {
    throw new Error(`attention widget: ${data.reason}`);
  }
  const payload = data.payload as AttentionPayload;
  return payload.totalPending;
}

export function useOpenAskCount() {
  const { selectedSlug, queryParam } = useProject();
  return useQuery({
    queryKey: ["plant-board", "open-ask-count", selectedSlug],
    queryFn: () => fetchOpenAskCount(queryParam),
    staleTime: 5_000,
    refetchInterval: 10_000,
  });
}
