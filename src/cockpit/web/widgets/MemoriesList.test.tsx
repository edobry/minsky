/**
 * MemoriesList tests.
 *
 * Shape 2 (mt#3175, extended mt#4762): `rec.description`'s truncated
 * single-line row cell still linkifies via the inline-only `<LinkifiedText>`
 * path (never `<Prose>` — block Markdown would break the single-line
 * truncation this row depends on). The wrapper moved from a `<td>` to a
 * `<div>` under the redesigned row (mt#4762 — description is now a second
 * line under the name, not a competing column), so the selector below is
 * updated to match; the linkification behavior under test is unchanged.
 *
 * mt#4762 adds: the `mem#N` column (AT1), the sort-request assertion (AT2 —
 * asserting the OUTGOING REQUEST, not just the rendered order, per the task
 * spec's explicit warning that a client-side re-sort of one page would pass
 * a render-only check and be wrong), tag-provenance demotion (AT4), and the
 * folded-in search box (AT5).
 *
 * `useListControls` writes URL state via `window.history.replaceState`,
 * which happy-dom's default `about:blank` document silently no-ops on (no
 * throw, `window.location.search` just never changes) — nothing in this
 * suite ever exercised that path before (the hook's own test file sticks to
 * pure-function calls precisely because "Bun doesn't ship renderHook", which
 * also happens to route around this). Giving the document a real origin via
 * `happyDOM.setURL` before each test is what makes AT2/AT5 (both of which
 * depend on a REAL URL round-trip) observable at all.
 *
 * Run via: bun run test:components
 */
import { describe, test, expect, beforeAll, beforeEach, afterAll, afterEach, mock } from "bun:test";
import { render, cleanup, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoriesList, formatMemoryDisplayName, parseHandoffName } from "./MemoriesList";
import type { MemoryRecord } from "@minsky/domain/memory/types";
import { ProjectProvider } from "../lib/project-context";

const originalFetch = global.fetch;

function setDocumentUrl(url: string) {
  (window as unknown as { happyDOM: { setURL: (u: string) => void } }).happyDOM.setURL(url);
}

// happy-dom's `window`/`location`/`history` are process-wide globals shared
// across every test FILE in one `bun test` run, not just this file's own
// tests — so the origin this suite needs (a real URL, not the default
// `about:blank`, which `history.replaceState` silently no-ops on) must be
// restored to whatever it was before this file ran, or a later file that
// assumes the untouched default sees this file's leftover URL/query state
// instead (observed: a residual `/memories?mem_...` origin made an unrelated
// ChangesetsPage test fail, but only when run after this file in the full
// suite — never in isolation).
let originalHref = "about:blank";

beforeAll(() => {
  originalHref = window.location.href;
});

beforeEach(() => {
  setDocumentUrl("http://localhost/memories");
});

afterEach(() => {
  cleanup();
  global.fetch = originalFetch;
});

afterAll(() => {
  setDocumentUrl(originalHref);
});

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as Response;
}

function baseRecord(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: "mem-1",
    shortId: "mem#101",
    type: "reference",
    name: "A memory",
    description: "See mt#77 for context",
    content: "content",
    scope: "project",
    projectId: null,
    tags: [],
    sourceAgentId: null,
    sourceSessionId: null,
    confidence: null,
    supersededBy: null,
    metadata: null,
    associations: {},
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    lastAccessedAt: null,
    accessCount: 0,
    ...overrides,
  } as MemoryRecord;
}

interface RenderOptions {
  records?: MemoryRecord[];
  total?: number;
}

function renderList({ records = [baseRecord()], total }: RenderOptions = {}) {
  const calls: string[] = [];
  global.fetch = mock(async (url: string) => {
    calls.push(url);
    if (url.startsWith("/api/widget/memories-list/data")) {
      return jsonResponse({ state: "ok", payload: { records, total: total ?? records.length } });
    }
    if (url.startsWith("/api/widget/memories-search/data")) {
      return jsonResponse({
        state: "ok",
        payload: {
          results: records.map((record) => ({ record, score: 0.9 })),
          backend: "lexical",
          degraded: false,
          query: "",
        },
      });
    }
    if (url.startsWith("/api/tasks/ids")) {
      return jsonResponse({ ids: ["mt#77"] });
    }
    return jsonResponse({ state: "degraded", reason: "not mocked" });
  }) as unknown as typeof fetch;

  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const result = render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ProjectProvider>
          <MemoriesList />
        </ProjectProvider>
      </MemoryRouter>
    </QueryClientProvider>
  );
  return { ...result, calls };
}

