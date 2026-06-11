export interface WidgetMeta {
  id: string;
  title: string;
  updateMode: { type: "polling"; intervalMs: number } | { type: "manual" };
}

export type WidgetData = { state: "ok"; payload: unknown } | { state: "degraded"; reason: string };

export async function fetchWidgets(): Promise<WidgetMeta[]> {
  const res = await fetch("/api/widgets");
  return res.json() as Promise<WidgetMeta[]>;
}

export async function fetchWidgetData(
  id: string,
  params?: Record<string, string | number>
): Promise<WidgetData> {
  // An id with an embedded query string composes /api/widget/<id>?<qs>/data —
  // the "?" ends the URL path before "/data", the request misses the widget
  // route entirely, and the SPA fallback returns index.html. Three memories
  // widgets shipped this way and rendered permanent "Loading…" (mt#2443).
  if (id.includes("?")) {
    throw new Error(
      `fetchWidgetData id "${id}" must not embed a query string — pass params via the second argument`
    );
  }
  let url = `/api/widget/${id}/data`;
  if (params) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      qs.set(k, String(v));
    }
    const str = qs.toString();
    if (str) url += `?${str}`;
  }
  const res = await fetch(url);
  return res.json() as Promise<WidgetData>;
}
