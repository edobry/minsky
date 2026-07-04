/**
 * Slow topology widget (mt#2602)
 *
 * Feeds the plant board's S2 valve-inventory count badge and the weld-history
 * drill-down page. Unlike most widgets, this one does NO work in `fetch()` —
 * it only reads the in-process cache maintained by `startTopologySweeper`
 * (server.ts), which recomputes at cockpit boot and on an hourly-class
 * cadence via `topology-cache.ts`. A per-request derivation (directory walk +
 * git subprocess + DB query) would violate the "never per-request" cadence
 * constraint from mt#2602.
 *
 * `status: "pending"` covers the narrow window between cockpit boot and the
 * sweeper's first tick completing — an honest "not yet computed" rather than
 * a fabricated zero count.
 */
import type { WidgetModule, WidgetContext, WidgetData } from "../types";
import { getCachedTopology } from "../topology-cache";
import type { WeldEntry } from "../topology-derivation";

// ---------------------------------------------------------------------------
// Payload shape — mirrored by useSlowTopology.ts on the frontend.
// ---------------------------------------------------------------------------

export interface SlowTopologyPayload {
  /** "pending" before the first sweeper tick has completed; "ready" thereafter. */
  status: "pending" | "ready";
  /** ISO-8601 timestamp of the last successful derivation, or null while pending. */
  computedAt: string | null;
  /** Count of derived interlocks (guard hooks) — the S2 valve badge's number. */
  interlockCount: number;
  /** Full inventory, for the weld-history drill-down. */
  entries: WeldEntry[];
}

export const slowTopologyWidget: WidgetModule = {
  id: "slow-topology",
  title: "Slow Topology",
  // The underlying data changes on an hourly cadence (server-side sweep); a
  // 5-minute frontend poll is cheap (cache read only) and keeps a
  // freshly-opened board from showing a stale "pending" state for long.
  updateMode: { type: "polling", intervalMs: 5 * 60_000 },
  async fetch(_ctx: WidgetContext): Promise<WidgetData> {
    try {
      const snapshot = getCachedTopology();
      const payload: SlowTopologyPayload = snapshot
        ? {
            status: "ready",
            computedAt: snapshot.computedAt,
            interlockCount: snapshot.entries.length,
            entries: snapshot.entries,
          }
        : { status: "pending", computedAt: null, interlockCount: 0, entries: [] };
      return { state: "ok", payload };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { state: "degraded", reason: `slow-topology error: ${message}` };
    }
  },
};
