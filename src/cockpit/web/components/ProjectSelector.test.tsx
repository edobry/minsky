/**
 * ProjectSelector component tests (mt#2418; per-option triage summary
 * mt#4795).
 *
 * Pattern mirrors Credentials.test.tsx: QueryClientProvider + mocked
 * globalThis.fetch + waitFor/findBy* for async settling.
 */
import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { render, screen, cleanup, waitFor, fireEvent, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ProjectSelector } from "./ProjectSelector";
import { ProjectProvider, useProject } from "../lib/project-context";

function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
}

function renderSelector() {
  return render(
    <QueryClientProvider client={createTestQueryClient()}>
      <ProjectProvider>
        <ProjectSelector />
      </ProjectProvider>
    </QueryClientProvider>
  );
}

/** Exposes the current selectedSlug as text, for assertions on selection state. */
function SelectedSlugProbe() {
  const { selectedSlug } = useProject();
  return <span data-testid="selected-slug">{selectedSlug ?? "ALL"}</span>;
}

function renderSelectorWithProbe() {
  return render(
    <QueryClientProvider client={createTestQueryClient()}>
      <ProjectProvider>
        <ProjectSelector />
        <SelectedSlugProbe />
      </ProjectProvider>
    </QueryClientProvider>
  );
}

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  try {
    localStorage.clear();
  } catch {
    /* jsdom/happy-dom always provides localStorage; ignore if not */
  }
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

