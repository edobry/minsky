/**
 * AskPage settle-convention tests (mt#2410, PR #1668 R1).
 *
 * Asks are consumable: a mutation settle removes the ask from the pending
 * set, so the page closes its own entity tab and lands on /asks in a single
 * navigation (closeTab's navigateTo). These tests mock the /api/asks
 * endpoints and assert the redirect + tab removal end state.
 *
 * Lives in widgets/ so `bun run test:components` picks it up, per the
 * tab-bar-kinds.test.tsx precedent for cross-component tests.
 */
import { describe, test, expect, afterEach, beforeEach } from "bun:test";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter, Routes, Route, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TabsProvider } from "../lib/tabs";
import { TabBar } from "../components/TabBar";
import { AskPage } from "../pages/AskPage";

const ASK_ID = "0a1b2c3d-0000-0000-0000-000000000000";

const PENDING_ASK = {
  id: ASK_ID,
  kind: "coordination.notify",
  state: "routed",
  title: "Settle-convention fixture ask",
  question: "Does the settle convention close the tab?",
  requestor: "test-agent",
  createdAt: "2026-06-10T12:00:00.000Z",
  windowMissedCount: 0,
  metadata: {},
};

function LocationProbe() {
  const { pathname } = useLocation();
  return <div data-testid="location">{pathname}</div>;
}

function renderAskRoute() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/ask/${ASK_ID}`]}>
        <TabsProvider>
          <TabBar />
          <LocationProbe />
          <Routes>
            <Route path="/ask/:id" element={<AskPage />} />
            <Route path="/asks" element={<div>ASKS LIST STUB</div>} />
          </Routes>
        </TabsProvider>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe("AskPage settle convention (mt#2410)", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    localStorage.clear();
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/asks") && (!init || !init.method || init.method === "GET")) {
        return new Response(JSON.stringify({ asks: [PENDING_ASK], total: 1 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes(`/api/asks/${ASK_ID}/defer`)) {
        return new Response("{}", { status: 200 });
      }
      /** Per-id deeplink resolution path (mt#2669). */
      if (url.endsWith(`/api/asks/${ASK_ID}`) && (!init || !init.method || init.method === "GET")) {
        return new Response(JSON.stringify({ ask: PENDING_ASK }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`Unexpected fetch in test: ${url}`);
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    cleanup();
  });

  test("deferring an ask closes its tab and lands on /asks", async () => {
    renderAskRoute();

    // Detail loaded; the ask's entity tab opened on visit (the short id
    // appears in both the breadcrumb and the tab label).
    await waitFor(() => expect(screen.getByText("Settle-convention fixture ask")).toBeDefined());
    expect(screen.getAllByText("0a1b2c3d…").length).toBeGreaterThanOrEqual(1);

    fireEvent.click(screen.getByText("Defer"));

    // Settle: single navigation to /asks, ask tab removed from the strip.
    await waitFor(() => {
      expect(screen.getByTestId("location").textContent).toBe("/asks");
    });
    expect(screen.queryByText("0a1b2c3d…")).toBeNull();
    expect(screen.getByText("ASKS LIST STUB")).toBeDefined();
  });

  test("Back is plain navigation — the unconsumed ask's tab persists", async () => {
    renderAskRoute();
    await waitFor(() => expect(screen.getByText("Settle-convention fixture ask")).toBeDefined());

    fireEvent.click(screen.getByText("Back"));

    await waitFor(() => {
      expect(screen.getByTestId("location").textContent).toBe("/asks");
    });
    // Tab stays in the working set: the ask was not consumed. Only the tab
    // label remains (the breadcrumb left with the detail page).
    expect(screen.getAllByText("0a1b2c3d…")).toHaveLength(1);
  });
});