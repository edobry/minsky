/**
 * Cockpit widget framework types (mt#1144)
 *
 * These types form the stable widget contract. Adding a new widget:
 * 1. Implement WidgetModule
 * 2. Add import + entry to widget-registry.ts
 * 3. Enable in ~/.config/minsky/cockpit.json
 */

/** How a widget delivers fresh data to the shell */
export type WidgetUpdateMode = { type: "polling"; intervalMs: number } | { type: "manual" };

/** The result a widget fetch() must return */
export type WidgetData = { state: "ok"; payload: unknown } | { state: "degraded"; reason: string };

/** Runtime context injected into each fetch() call */
export interface WidgetContext {
  id: string;
}

/** The complete module contract every widget must satisfy */
export interface WidgetModule {
  id: string;
  title: string;
  updateMode: WidgetUpdateMode;
  fetch: (ctx: WidgetContext) => Promise<WidgetData>;
}

/** One entry in ~/.config/minsky/cockpit.json widgets array */
export interface WidgetConfigEntry {
  id: string;
  enabled: boolean;
}

/** Full cockpit config schema */
export interface CockpitConfig {
  widgets: WidgetConfigEntry[];
}

/** Metadata shape returned by GET /api/widgets */
export interface WidgetMeta {
  id: string;
  title: string;
  updateMode: WidgetUpdateMode;
}