function mockProjectsResponse(
  projects: Array<{ id: string; slug: string; displayName: string | null }>
) {
  globalThis.fetch = mock(() =>
    Promise.resolve(
      new Response(JSON.stringify({ projects }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    )
  ) as unknown as typeof globalThis.fetch;
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Routes `/api/projects` plus the two per-project-scoped widget endpoints
 * `useProjectTriageSummaries` composes (`attention`, `agents`) by their
 * `?project=` query param — `""` keys the unparented ("All projects"
 * aggregate) scope. A value of `"degraded"` simulates the widget itself
 * reporting `{ state: "degraded" }` (a live fetch that succeeded at the
 * HTTP layer but failed at the widget layer) — the fixture for spec SC2.
 */
function mockProjectsAndWidgets(opts: {
  projects: Array<{ id: string; slug: string; displayName: string | null }>;
  /** Keyed by project slug, or "" for the unparented/aggregate scope. */
  pending: Record<string, number | "degraded">;
  /** Keyed by project slug, or "" for the unparented/aggregate scope. */
  working: Record<string, number | "degraded">;
}) {
  globalThis.fetch = mock((input: RequestInfo | URL) => {
    const url = String(input);
    const parsed = new URL(url, "http://localhost");
    const key = parsed.searchParams.get("project") ?? "";

    if (parsed.pathname === "/api/projects") {
      return Promise.resolve(jsonResponse({ projects: opts.projects }));
    }
    if (parsed.pathname === "/api/widget/attention/data") {
      const v = opts.pending[key];
      if (v === undefined || v === "degraded") {
        return Promise.resolve(jsonResponse({ state: "degraded", reason: "fixture: unavailable" }));
      }
      return Promise.resolve(jsonResponse({ state: "ok", payload: { totalPending: v } }));
    }
    if (parsed.pathname === "/api/widget/agents/data") {
      const v = opts.working[key];
      if (v === undefined || v === "degraded") {
        return Promise.resolve(jsonResponse({ state: "degraded", reason: "fixture: unavailable" }));
      }
      const agents = Array.from({ length: v }, () => ({ liveness: "healthy" as const }));
      return Promise.resolve(jsonResponse({ state: "ok", payload: { agents } }));
    }
    return Promise.resolve(new Response("not found", { status: 404 }));
  }) as unknown as typeof globalThis.fetch;
}

describe("ProjectSelector", () => {
  test("renders nothing when zero projects are known", async () => {
    mockProjectsResponse([]);
    renderSelector();
    await waitFor(() => expect(screen.queryByLabelText("Filter by project")).toBeNull());
  });

  test("renders nothing when exactly one project is known", async () => {
    mockProjectsResponse([{ id: "1", slug: "edobry/minsky", displayName: "Minsky" }]);
    renderSelector();
    await waitFor(() => expect(screen.queryByLabelText("Filter by project")).toBeNull());
  });

  test("renders a select with All projects + each project when 2+ are known", async () => {
    mockProjectsResponse([
      { id: "1", slug: "edobry/minsky", displayName: "Minsky" },
      { id: "2", slug: "edobry/other-repo", displayName: null },
    ]);
    renderSelector();

    const select = await screen.findByLabelText("Filter by project");
    expect(select).toBeDefined();

    // Radix portals the option list and only mounts it while open, so the
    // labels are not in the DOM until the panel opens. Opened via keydown:
    // Radix gates pointer events on pointer capture the DOM stub lacks.
    fireEvent.keyDown(select, { key: "Enter" });

    expect(screen.getByRole("option", { name: "All projects" })).toBeDefined();
    expect(screen.getByRole("option", { name: "Minsky" })).toBeDefined();
    // Falls back to the raw slug when displayName is null.
    expect(screen.getByRole("option", { name: "edobry/other-repo" })).toBeDefined();
  });

  test("selecting a project updates the shared context's selectedSlug", async () => {
    mockProjectsResponse([
      { id: "1", slug: "edobry/minsky", displayName: "Minsky" },
      { id: "2", slug: "edobry/other-repo", displayName: null },
    ]);
    renderSelectorWithProbe();

    const select = await screen.findByLabelText("Filter by project");
    expect(screen.getByTestId("selected-slug").textContent).toBe("ALL");

    fireEvent.keyDown(select, { key: "Enter" });
    fireEvent.click(screen.getByRole("option", { name: "Minsky" }));

    await waitFor(() =>
      expect(screen.getByTestId("selected-slug").textContent).toBe("edobry/minsky")
    );
  });
});

describe("ProjectSelector — per-option triage summary (mt#4795)", () => {
  const projects = [
    { id: "1", slug: "edobry/minsky", displayName: "Minsky" },
    { id: "2", slug: "edobry/peezombie-me", displayName: "Peezombie.me" },
  ];

  test("renders per-project counts, a 'clear' project, and a distinct All-projects aggregate", async () => {
    mockProjectsAndWidgets({
      projects,
      pending: { "edobry/minsky": 40, "edobry/peezombie-me": 0, "": 41 },
      working: { "edobry/minsky": 3, "edobry/peezombie-me": 0, "": 3 },
    });
    renderSelector();

    const select = await screen.findByLabelText("Filter by project");
    fireEvent.keyDown(select, { key: "Enter" });

    // Per-project counts (SC1 / AT1).
    await screen.findByText("40 need you · 3 working");
    await screen.findByText("clear");

    // All-projects aggregates independently — deliberately a DIFFERENT
    // number from any single project's line above, so a passing assertion
    // can only mean the aggregate scope's own fetch was read (not a
    // coincidental string collision with the Minsky row).
    await screen.findByText("41 need you · 3 working");

    // Closed-state behavior is unaffected by the open dropdown's per-option
    // triage lines (SC3) — the trigger keeps showing the plain "All
    // projects" label, never a portalled copy of an option's triage text.
    expect(select.textContent).toBe("All projects");
    expect(select.textContent).not.toContain("need you");
    expect(select.textContent).not.toContain("working");
  });

  test("a failed per-project fetch renders a degraded marker, never a fabricated 'clear' (SC2)", async () => {
    mockProjectsAndWidgets({
      projects,
      // Minsky resolves cleanly; Peezombie.me's agents fetch fails while its
      // attention fetch succeeds with a genuine zero — the scope must still
      // read as degraded as a whole, not silently pass through as "clear".
      // The aggregate ("") deliberately differs from Minsky's own numbers so
      // the two rows' text can't collide under a `findByText` lookup.
      pending: { "edobry/minsky": 5, "edobry/peezombie-me": 0, "": 6 },
      working: { "edobry/minsky": 1, "edobry/peezombie-me": "degraded", "": 2 },
    });
    renderSelector();

    const select = await screen.findByLabelText("Filter by project");
    fireEvent.keyDown(select, { key: "Enter" });

    await screen.findByText("5 need you · 1 working");
    await screen.findByText("status unavailable");
    // Never renders as a false "clear" for the degraded project.
    expect(screen.queryByText("clear")).toBeNull();
  });

  test("option accessible names stay label-only — the muted triage line does not leak into the name", async () => {
    mockProjectsAndWidgets({
      projects,
      pending: { "edobry/minsky": 40, "edobry/peezombie-me": 0, "": 41 },
      working: { "edobry/minsky": 3, "edobry/peezombie-me": 0, "": 3 },
    });
    renderSelector();

    const select = await screen.findByLabelText("Filter by project");
    fireEvent.keyDown(select, { key: "Enter" });

    await screen.findByText("40 need you · 3 working");

    // Same accessible-name assertions as the pre-mt#4795 baseline test —
    // unchanged despite each option now rendering a second, muted line.
    const minskyOption = screen.getByRole("option", { name: "Minsky" });
    expect(within(minskyOption).getByText("40 need you · 3 working")).toBeDefined();
    expect(screen.getByRole("option", { name: "Peezombie.me" })).toBeDefined();
    expect(screen.getByRole("option", { name: "All projects" })).toBeDefined();
  });
});
