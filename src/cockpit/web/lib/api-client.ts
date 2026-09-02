/**
 * Default-appending API fetch helper (mt#4730 structural enforcement).
 *
 * Every cockpit frontend fetch to a `/api/...` endpoint should go through
 * `apiFetch` (or `fetchWidgetData` in `widget-client.ts`, built on top of it)
 * rather than a bare `fetch(...)` — this is the frontend half of mt#4730's
 * design space: a default-appending fetch helper with an opt-OUT for
 * deliberately-global fetches, replacing the prior per-call-site opt-IN
 * (`...useProject().queryParam`) that made "forgot to spread queryParam" a
 * silent unscoped-by-default failure mode (mt#4731's own audit found exactly
 * that: 3 of ~35 fetch sites threaded it before this task's sibling closed
 * the gap by hand — a structural default is what stops the NEXT one).
 *
 * ## Default behavior
 *
 * Appends `?project=<selected-slug>` from the persisted selection
 * (`loadPersistedSlug()` in `project-context.tsx` — the SAME source of truth
 * `useProject()` reads, so the two never diverge) UNLESS:
 *
 *   - the caller already set `project` explicitly in `params` — explicit
 *     always wins, so every existing call site that already threads
 *     `useProject().queryParam` verbatim keeps its exact prior behavior; or
 *   - no project is currently selected ("All projects") — nothing to append,
 *     matching the backend's own "omitted -> ALL_PROJECTS" default; or
 *   - `options.global` is `true` — an explicit opt-out for a fetch that must
 *     never be filtered by the shell's current selection even though a
 *     project happens to be selected (e.g. `GET /api/projects` itself, which
 *     must always return every project regardless of the current filter).
 *
 * A surface that ignores `?project=` server-side (see
 * `src/cockpit/scope-census.ts`'s allowlist — the backend counterpart of
 * this file) is unaffected either way: sending an unconsumed query param is
 * harmless, so this default is safe to apply universally rather than
 * per-surface. This is the "inherits scoping by construction" arm of the
 * mt#4730 census — a NEW fetch site gets `?project=` sent automatically with
 * zero code, whether or not the surface it targets currently honors it.
 */
import { loadPersistedSlug } from "./project-context";

export interface ApiFetchOptions {
  /** Opt out of the default `?project=` append for a deliberately-global fetch. */
  global?: boolean;
}

/** Query-string-safe params accepted by {@link apiFetch}. */
export type ApiFetchParams = Record<string, string | number | undefined>;

function resolveParams(
  params: ApiFetchParams | undefined,
  options: ApiFetchOptions | undefined
): ApiFetchParams | undefined {
  if (options?.global) return params;
  if (params && "project" in params && params.project !== undefined) return params;
  const slug = loadPersistedSlug();
  if (!slug) return params;
  return { ...(params ?? {}), project: slug };
}

function buildUrl(path: string, params: ApiFetchParams | undefined): string {
  if (!params) return path;
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) qs.set(key, String(value));
  }
  const str = qs.toString();
  if (!str) return path;
  return `${path}${path.includes("?") ? "&" : "?"}${str}`;
}

/**
 * Fetch a cockpit API endpoint with the current project selection
 * default-appended (see this module's docblock). `path` should already
 * include any path params (e.g. `/api/tasks/${id}`); `params` become the
 * query string.
 *
 * `init` is forwarded verbatim to the underlying `fetch()` — pass `method`,
 * `body`, `headers`, etc. for a mutation (`POST`/`DELETE`/...). Without this,
 * `apiFetch` could only ever issue a bare GET, which would have limited
 * adoption to read-only call sites and left every mutating fetch on the raw
 * `fetch()` path this module exists to replace.
 */
export async function apiFetch(
  path: string,
  params?: ApiFetchParams,
  options?: ApiFetchOptions,
  init?: RequestInit
): Promise<Response> {
  return fetch(buildUrl(path, resolveParams(params, options)), init);
}

/** Convenience wrapper: fetch + parse JSON, throwing on a non-ok response. */
export async function apiFetchJson<T>(
  path: string,
  params?: ApiFetchParams,
  options?: ApiFetchOptions,
  init?: RequestInit
): Promise<T> {
  const res = await apiFetch(path, params, options, init);
  if (!res.ok) {
    throw new Error(`${path} failed: ${res.status}`);
  }
  return (await res.json()) as T;
}
