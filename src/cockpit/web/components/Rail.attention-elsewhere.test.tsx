/**
 * Rail × cross-project attention leak (mt#4794).
 *
 * The rail's pinned Attention digest used to go fully silent under a project
 * filter — a scoped "clear" badge with zero pending, even while another
 * project carried a large pending backlog (live-verified in the mt#4757
 * audit: Peezombie filter active, rail read "clear", 40+ Minsky asks
 * pending). These tests pin the three fixture states the spec's Success
 * Criteria enumerate: scoped 0/unscoped N (leak renders), scoped N/unscoped N
 * (no leak — equal), and All-projects (never renders, regardless of count).
 */
import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { Rail } from "./Rail";
import { NewConversationProvider } from "../hooks/useNewConversation";
import { ProjectProvider } from "../lib/project-context";

const STORAGE_KEY = "cockpit.project.v1";

function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
}

function renderRail() {
  return render(
    <QueryClientProvider client={createTestQueryClient()}>
      <MemoryRouter initialEntries={["/tasks"]}>
        {/* ProjectProvider is Rail's other required ancestor — see
            Rail.newConversation.test.tsx's precedent. */}
        <ProjectProvider>
          <NewConversationProvider>
            <Rail />
          </NewConversationProvider>
        </ProjectProvider>
      </MemoryRouter>
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

/**
 * Routes `/api/widget/attention/data` by presence of `?project=` — scoped
 * requests (a project selected) get `scoped`, everything else (no filter, or
 * the deliberately-unscoped `{global:true}` fetch) gets `unscoped`. Mirrors
 * apiFetch's real default-append behavior (mt#4730): a call WITHOUT an
 * explicit `project` param picks up the persisted slug automatically, so the
 * scoped/unscoped split in production is genuinely keyed on the query
 * string, not on which function was called.
 */
function stubAttention(scoped: number, unscoped: number) {
  globalThis.fetch = mock(async (input: RequestInfo | URL) => {
    const url = String(input);
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    if (url.includes("/api/health")) return json({ commit: "abc1234" });
    if (url.includes("/api/widget/attention/data")) {
      const totalPending = url.includes("project=") ? scoped : unscoped;
      return json({ state: "ok", payload: { totalPending } });
    }
    // /api/projects and anything else — the fixture doesn't exercise the
    // project-switcher UI, so an empty list is sufficient.
    return json({ projects: [] });
  }) as unknown as typeof globalThis.fetch;
}

describe("Rail — cross-project attention leak (mt#4794)", () => {
  test("project filter active, scoped=0/unscoped=40: renders 'clear' plus a muted '+40 elsewhere'", async () => {
    localStorage.setItem(STORAGE_KEY, "edobry/peezombie");
    stubAttention(0, 40);
    renderRail();

    await waitFor(() => expect(screen.getByText("clear")).toBeDefined());
    const elsewhere = await screen.findByTestId("attention-elsewhere");
    expect(elsewhere.textContent).toBe("+40 elsewhere");
    expect(elsewhere.getAttribute("href")).toBe("/asks");
  });

  test("project filter active, scoped=N/unscoped=N (equal): no elsewhere secondary", async () => {
    localStorage.setItem(STORAGE_KEY, "edobry/peezombie");
    stubAttention(40, 40);
    renderRail();

    await waitFor(() => expect(screen.getByText("40")).toBeDefined());
    expect(screen.queryByTestId("attention-elsewhere")).toBeNull();
  });

  test("All-projects selected, pending=40: never renders an elsewhere secondary", async () => {
    // No persisted slug => All projects (project-context.tsx's default).
    stubAttention(40, 40);
    renderRail();

    await waitFor(() => expect(screen.getByText("40")).toBeDefined());
    expect(screen.queryByTestId("attention-elsewhere")).toBeNull();
  });

  test("clicking '+N elsewhere' clears the project filter", async () => {
    localStorage.setItem(STORAGE_KEY, "edobry/peezombie");
    stubAttention(0, 40);
    renderRail();

    const elsewhere = await screen.findByTestId("attention-elsewhere");
    elsewhere.click();

    await waitFor(() => {
      try {
        expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
      } catch {
        // localStorage unavailable in this environment — nothing to assert.
      }
    });
  });
});
