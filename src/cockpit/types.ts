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

/**
 * Convention: distinguishing query-layer failure from genuine no-data
 * (mt#2758).
 *
 * `WidgetData`'s `ok | degraded` split is all-or-nothing per widget — it
 * tells you the WHOLE widget is degraded, not that one of several
 * independent data sources inside an `ok` payload silently failed. A widget
 * that reads from several sources (multiple DB queries, several HTTP probes)
 * and degrades EACH source independently (catch → empty default, so one bad
 * source doesn't take down the others) creates a structural blind spot: a
 * source that fails and one that legitimately returns nothing both resolve
 * to the same empty value (0 / null / []), so "the query layer is broken"
 * and "there's genuinely no data yet" render identically. This is exactly
 * what happened to the reviewer-bot-status widget (mt#2076/mt#2757): every
 * DB query threw for ~5 weeks while the UI showed healthy-looking zeros.
 *
 * A widget with this shape should add ADDITIVE OPTIONAL fields to its own
 * `payload` (defined in the widget's own module — `payload` is `unknown` at
 * this shared-type level, so there is no framework change required) that
 * signal per-fetch-cycle failure counts alongside the real data. The
 * reference implementation (`src/cockpit/widgets/reviewer-bot-status.ts`,
 * consumed by `src/cockpit/web/widgets/ReviewerBotStatus.tsx`) uses a
 * `{ queryFailureCount, queryTotalCount }` pair on its `db` sub-object:
 *
 * - `queryFailureCount` — how many of the source's independent queries/probes
 *   failed to run for real (threw/rejected/had no live connection) during
 *   THIS fetch cycle, as opposed to running and returning an empty result.
 * - `queryTotalCount` — the denominator, so a consumer can compute a ratio
 *   (partial vs. total failure) without hardcoding the source count.
 *
 * Threading rule: compute the counter as LOCAL state inside the fetch
 * function that owns the fan-out (not module-level) — a widget that
 * single-flights concurrent `fetch()` calls (a common pattern once a widget
 * has enough query volume to need bounded concurrency) would otherwise leak
 * or double-count state across polling cycles. A `degradedFields: string[]`
 * naming the specific affected output fields is an equally valid shape when
 * per-field granularity is more useful than a count — pick whichever needs
 * the least new plumbing for the widget's existing catch/fallback structure.
 *
 * Frontend rendering: render a visible degraded indicator (a banner, badge,
 * etc.) when the failure count is nonzero — do not let it silently fall back
 * to the same empty-state rendering as "no data." See
 * `docs/architecture/cockpit.md` "Query-layer-failure vs no-data convention"
 * for the full writeup and `ReviewerBotStatus.tsx`'s `AnomalyBanner` usage
 * for the reference rendering (destructive token for total failure, per
 * `src/cockpit/CLAUDE.md`'s error-state convention; amber warning variant
 * for partial failure).
 */

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