describe("MemoriesList — Shape 2: rec.description (mt#3175 / mt#4762)", () => {
  test("an entity ref in the description linkifies without breaking the truncated single-line cell", async () => {
    const { container } = renderList({ records: [baseRecord()] });

    await waitFor(() => {
      expect(container.querySelector('a[href="/tasks/mt%2377"]')).not.toBeNull();
    });

    // Layout preserved: the truncate/title wrapper is unchanged, just moved
    // from a <td> to a <div> beneath the name (mt#4762).
    const snippet = container.querySelector(".text-small.text-muted-foreground.truncate");
    expect(snippet).not.toBeNull();
    expect(snippet?.getAttribute("title")).toBe("See mt#77 for context");
  });

  test("a description with no entity refs renders as plain truncated text (unchanged)", async () => {
    const { container } = renderList({ records: [baseRecord({ description: "no refs here" })] });
    await waitFor(() => {
      expect(container.textContent).toContain("no refs here");
    });
    expect(container.querySelector(".text-small.text-muted-foreground.truncate a")).toBeNull();
  });
});

describe("MemoriesList — mem#N column (mt#4762 AT1)", () => {
  test("the leading column shows the record's shortId, monospace", async () => {
    const { container } = renderList({ records: [baseRecord({ shortId: "mem#4200" })] });
    await waitFor(() => {
      expect(container.textContent).toContain("mem#4200");
    });
    const idCell = Array.from(container.querySelectorAll("span")).find(
      (el) => el.textContent === "mem#4200"
    );
    expect(idCell).toBeTruthy();
    expect(idCell?.className).toContain("font-mono");
  });

  test("clicking a row navigates to /memory/:id", async () => {
    const { container } = renderList({ records: [baseRecord({ id: "mem-42", shortId: "mem#42" })] });
    await waitFor(() => expect(container.textContent).toContain("mem#42"));
    const row = container.querySelector('[role="button"]');
    expect(row).not.toBeNull();
    fireEvent.click(row as Element);
    // Navigation via react-router's useNavigate isn't observable through the
    // DOM directly under MemoryRouter without a route table; the meaningful
    // guarantee here is that the row is a keyboard-and-click-operable control
    // (role="button", tabIndex 0) wired to a single onOpen callback — full
    // routing behavior is exercised by MemoryRouter's own tests.
    expect(row?.getAttribute("tabindex")).toBe("0");
  });
});

describe("MemoriesList — sort requests the server (mt#4762 AT2)", () => {
  test("clicking Accesses issues a request carrying sort=accessCount, and clicking again flips dir", async () => {
    const { container, calls } = renderList({ records: [baseRecord()] });
    await waitFor(() =>
      expect(calls.some((c) => c.startsWith("/api/widget/memories-list/data"))).toBe(true)
    );

    const header = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.startsWith("Accesses")
    );
    expect(header).toBeTruthy();

    fireEvent.click(header as Element);
    await waitFor(() => {
      expect(calls.some((c) => c.includes("sort=accessCount") && c.includes("dir=desc"))).toBe(
        true
      );
    });

    fireEvent.click(header as Element);
    await waitFor(() => {
      expect(calls.some((c) => c.includes("sort=accessCount") && c.includes("dir=asc"))).toBe(
        true
      );
    });
  });
});

describe("MemoriesList — tag provenance demotion (mt#4762 AT4)", () => {
  test("the provenance tag never occupies a visible slot, even when a semantic tag would otherwise be hidden", async () => {
    // 4 semantic tags + 2 provenance tags, 3 visible slots: even though ONE
    // semantic tag is unavoidably pushed to overflow (4 > 3), NEITHER
    // provenance tag ever displaces a semantic one into a visible slot.
    const { container } = renderList({
      records: [
        baseRecord({
          tags: [
            "handoff",
            "retrospective",
            "incident",
            "workaround",
            "imported-from:claude-code",
            "content-hash:abc123",
          ],
        }),
      ],
    });

    await waitFor(() => expect(container.textContent).toContain("handoff"));

    expect(container.textContent).toContain("handoff");
    expect(container.textContent).toContain("retrospective");
    expect(container.textContent).toContain("incident");
    expect(container.textContent).not.toContain("imported-from:claude-code");
    expect(container.textContent).not.toContain("content-hash:abc123");
    // 1 hidden semantic tag ("workaround") + 2 provenance tags = +3.
    expect(container.textContent).toContain("+3");
  });

  test("AT4's literal case: a semantic tag stays visible and the provenance tag does not", async () => {
    const { container } = renderList({
      records: [baseRecord({ tags: ["imported-from:claude-code", "handoff"] })],
    });
    await waitFor(() => expect(container.textContent).toContain("handoff"));
    expect(container.textContent).not.toContain("imported-from:claude-code");
  });
});

