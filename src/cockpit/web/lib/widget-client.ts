export interface WidgetMeta {
  id: string;
  title: string;
  updateMode: { type: "polling"; intervalMs: number } | { type: "manual" };
}

export type WidgetData = { state: "ok"; payload: unknown } | { state: "degraded"; reason: string };

/**
 * Widget ids are registry-defined kebab-case slugs (e.g. "memories-list",
 * "context-inspector"). Anything outside this charset would alter the
 * composed path or URL semantics ("?" ends the path — three memories widgets
 * shipped that way and rendered permanent "Loading…", mt#2443; "/", "#", "%"
 * and ".." are path-breaking the same way).
 */
const WIDGET_ID_PATTERN = /^[a-z0-9-]+$/i;

export async function fetchWidgets(): Promise<WidgetMeta[]> {
  const res = await fetch("/api/widgets");
  return res.json() as Promise<WidgetMeta[]>;
}

export async function fetchWidgetData(
  id: string,
  params?: Record<string, string | number>
): Promise<WidgetData> {
  if (!WIDGET_ID_PATTERN.test(id)) {
    throw new Error(
      `fetchWidgetData id "${id}" must be a bare kebab-case widget id — pass query params via the second argument`
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
