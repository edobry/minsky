/**
 * SessionFilm tests (mt#3184 AT 3, re-pointed by mt#3461).
 *
 * These moved here from the former `pages/SessionFilmPage.test.tsx` when the
 * film body was extracted from the page (that page and its test have since been
 * deleted outright — mt#3468). The `?t=` deep-link and clamping cases are the
 * ORIGINAL mt#3184 assertions, unchanged except for the route they arrive on —
 * that continuity is the point: the fold, the playhead, and the ribbon behave
 * the same after the re-hosting.
 *
 * Run via: bun test --preload ./tests/dom-setup.ts --preload ./tests/setup.ts \
 *   src/cockpit/web/components/session-film/SessionFilm.test.tsx
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { SessionFilm, parsePlayheadParam } from "./SessionFilm";

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

function mockEvents({ status = 200 }: { status?: number } = {}) {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname === "/api/cockpit/session-film/events") {
      if (status !== 200) {
        return new Response(JSON.stringify({ error: "scrub gate" }), {
          status,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({ events: fixtureEvents(), ingestedAt: "2026-07-20T00:00:00.000Z" }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

function renderFilm(initialPath: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <QueryClientProvider client={queryClient}>
        <Routes>
          <Route
            path="/conversation/:id/film"
            element={<SessionFilm conversationId={CONVERSATION_ID} />}
          />
        </Routes>
      </QueryClientProvider>
    </MemoryRouter>
  );
}

const FILM_PATH = `/conversation/${CONVERSATION_ID}/film`;

describe("parsePlayheadParam", () => {
  test("clamps into range and defaults unparsable input to 0", () => {
    expect(parsePlayheadParam("4", 10)).toBe(4);
    expect(parsePlayheadParam("99999", 10)).toBe(9);
    expect(parsePlayheadParam("-3", 10)).toBe(0);
    expect(parsePlayheadParam("banana", 10)).toBe(0);
    expect(parsePlayheadParam(null, 10)).toBe(0);
    // No rows yet — every value collapses to 0 rather than to -1.
    expect(parsePlayheadParam("4", 0)).toBe(0);
  });
});

describe("SessionFilm — renders without a picker (mt#3461 SC 1)", () => {
  test("loads the film straight from the conversation in the route", async () => {
    mockEvents();
    renderFilm(FILM_PATH);

    await waitFor(() => {
      expect(screen.getByTestId("session-film")).toBeDefined();
    });
    expect(screen.getByTestId("session-film-ribbon")).toBeDefined();
    // The picker is gone: nothing to choose, because the route already chose.
    expect(screen.queryByTestId(`session-film-picker-row-${CONVERSATION_ID}`)).toBeNull();
  });
});

describe("SessionFilm — layout balance (mt#3258 SC 4, held through the fold)", () => {
  test("the ribbon rail stays a narrow fixed width, not a proportion of the stage", async () => {
    // Asserting the Tailwind class directly: happy-dom has no layout engine, so
    // there is no real box to measure (see src/cockpit/CLAUDE.md — geometry
    // assertions belong in a CDP verify script, not here). `shrink-0` matters
    // as much as `w-64`: without it the rail can be squeezed by its flex-1
    // sibling.
    mockEvents();
    renderFilm(FILM_PATH);
    const ribbon = await screen.findByTestId("session-film-ribbon");
    expect(ribbon.className).toContain("w-64");
    expect(ribbon.className).not.toContain("w-80");
    expect(ribbon.className).toContain("shrink-0");
  });
});

describe("SessionFilm — ?t= deep link (mt#3184 AT 3, mt#3461 SC 4)", () => {
  test("opens the film with the playhead at the row named by ?t=", async () => {
    mockEvents();
    renderFilm(`${FILM_PATH}?t=4`);

    await waitFor(() => {
      const row4 = screen.getByTestId("session-film-row-4");
      expect(row4.getAttribute("aria-current")).toBe("true");
    });
  });

  test("clamps an out-of-range ?t= to the last row rather than crashing", async () => {
    mockEvents();
    renderFilm(`${FILM_PATH}?t=99999`);

    await waitFor(() => {
      const row9 = screen.getByTestId("session-film-row-9");
      expect(row9.getAttribute("aria-current")).toBe("true");
    });
  });
});

describe("SessionFilm — scrub-gated conversation (mt#3461)", () => {
  test("reports no film instead of surfacing a raw failure", async () => {
    // The picker used to keep `scrubGateOk: false` conversations unreachable by
    // disabling their row. Reachable-from-its-own-page means this error branch
    // is now the only thing between the operator and a raw fetch failure.
    mockEvents({ status: 422 });
    renderFilm(FILM_PATH);

    await waitFor(() => {
      expect(screen.getByText(/This conversation has no film/i)).toBeDefined();
    });
    expect(screen.queryByTestId("session-film")).toBeNull();
  });
});
