/**
 * Basic health widget (mt#1144)
 *
 * Proves the polling/render/degrade loop end-to-end.
 * Returns uptime, version, and loaded widget count.
 */
import type { WidgetModule, WidgetContext, WidgetData } from "../types";

// Read package.json version once at startup
let pkgVersion = "unknown";
try {
  const pkg = await import("../../../package.json", { with: { type: "json" } });
  pkgVersion = (pkg as { default?: { version?: string } }).default?.version ?? "unknown";
} catch {
  // fallback if import fails
}

/** Call this after createCockpitServer to inject the loaded widget count */
let loadedWidgetCount = 0;
export function setLoadedWidgetCount(count: number): void {
  loadedWidgetCount = count;
}

const startTime = Date.now();

export const basicHealthWidget: WidgetModule = {
  id: "basic-health",
  title: "System Health",
  updateMode: { type: "polling", intervalMs: 5000 },
  async fetch(_ctx: WidgetContext): Promise<WidgetData> {
    const uptimeSec = Math.floor((Date.now() - startTime) / 1000);
    return {
      state: "ok",
      payload: {
        uptimeSec,
        version: pkgVersion,
        loadedWidgetCount,
      },
    };
  },
};
