/**
 * MemoriesPage tests (mt#4763).
 *
 * Covers the pure URL-state helpers directly (cheap, precise) and the
 * cohort-switcher / facet-rail / families-view wiring via a full render
 * (the parts that only exist as DOM behavior — one-click cohort navigation,
 * the cross-component popstate sync between the facet rail and
 * `MemoriesList`'s own `useListControls` instance).
 *
 * Run via: bun run test:components
 */
import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { render, cleanup, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  MemoriesPage,
  buildFacetsParams,
  readMemFilter,
  readView,
  readExcludeSuperseded,
  parseTagList,
  COHORT_DEFS,
} from "./MemoriesPage";
import { ProjectProvider } from "../lib/project-context";
import { stubProjectsRoute } from "../lib/test-support/projects";

const originalFetch = global.fetch;

function setDocumentUrl(url: string) {
  (window as unknown as { happyDOM: { setURL: (u: string) => void } }).happyDOM.setURL(url);
}

let originalHref = "about:blank";

beforeEach(() => {
  originalHref = window.location.href;
  setDocumentUrl("http://localhost/memories");
});

afterEach(() => {
  cleanup();
  global.fetch = originalFetch;
  setDocumentUrl(originalHref);
});

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as Response;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("MemoriesPage — pure URL-state helpers (mt#4763)", () => {
  test("readMemFilter reads the mem_f_<key> param, empty string when absent", () => {
    expect(readMemFilter("?mem_f_tags=handoff", "tags")).toBe("handoff");
    expect(readMemFilter("", "tags")).toBe("");
  });

  test("readView reads mem_view, empty string when absent", () => {
    expect(readView("?mem_view=families")).toBe("families");
    expect(readView("")).toBe("");
  });

  test("readExcludeSuperseded defaults to true when the param is absent (matches MemoriesList's own default)", () => {
    expect(readExcludeSuperseded("")).toBe("true");
    expect(readExcludeSuperseded("?mem_f_excludeSuperseded=false")).toBe("false");
    expect(readExcludeSuperseded("?mem_f_excludeSuperseded=true")).toBe("true");
  });

  test("parseTagList splits a comma-joined string and drops blanks", () => {
    expect(parseTagList("handoff,cockpit")).toEqual(["handoff", "cockpit"]);
    expect(parseTagList("")).toEqual([]);
    expect(parseTagList("handoff, cockpit ,")).toEqual(["handoff", "cockpit"]);
  });

  test("buildFacetsParams forwards type/scope/excludeSuperseded/project — AT3's conditioning", () => {
    expect(buildFacetsParams("", undefined)).toEqual({ excludeSuperseded: "true" });
    expect(buildFacetsParams("?mem_f_type=project", undefined)).toEqual({
      type: "project",
      excludeSuperseded: "true",
    });
    expect(buildFacetsParams("?mem_f_type=project", { project: "minsky" })).toEqual({
      type: "project",
      excludeSuperseded: "true",
      project: "minsky",
    });
  });
});

describe("MemoriesPage — cohort active-state derivation (mt#4763)", () => {
  function activeCohort(search: string): string | undefined {
    return COHORT_DEFS.find((c) => c.isActive(search))?.id;
  }

  test("cold /memories (no params) is the All cohort", () => {
    expect(activeCohort("")).toBe("all");
  });

  test("mem_f_tags=handoff is the Handoffs cohort", () => {
    expect(activeCohort("?mem_f_tags=handoff")).toBe("handoffs");
  });

  test("mem_view=families is the Families cohort regardless of other filters", () => {
    expect(activeCohort("?mem_view=families&mem_f_tags=handoff")).toBe("families");
  });

  // mt#4767 renamed this cohort from "stale" to "cold" and repointed it at the
  // `cold` filter. The old name described a filter that ALSO matched never-read
  // records (251 of the 252 rows it returned, measured 2026-08-31), and
  // collided with `staleness.ts`'s unrelated "tracking task shipped" sense.
  test("mem_f_cold=true is the Cold cohort", () => {
    expect(activeCohort("?mem_f_cold=true")).toBe("cold");
  });

  test("a legacy mem_f_stale=true link still lights the Cold cohort", () => {
    // Shared/bookmarked URLs from before the rename must keep working. mt#4799
    // renamed the domain field `stale` → `unreadOrCold` and kept `stale` as a
    // read-only alias at every layer that reads it — the page's cohort check
    // here, `MemoriesFilters`/`DEFAULT_FILTERS` (without which the URL→state
    // reader would never read the key at all), and the cockpit widget's query
    // parsing — so the table still filters and this asserts the chip agrees.
    expect(activeCohort("?mem_f_stale=true")).toBe("cold");
  });

  test("mem_f_unreadOrCold=true — the post-rename key — also lights the Cold cohort", () => {
    // The other half of the alias pair (mt#4799). Without this, the legacy
    // assertion above would still pass on a build where the CURRENT key was
    // wired up wrongly, since the two are checked independently.
    expect(activeCohort("?mem_f_unreadOrCold=true")).toBe("cold");
  });

  // mt#4767: the All cohort's active-check used to be a bare
  // `stale !== "true"` (the field mt#4799 renamed to `unreadOrCold`), so any
  // OTHER narrowing filter left "All" highlighted
  // while the table showed a narrowed list.
  test.each([
    ["untagged", "?mem_f_untagged=true"],
    ["neverAccessed", "?mem_f_neverAccessed=true"],
    ["onlySuperseded", "?mem_f_onlySuperseded=true"],
  ])("a %s worklist is NOT the All cohort", (_name, search) => {
    expect(activeCohort(search)).not.toBe("all");
  });
});