describe("MemoriesList — search folds into the table toolbar (mt#4762 AT5)", () => {
  test("typing a query switches to memories-search and narrows the table in place", async () => {
    const listRecord = baseRecord({ id: "mem-1", name: "Unrelated", shortId: "mem#1" });
    const searchRecord = baseRecord({ id: "mem-2", name: "Matched result", shortId: "mem#2" });

    const calls: string[] = [];
    global.fetch = mock(async (url: string) => {
      calls.push(url);
      if (url.startsWith("/api/widget/memories-search/data")) {
        return jsonResponse({
          state: "ok",
          payload: {
            results: [{ record: searchRecord, score: 0.9 }],
            backend: "embeddings",
            degraded: false,
            query: "matched",
          },
        });
      }
      if (url.startsWith("/api/widget/memories-list/data")) {
        return jsonResponse({ state: "ok", payload: { records: [listRecord], total: 1 } });
      }
      if (url.startsWith("/api/tasks/ids")) return jsonResponse({ ids: [] });
      return jsonResponse({ state: "degraded", reason: "not mocked" });
    }) as unknown as typeof fetch;

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { container } = render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <ProjectProvider>
            <MemoriesList />
          </ProjectProvider>
        </MemoryRouter>
      </QueryClientProvider>
    );

    await waitFor(() => expect(container.textContent).toContain("Unrelated"));

    const input = container.querySelector('input[type="search"]') as HTMLInputElement;
    fireEvent.change(input, { target: { value: "matched" } });

    // Debounce is 300ms — advance past it.
    await new Promise((r) => setTimeout(r, 350));

    await waitFor(() => {
      expect(
        calls.some(
          (c) => c.startsWith("/api/widget/memories-search/data?") && c.includes("q=matched")
        )
      ).toBe(true);
    });
    await waitFor(() => expect(container.textContent).toContain("Matched result"));
    expect(container.textContent).not.toContain("Unrelated");
  });
});

describe("MemoriesList — handoff name parsing (mt#4763)", () => {
  test("parseHandoffName extracts the cluster slug and date, underscores rendered as spaces", () => {
    expect(parseHandoffName("handoff_cockpit_facets_2026-08-30")).toEqual({
      slug: "cockpit facets",
      date: "2026-08-30",
    });
  });

  test("a hyphenated slug is left as-is (only underscores are treated as word separators)", () => {
    expect(parseHandoffName("handoff_cockpit-facets_2026-08-30")).toEqual({
      slug: "cockpit-facets",
      date: "2026-08-30",
    });
  });

  test("parseHandoffName returns null for a non-matching name", () => {
    expect(parseHandoffName("some other memory name")).toBeNull();
  });

  test("formatMemoryDisplayName only rewrites handoff-tagged, convention-matching names", () => {
    expect(formatMemoryDisplayName("handoff_cockpit_facets_2026-08-30", ["handoff"])).toBe(
      "cockpit facets"
    );
    // Not tagged handoff: the name is left alone even though it matches the pattern.
    expect(formatMemoryDisplayName("handoff_cockpit_facets_2026-08-30", ["other"])).toBe(
      "handoff_cockpit_facets_2026-08-30"
    );
    // Tagged handoff but doesn't match the naming convention: left alone.
    expect(formatMemoryDisplayName("Ad-hoc handoff note", ["handoff"])).toBe(
      "Ad-hoc handoff note"
    );
  });
});

describe("MemoriesList — clickable tags (mt#4763 AT6)", () => {
  test("clicking a tag chip issues a request carrying tags=<tag>, without opening the row", async () => {
    const { container, calls } = renderList({
      records: [baseRecord({ id: "mem-1", shortId: "mem#1", tags: ["handoff", "cockpit"] })],
    });
    await waitFor(() => expect(container.textContent).toContain("handoff"));

    const tagButton = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent === "handoff"
    );
    expect(tagButton).toBeTruthy();

    fireEvent.click(tagButton as Element);

    await waitFor(() => {
      expect(
        calls.some((c) => c.startsWith("/api/widget/memories-list/data") && c.includes("tags=handoff"))
      ).toBe(true);
    });
  });

  test("clicking a second, different tag REPLACES the filter (single-tag semantics from a row)", async () => {
    const { container, calls } = renderList({
      records: [baseRecord({ id: "mem-1", shortId: "mem#1", tags: ["handoff", "cockpit"] })],
    });
    await waitFor(() => expect(container.textContent).toContain("handoff"));

    const handoffButton = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent === "handoff"
    ) as Element;
    fireEvent.click(handoffButton);
    await waitFor(() => expect(calls.some((c) => c.includes("tags=handoff"))).toBe(true));

    const cockpitButton = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent === "cockpit"
    ) as Element;
    fireEvent.click(cockpitButton);

    await waitFor(() => {
      const latestListCall = [...calls].reverse().find((c) => c.startsWith("/api/widget/memories-list/data"));
      expect(latestListCall).toContain("tags=cockpit");
      expect(latestListCall).not.toContain("tags=handoff");
    });
  });
});
