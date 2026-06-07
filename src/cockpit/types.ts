/**
 * Cockpit widget framework types (mt#1144)
 *
 * These types form the stable widget contract. Adding a new widget:
 * 1. Implement WidgetModule
 * 2. Add import + entry to widget-registry.ts
 *
 * Registering a widget is sufficient — its data endpoint is served whenever it
 * is in WIDGET_REGISTRY. There is no per-widget enable flag (mt#2294).
 */

/** How a widget delivers fresh data to the shell */
export type WidgetUpdateMode = { type: "polling"; intervalMs: number } | { type: "manual" };

/** The result a widget fetch() must return */
export type WidgetData = { state: "ok"; payload: unknown } | { state: "degraded"; reason: string };

/** Runtime context injected into each fetch() call */
export interface WidgetContext {
  id: string;
  query?: Record<string, string>;
}

/** The complete module contract every widget must satisfy */
export interface WidgetModule {
  id: string;
  title: string;
  updateMode: WidgetUpdateMode;
  fetch: (ctx: WidgetContext) => Promise<WidgetData>;
}

/** Metadata shape returned by GET /api/widgets */
export interface WidgetMeta {
  id: string;
  title: string;
  updateMode: WidgetUpdateMode;
}
