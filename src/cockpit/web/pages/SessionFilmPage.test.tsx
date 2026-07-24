/**
 * SessionFilmPage tests (mt#3184).
 *
 * Covers spec AT 3 (`?t=<event>` deep link opens the film at the correct
 * playhead) and a basic picker -> ribbon/stage wiring smoke test.
 *
 * Run via: bun test --preload ./tests/dom-setup.ts --preload ./tests/setup.ts \
 *   src/cockpit/web/pages/SessionFilmPage.test.tsx
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { SessionFilmPage } from "./SessionFilmPage";

const CONVERSATION_ID = "12345678-1234-1234-1234-123456789012";

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

function fixtureEvents() {
  return Array.from({ length: 10 }, (_, i) => ({
    schemaVersion: "v0",
    tStart: new Date(2026, 6, 24, 0, 0, i).toISOString(),
    actor: { kind: "agent", agentSessionId: "a1" },
    verb: "read",
    target: { realm: "repo", id: `file:ws:${i}.ts` },
    outcome: "ok",
    weight: 1,
    batchId: `b${i}`,
    adapterVersion: "test",
  }));
}

function mockFetches() {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname === "/api/cockpit/session-film/sessions") {
      return new Response(
        JSON.stringify({
          sessions: [
            {
              agentSessionId: CONVERSATION_ID,
              label: "test session",
              startedAt: null,
              cwd: null,
              ingestedAt: "2026-07-20T00:00:00.000Z",
              scrubGateOk: true,
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    if (url.pathname === "/api/cockpit/session-film/events") {
      return new Response(
        JSON.stringify({ events: fixtureEvents(), ingestedAt: "2026-07-20T00:00:00.000Z" }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

function renderPage(initialPath: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <QueryClientProvider client={queryClient}>
        <Routes>
          <Route path="/session-film" element={<SessionFilmPage />} />
        </Routes>
      </QueryClientProvider>
    </MemoryRouter>
  );
}

describe("SessionFilmPage — picker", () => {
  test("shows the picker when no session is selected, then loads the film on selection", async () => {
    mockFetches();
    renderPage("/session-film");

    const row = await screen.findByTestId(`session-film-picker-row-${CONVERSATION_ID}`);
    fireEvent.click(row);

    await waitFor(() => {
      expect(screen.getByTestId("session-film-page")).toBeDefined();
    });
    expect(screen.getByTestId("session-film-ribbon")).toBeDefined();
  });
});

describe("SessionFilmPage — ?t= deep link (AT 3)", () => {
  test("opens the film with the playhead at the row named by ?t=", async () => {
    mockFetches();
    renderPage(`/session-film?session=${CONVERSATION_ID}&t=4`);

    await waitFor(() => {
      expect(screen.getByTestId("session-film-page")).toBeDefined();
    });

    await waitFor(() => {
      const row4 = screen.getByTestId("session-film-row-4");
      expect(row4.getAttribute("aria-current")).toBe("true");
    });
  });

  test("clamps an out-of-range ?t= to the last row rather than crashing", async () => {
    mockFetches();
    renderPage(`/session-film?session=${CONVERSATION_ID}&t=99999`);

    await waitFor(() => {
      const row9 = screen.getByTestId("session-film-row-9");
      expect(row9.getAttribute("aria-current")).toBe("true");
    });
  });
});
