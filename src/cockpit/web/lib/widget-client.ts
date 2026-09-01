import { apiFetch, type ApiFetchOptions, type ApiFetchParams } from "./api-client";

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

/**
 * Fetch a single widget's data. As of mt#4730, `?project=<selected-slug>` is
 * default-appended by {@link apiFetch} — a caller no longer needs to spread
 * `useProject().queryParam` in for the widget to receive the current
 * selection (a widget the backend hasn't scoped yet simply ignores the
 * param; see `src/cockpit/scope-census.ts`). Callers that already pass
 * `project` explicitly are unaffected (explicit wins); pass
 * `{ global: true }` to opt a deliberately-global fetch out entirely.
 */
export async function fetchWidgetData(
  id: string,
  params?: ApiFetchParams,
  options?: ApiFetchOptions
): Promise<WidgetData> {
  if (!WIDGET_ID_PATTERN.test(id)) {
    throw new Error(
      `fetchWidgetData id "${id}" must be a bare kebab-case widget id — pass query params via the second argument`
    );
  }
  const res = await apiFetch(`/api/widget/${id}/data`, params, options);
  return res.json() as Promise<WidgetData>;
}
