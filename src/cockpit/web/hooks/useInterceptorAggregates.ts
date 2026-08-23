/**
 * useInterceptorAggregates / useInterceptorDetail — the health-and-cost half of
 * the `/interceptors` route (mt#4057 slice 2).
 *
 * Data source: GET /api/widget/interceptor-aggregates/data — see
 * `src/cockpit/widgets/interceptor-aggregates.ts` for the two paths behind it.
 * This is a SECOND fetch alongside `useInterceptors`, deliberately: the static
 * catalog is a build-time artifact that only changes when the repo does, while
 * this moves on the sweeper's cadence. Joining them server-side would drag the
 * static half onto the live clock for nothing.
 *
 * THE PAGES DO NOT RECOMPUTE ANY FIGURE HERE. Every state and count comes from
 * `@minsky/domain/guard-events/interceptor-state`, which the server-side
 * verification script exercises against the same snapshot — one definition per
 * figure (mt#3754 SC6).
 *
 * Query keys: ["interceptors", "aggregates"] / ["interceptors", "detail", name]
 */
import { useQuery } from "@tanstack/react-query";
import { fetchWidgetData } from "../lib/widget-client";
import type {
  InterceptorAggregateRow,
  InterceptorAggregatesSnapshot,
} from "@minsky/domain/guard-events/aggregates";
import { allAggregateRows } from "@minsky/domain/guard-events/interceptor-state";

/** Mirrors `InterceptorAggregatesCatalogPayload` in the widget. */
export interface InterceptorAggregatesCatalogPayload {
  status: "pending" | "ready";
  snapshot: InterceptorAggregatesSnapshot | null;
}

/** Mirrors `InterceptorDetailResult` in `interceptor-aggregates-cache.ts`. */
export interface InterceptorDetailPayload {
  guardName: string;
  windowDays: number;
  row: InterceptorAggregateRow | null;
  /** True when the name is unknown to the fire log entirely — a finding, not an empty row. */
  unknownToFireLog: boolean;
  snapshotComputedAt: string | null;
}

async function fetchAggregates(): Promise<InterceptorAggregatesCatalogPayload> {
  const data = await fetchWidgetData("interceptor-aggregates");
  if (data.state !== "ok") {
    throw new Error(`interceptor-aggregates widget: ${data.reason}`);
  }
  return data.payload as InterceptorAggregatesCatalogPayload;
}

async function fetchDetail(guardName: string): Promise<InterceptorDetailPayload> {
  const data = await fetchWidgetData("interceptor-aggregates", { guard: guardName });
  if (data.state !== "ok") {
    throw new Error(`interceptor-aggregates widget: ${data.reason}`);
  }
  return data.payload as InterceptorDetailPayload;
}

/**
 * The catalog snapshot.
 *
 * The server serves this from an off-request cache the sweeper refreshes every
 * 5 minutes, so a 1-minute poll costs a cache read; it exists so a catalog
 * opened before the first tick stops saying "pending" on its own.
 */
export function useInterceptorAggregates() {
  return useQuery({
    queryKey: ["interceptors", "aggregates"],
    queryFn: fetchAggregates,
    staleTime: 60_000,
    refetchInterval: 60_000,
  });
}

export function useInterceptorDetail(guardName: string | undefined) {
  return useQuery({
    queryKey: ["interceptors", "detail", guardName],
    queryFn: () => fetchDetail(guardName as string),
    enabled: Boolean(guardName),
    staleTime: 60_000,
  });
}

/**
 * Index a ready snapshot by guard name.
 *
 * Returns null while pending or on a failed fetch so a caller cannot mistake
 * "no data yet" for "this guard has no row" — the two render differently.
 */
export function indexSnapshotRows(
  payload: InterceptorAggregatesCatalogPayload | undefined
): Map<string, InterceptorAggregateRow> | null {
  if (!payload || payload.status !== "ready" || !payload.snapshot) return null;
  // Both populations, since a declared name that has never fired still has a
  // canary verdict and still belongs in the health column (mt#4057).
  return new Map(allAggregateRows(payload.snapshot).map((r) => [r.guardName, r]));
}

/** Human-facing figure formatting — ms under a second, seconds above it. */
export function formatMs(ms: number): string {
  if (ms < 1) return `${ms.toFixed(2)}ms`;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
}
