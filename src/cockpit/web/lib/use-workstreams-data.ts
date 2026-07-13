/**
 * useWorkstreamsData — param-aware TanStack Query hook for the Workstreams
 * widget (mt#2385, Constraint-2 slice/altitude parameterization).
 *
 * The altitude is part of the query key, so two instances at different
 * altitudes cache independently (no collision) — this is the multi-instance
 * mechanism: an instance is (widgetId, params) materialized at the render
 * site. A registry-level `WidgetInstance` abstraction is deliberately
 * deferred until mt#2372's lens engine needs declarative instance lists.
 *
 * The base key stays prefixed ["workstreams", ...] so SSE invalidation
 * (sse-invalidation.ts prefix matching) can invalidate every altitude at once.
 *
 * Altitude names are semantic (full / rollup / actionable), not persona-named —
 * lenses (mt#2372) are user-definable and must not be hardcoded here.
 */
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { fetchWidgetData, type WidgetData } from "./widget-client";

export type WorkstreamAltitude = "full" | "rollup" | "actionable";

export const WORKSTREAM_ALTITUDES: readonly WorkstreamAltitude[] = ["full", "rollup", "actionable"];

/** Unknown / absent values fall back to "full" — mirrors the server's parseAltitude. */
export function parseAltitude(raw: string | null | undefined): WorkstreamAltitude {
  if (raw === "rollup" || raw === "actionable" || raw === "full") return raw;
  return "full";
}

/** Matches the server widget's 30s polling cadence (workstreams.ts updateMode). */
const WORKSTREAMS_REFETCH_MS = 30_000;

export function workstreamsQueryKey(altitude: WorkstreamAltitude): readonly unknown[] {
  return ["workstreams", altitude];
}

export function useWorkstreamsData(
  altitude: WorkstreamAltitude
): UseQueryResult<WidgetData, Error> {
  return useQuery<WidgetData, Error>({
    queryKey: workstreamsQueryKey(altitude),
    queryFn: () => fetchWidgetData("workstreams", altitude === "full" ? undefined : { altitude }),
    staleTime: WORKSTREAMS_REFETCH_MS,
    refetchInterval: WORKSTREAMS_REFETCH_MS,
  });
}
