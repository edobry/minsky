/**
 * Frontend structural-enforcement census backstop (mt#4730).
 *
 * See `scope-census.ts`'s docblock for the full design. This is the actual
 * enforcement: it fails when a live source file makes a raw `fetch()` call
 * to a literal `/api/...` path with no evidence a scoping decision was made
 * and no allowlist entry.
 */
import { describe, test, expect } from "bun:test";
import {
  FRONTEND_SCOPE_ALLOWLIST,
  fileSourceConsumesScope,
  isScopeDecided,
  listRawApiFetchFiles,
} from "./scope-census";

describe("cockpit frontend scope census (mt#4730)", () => {
  test("every raw /api/ fetch site is scope-consuming or on the allowlist", () => {
    const allowlistPaths = new Set(FRONTEND_SCOPE_ALLOWLIST.map((e) => e.path));
    const undecided = listRawApiFetchFiles().filter(
      (path) => !allowlistPaths.has(path) && !fileSourceConsumesScope(path)
    );
    expect(undecided).toEqual([]);
  });

  test("every allowlist entry names a real, currently-live fetch site with a non-empty reason", () => {
    const livePaths = new Set(listRawApiFetchFiles());
    for (const entry of FRONTEND_SCOPE_ALLOWLIST) {
      expect(livePaths.has(entry.path)).toBe(true);
      expect(entry.reason.trim().length).toBeGreaterThan(0);
    }
  });

  test("no allowlist entry is stale (duplicated paths, or a path that now consumes scope)", () => {
    const seen = new Set<string>();
    for (const entry of FRONTEND_SCOPE_ALLOWLIST) {
      expect(seen.has(entry.path)).toBe(false);
      seen.add(entry.path);
      if (entry.path === "lib/project-context.tsx") {
        // Exempt by name, not by pattern refinement: this file DEFINES
        // `useProject()` and `apiFetch`'s source of truth (`loadPersistedSlug`)
        // — its own text necessarily contains `useProject(` (the export
        // signature itself). That is evidence of the MECHANISM's own
        // definition site, not evidence this file made a scoping decision
        // about its own GET /api/projects fetch, so it is not the staleness
        // this test looks for.
        continue;
      }
      expect(fileSourceConsumesScope(entry.path)).toBe(false);
    }
  });

  // AT1 (mt#4730 spec): "Adding a toy unscoped route/widget in a test
  // fixture trips the census check" — the frontend analogue, exercised
  // directly against the pure classification function.
  const TOY_PATH = "lib/toy-stuff.ts";

  test("AT1 — a toy unscoped fetch site fails the census's decision function", () => {
    const toySource = `
      export async function fetchToyStuff() {
        const res = await fetch("/api/toy-stuff");
        return res.json();
      }
    `;
    expect(isScopeDecided(toySource, TOY_PATH, FRONTEND_SCOPE_ALLOWLIST)).toBe(false);
  });

  test("AT1 corollary — the same toy source is accepted once it imports apiFetch", () => {
    const scopedToySource = `
      import { apiFetch } from "./api-client";
      export async function fetchToyStuff() {
        const res = await apiFetch("/api/toy-stuff");
        return res.json();
      }
    `;
    expect(isScopeDecided(scopedToySource, TOY_PATH, FRONTEND_SCOPE_ALLOWLIST)).toBe(true);
  });

  test("AT1 corollary — a toy source is accepted once its path is allowlisted, even with no scope evidence", () => {
    const toySource = `fetch("/api/toy-stuff")`;
    const allowlist = [{ path: TOY_PATH, reason: "test fixture: deliberately global" }];
    expect(isScopeDecided(toySource, TOY_PATH, allowlist)).toBe(true);
  });
});
