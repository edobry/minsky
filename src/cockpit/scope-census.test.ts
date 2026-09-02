/**
 * Structural-enforcement census backstop (mt#4730).
 *
 * See `scope-census.ts`'s docblock for the full design. This file is the
 * actual enforcement: it fails when a live route module or registered widget
 * is neither scope-consuming (source evidence) nor on the allowlist with a
 * reason.
 */
import { describe, test, expect } from "bun:test";
import {
  ROUTE_ALLOWLIST,
  WIDGET_ALLOWLIST,
  isScopeDecided,
  listRouteModules,
  listWidgetIds,
  routeSourceConsumesScope,
  widgetSourceConsumesScope,
} from "./scope-census";

describe("cockpit scope census (mt#4730)", () => {
  test("every registered widget is scope-consuming or on the allowlist", () => {
    const allowlistIds = new Set(WIDGET_ALLOWLIST.map((e) => e.id));
    const undecided = listWidgetIds().filter(
      (id) => !allowlistIds.has(id) && !widgetSourceConsumesScope(id)
    );
    expect(undecided).toEqual([]);
  });

  test("every widget allowlist entry names a real, currently-registered widget with a non-empty reason", () => {
    const liveIds = new Set(listWidgetIds());
    for (const entry of WIDGET_ALLOWLIST) {
      expect(liveIds.has(entry.id)).toBe(true);
      expect(entry.reason.trim().length).toBeGreaterThan(0);
    }
  });

  test("no widget allowlist entry is stale (duplicated ids, or an id that now consumes scope)", () => {
    const seen = new Set<string>();
    for (const entry of WIDGET_ALLOWLIST) {
      expect(seen.has(entry.id)).toBe(false);
      seen.add(entry.id);
      // If the widget's source has since gained real scope-consuming evidence
      // (someone did the threading work for a "deferred:" entry and forgot to
      // remove it from the allowlist), that's exactly the staleness this test
      // name promises to catch.
      expect(widgetSourceConsumesScope(entry.id)).toBe(false);
    }
  });

  test("every route module is scope-consuming or on the allowlist", () => {
    const allowlistIds = new Set(ROUTE_ALLOWLIST.map((e) => e.id));
    const undecided = listRouteModules().filter(
      (id) => !allowlistIds.has(id) && !routeSourceConsumesScope(id)
    );
    expect(undecided).toEqual([]);
  });

  test("every route allowlist entry names a real, currently-live route module with a non-empty reason", () => {
    const liveModules = new Set(listRouteModules());
    for (const entry of ROUTE_ALLOWLIST) {
      expect(liveModules.has(entry.id)).toBe(true);
      expect(entry.reason.trim().length).toBeGreaterThan(0);
    }
  });

  test("no route allowlist entry is stale (duplicated ids, or an id that now consumes scope)", () => {
    const seen = new Set<string>();
    for (const entry of ROUTE_ALLOWLIST) {
      expect(seen.has(entry.id)).toBe(false);
      seen.add(entry.id);
      if (entry.id === "health") {
        // Exempt by name, not by pattern refinement: health.ts is the
        // widget DISPATCHER — it structurally contains `req.projectScope`
        // because it FORWARDS the value onto every other widget's context
        // (see routes/health.ts). That is evidence of the MECHANISM's own
        // wiring, not evidence health.ts made a scoping decision about its
        // own response, so it is not the staleness this test looks for.
        continue;
      }
      expect(routeSourceConsumesScope(entry.id)).toBe(false);
    }
  });

  // AT1 (mt#4730 spec): "Adding a toy unscoped route/widget in a test fixture
  // trips the census check." Rather than writing a real file to disk, this
  // exercises the pure classification function directly with a synthetic
  // source string that shows no scope evidence and an id that is on neither
  // allowlist.
  test("AT1 — a toy unscoped widget/route source fails the census's decision function", () => {
    const toySource = `
      export const toyWidget: WidgetModule = {
        id: "toy-widget",
        title: "Toy",
        updateMode: { type: "manual" },
        async fetch(ctx) {
          return { state: "ok", payload: await listEverythingUnscoped() };
        },
      };
    `;
    expect(isScopeDecided(toySource, "toy-widget", WIDGET_ALLOWLIST)).toBe(false);
    expect(isScopeDecided(toySource, "toy-route", ROUTE_ALLOWLIST)).toBe(false);
  });

  test("AT1 corollary — the same toy source is accepted once it reads ctx.projectScope", () => {
    const scopedToySource = `
      export const toyWidget: WidgetModule = {
        id: "toy-widget",
        title: "Toy",
        updateMode: { type: "manual" },
        async fetch(ctx) {
          const projectScope = ctx.projectScope ?? ALL_PROJECTS;
          return { state: "ok", payload: await listScoped(projectScope) };
        },
      };
    `;
    expect(isScopeDecided(scopedToySource, "toy-widget", WIDGET_ALLOWLIST)).toBe(true);
  });

  test("AT1 corollary — a toy source is accepted once its id is allowlisted, even with no scope evidence", () => {
    const toySource = `export const toyWidget = { id: "toy-widget" };`;
    const allowlist = [{ id: "toy-widget", reason: "test fixture: deliberately global" }];
    expect(isScopeDecided(toySource, "toy-widget", allowlist)).toBe(true);
  });
});