// ---------------------------------------------------------------------------
// Rendered page
// ---------------------------------------------------------------------------

function renderPage() {
  const calls: string[] = [];
  global.fetch = mock(async (url: string) => {
    calls.push(url);
    if (url.startsWith("/api/widget/memories-list/data")) {
      return jsonResponse({ state: "ok", payload: { records: [], total: 0 } });
    }
    if (url.startsWith("/api/widget/memories-facets/data")) {
      return jsonResponse({
        state: "ok",
        payload: {
          flat: [
            { tag: "handoff", count: 353 },
            { tag: "cockpit", count: 12 },
          ],
          namespaces: [],
        },
      });
    }
    if (url.startsWith("/api/widget/memories-families/data")) {
      return jsonResponse({
        state: "ok",
        payload: {
          families: [
            {
              slug: "assertion-without-verification",
              tag: "family:assertion-without-verification",
              memberCount: 66,
              firstMemberAt: "2026-01-01T00:00:00.000Z",
              mostRecentMemberAt: "2026-08-20T00:00:00.000Z",
              structuralFixTasks: ["mt#4749"],
            },
          ],
        },
      });
    }
    if (url.startsWith("/api/widget/memories-health/data")) {
      return jsonResponse({ state: "ok", payload: { embeddingsHealthy: true } });
    }
    if (url.startsWith("/api/widget/memories-stats/data")) {
      return jsonResponse({
        state: "ok",
        payload: {
          total: 0,
          supersededCount: 0,
          byType: { user: 0, feedback: 0, project: 0, reference: 0 },
          recentCount: 0,
          topAccessed: [],
        },
      });
    }
    if (url.startsWith("/api/tasks/ids")) {
      return jsonResponse({ ids: [] });
    }
    return jsonResponse({ state: "degraded", reason: "not mocked" });
  }) as unknown as typeof fetch;
  stubProjectsRoute();

  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const result = render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ProjectProvider>
          <MemoriesPage />
        </ProjectProvider>
      </MemoryRouter>
    </QueryClientProvider>
  );
  return { ...result, calls };
}

describe("MemoriesPage — cohort switcher one-click navigation (mt#4763 AT1)", () => {
  test("clicking Handoffs from a cold page issues a memories-list request carrying tags=handoff", async () => {
    const { container, calls } = renderPage();
    await waitFor(() =>
      expect(calls.some((c) => c.startsWith("/api/widget/memories-list/data"))).toBe(true)
    );

    const handoffsTab = Array.from(container.querySelectorAll('button[role="tab"]')).find(
      (b) => b.textContent === "Handoffs"
    );
    expect(handoffsTab).toBeTruthy();

    fireEvent.click(handoffsTab as Element);

    await waitFor(() => {
      expect(
        calls.some(
          (c) => c.startsWith("/api/widget/memories-list/data") && c.includes("tags=handoff")
        )
      ).toBe(true);
    });
  });
});

describe("MemoriesPage — facet rail multi-select (mt#4763 AT4)", () => {
  test("clicking two facet chips builds an AND (comma-joined) tags filter on the list request", async () => {
    const { container, calls } = renderPage();
    await waitFor(() => expect(container.textContent).toContain("handoff"));

    const handoffChip = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.startsWith("handoff")
    );
    expect(handoffChip).toBeTruthy();
    fireEvent.click(handoffChip as Element);

    await waitFor(() => {
      expect(
        calls.some(
          (c) => c.startsWith("/api/widget/memories-list/data") && c.includes("tags=handoff")
        )
      ).toBe(true);
    });

    const cockpitChip = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.startsWith("cockpit")
    );
    expect(cockpitChip).toBeTruthy();
    fireEvent.click(cockpitChip as Element);

    await waitFor(() => {
      const latest = [...calls].reverse().find((c) => c.startsWith("/api/widget/memories-list/data"));
      expect(latest).toContain("tags=handoff%2Ccockpit");
    });
  });
});

describe("MemoriesPage — Families view swap (mt#4763)", () => {
  test("clicking Families renders the families table instead of the memories list", async () => {
    const { container, calls } = renderPage();
    await waitFor(() =>
      expect(calls.some((c) => c.startsWith("/api/widget/memories-list/data"))).toBe(true)
    );

    const familiesTab = Array.from(container.querySelectorAll('button[role="tab"]')).find(
      (b) => b.textContent === "Families"
    );
    expect(familiesTab).toBeTruthy();
    fireEvent.click(familiesTab as Element);

    await waitFor(() => {
      expect(calls.some((c) => c.startsWith("/api/widget/memories-families/data"))).toBe(true);
    });
    await waitFor(() =>
      expect(container.textContent).toContain("assertion-without-verification")
    );
  });
});

describe("MemoriesPage — facet rail vertical-space bound (PR #3500 R2)", () => {
  test("the facet rail's scrollable content region is height-bounded, so it cannot push the table below the fold", async () => {
    const { container } = renderPage();
    await waitFor(() => expect(container.textContent).toContain("handoff"));

    const rail = container.querySelector('[data-testid="facets-rail"]');
    expect(rail).not.toBeNull();
    // The rail's OWN element must not carry an unbounded content height —
    // the bound lives on its first child (the scrollable region), which
    // must cap max-height and scroll internally rather than growing with
    // the number of tags (PR #3500 R2: an unbounded rail measured ~730px
    // tall against a 1000px viewport, leaving only 3 table rows visible).
    const scrollRegion = rail?.firstElementChild;
    expect(scrollRegion?.className).toContain("max-h-");
    expect(scrollRegion?.className).toContain("overflow-y-auto");
  });
});
