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

/**
 * Unscoped (all-projects) variant of {@link useOpenAskCount} (mt#4794).
 *
 * Backs the cross-project needs-me leak indicator: when a specific project
 * filter is active, the scoped Attention count alone can read "clear" while
 * other projects carry pending asks — a self-imposed blind spot (mt#4757
 * audit). Consumers compare this against the scoped count via
 * `lib/attention-leak.ts`'s `elsewhereCount` and render a muted "elsewhere"
 * secondary when they differ.
 *
 * Pass `{ enabled: false }` while no project filter is active — "elsewhere"
 * is meaningless in the All-projects view, so there is nothing worth
 * fetching (and nothing to compare against) in that state.
 *
 * `{ global: true }` opts `fetchWidgetData`'s default `?project=` append
 * (mt#4730) back out — this is the one deliberately cross-project attention
 * read the spec calls for; every other consumer of the attention widget
 * stays scoped. Distinct TanStack key from `useOpenAskCount`'s own so the
 * scoped query is untouched and both cache entries coexist — no new
 * endpoint, one additional query.
 */
export function useUnscopedOpenAskCount(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ["plant-board", "open-ask-count", "unscoped"],
    queryFn: fetchOpenAskCountUnscoped,
    staleTime: 5_000,
    refetchInterval: 10_000,
    enabled: options?.enabled,
  });
}

async function fetchOpenAskCountUnscoped(): Promise<number> {
  const data = await fetchWidgetData("attention", undefined, { global: true });
  if (data.state !== "ok") {
    throw new Error(`attention widget: ${data.reason}`);
  }
  const payload = data.payload as AttentionPayload;
  return payload.totalPending;
}
