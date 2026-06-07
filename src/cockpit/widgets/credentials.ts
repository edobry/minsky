/**
 * Credentials widget (mt#1426)
 *
 * Displays the credential lifecycle surface for the operator: list all known
 * providers, add / remove credentials, and run on-demand validation.
 *
 * Architecture note: The spec originally described this as a "/credentials route."
 * Cockpit v0 has no client-side router; adding one is out of scope for this slice
 * (mt#1426). The widget-path is taken instead: the credentials surface lives as
 * a self-fetching widget on the cockpit home grid, consistent with the existing
 * architecture. A route-based implementation can be added when Cockpit adopts a
 * router (likely alongside the TanStack Router work in a future mt#1773 follow-up).
 *
 * The widget itself is a "manual" update-mode widget: data is loaded and mutated
 * entirely by the frontend React component via TanStack Query. The server-side
 * WidgetModule here is a minimal metadata-only stub that satisfies the widget
 * registry contract; it does NOT have a meaningful `fetch()` path because the
 * credential data surfaces through the dedicated `/api/credentials` endpoints
 * rather than the generic `/api/widget/:id/data` pipeline.
 */
import type { WidgetModule, WidgetContext, WidgetData } from "../types";

export const credentialsWidget: WidgetModule = {
  id: "credentials",
  title: "Credentials",
  updateMode: { type: "manual" },
  async fetch(_ctx: WidgetContext): Promise<WidgetData> {
    // The credentials widget does not use the generic widget data pipeline.
    // All data is fetched by the frontend React component via the dedicated
    // /api/credentials endpoints. This stub satisfies the WidgetModule contract
    // so the widget can be registered in widget-registry.ts.
    return { state: "ok", payload: {} };
  },
};
