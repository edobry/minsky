/**
 * Interceptor-aggregates widget (mt#4009, mt#3754 phase 3).
 *
 * The query surface the `/interceptors` route's slice 2 (mt#4057) reads:
 * per-guard fire counts by decision, duration/cost aggregates, override
 * usage, last-fire time, canary-backed health, and calibration state, over
 * the fire-log-derived population.
 *
 * Two paths:
 *  - CATALOG (no query param): reads ONLY the in-process snapshot maintained
 *    by `startInterceptorAggregatesSweeper` — never queries per request. The
 *    catalog-wide rollup measured 2.73s cold against the live corpus
 *    (mt#4009 `## Plan`), which is why this path is cache-only, mirroring
 *    `slow-topology`'s "never per-request" posture, with the same honest
 *    `pending` state before the first refresh completes.
 *  - DETAIL (`?guard=<name>`): live single-guard window aggregates —
 *    index-served (measured 18.6ms) — plus a live canary read; health /
 *    calibration / registry sections come from the snapshot at its own
 *    cadence.
 *
 * @see src/cockpit/interceptor-aggregates-cache.ts — producer + detail reads
 * @see src/cockpit/widgets/interceptors.ts — the STATIC half (mt#4010 slice 1); mt#4057 composes both
 */
import type { WidgetModule, WidgetContext, WidgetData } from "../types";
import { describeWidgetDegradedReason } from "../db-providers";
import { fetchGuardDetail, getCachedInterceptorAggregates } from "../interceptor-aggregates-cache";
import type { InterceptorAggregatesSnapshot } from "@minsky/domain/guard-events/aggregates";

// ---------------------------------------------------------------------------
// Payload shapes — mirrored by the slice-2 frontend consumer (mt#4057).
// ---------------------------------------------------------------------------

export interface InterceptorAggregatesCatalogPayload {
  /** "pending" before the first sweeper tick has completed; "ready" thereafter. */
  status: "pending" | "ready";
  snapshot: InterceptorAggregatesSnapshot | null;
}

export const interceptorAggregatesWidget: WidgetModule = {
  id: "interceptor-aggregates",
  title: "Interceptor Aggregates",
  // The snapshot changes on the sweeper's 5-minute cadence (matched to the
  // guard-events ingest sweep, since the data only moves when ingest runs); a
  // 1-minute frontend poll is cheap (cache read only) and keeps a freshly
  // opened catalog from showing a stale "pending" for long.
  updateMode: { type: "polling", intervalMs: 60_000 },
  async fetch(ctx: WidgetContext): Promise<WidgetData> {
    try {
      const guardName = ctx.query?.guard;
      if (guardName) {
        const detail = await fetchGuardDetail(guardName);
        return { state: "ok", payload: detail };
      }
      const snapshot = getCachedInterceptorAggregates();
      const payload: InterceptorAggregatesCatalogPayload = snapshot
        ? { status: "ready", snapshot }
        : { status: "pending", snapshot: null };
      return { state: "ok", payload };
    } catch (err) {
      return {
        state: "degraded",
        reason: describeWidgetDegradedReason("interceptor-aggregates", err),
      };
    }
  },
};
