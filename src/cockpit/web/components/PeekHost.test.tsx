/**
 * Tests for the entity side peek (mt#3694) — EntityRef click → PeekHost.
 *
 * These exercise the seam that actually matters and that the pure codec tests
 * (`lib/peek-codec.test.ts`) cannot reach: a real click on a real `EntityRef`
 * inside a router, and what the shell does with it. The task's acceptance
 * tests are cited by number in the test names.
 *
 * The strongest assertion here is AT1's second half — that peeking does NOT
 * open a tab. That is the whole reason a peek could not be built as a route
 * change, and it is invisible to every other check in the suite.
 */
import { describe, test, expect, afterEach, beforeEach, mock } from "bun:test";
import { render, cleanup, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter, Routes, Route, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { EntityRef } from "./EntityRef";
import { PeekHost } from "./PeekHost";
import { TabsProvider } from "../lib/tabs";
import { PEEKABLE_WITH_BODY } from "./PeekBody";
import { ROUTABLE_ENTITY_TYPES } from "../lib/entity-codec";

const originalFetch = global.fetch;

beforeEach(() => {
  localStorage.clear();
  // Every label / detail lookup degrades safely — these tests are about the
  // peek mechanism, not about any particular entity's payload.
  global.fetch = mock(
    async () => ({ ok: true, json: async () => ({ state: "degraded", reason: "not mocked" }) })
  ) as unknown as typeof fetch;
});

afterEach(() => {
  cleanup();
  global.fetch = originalFetch;
  localStorage.clear();
});

/** Surfaces the live location so tests can assert the URL contract directly. */
function LocationProbe() {
  const location = useLocation();
  return (
    <output data-testid="location">{`${location.pathname}${location.search}`}</output>
  );
}

function renderShell(initialEntries: string[] = ["/tasks/mt%232370"]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={initialEntries}>
        <TabsProvider>
          <Routes>
            <Route
              path="*"
              element={
                <div>
                  <h1>Underlying page</h1>
                  <EntityRef type="task" id="mt#3694" />
                  <EntityRef type="memory" id="fbcb360f-fe0e-402d-9b35-7e3c2b2ab59a" />
                  <LocationProbe />
                  <PeekHost />
                </div>
              }
            />
          </Routes>
        </TabsProvider>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

function taskRef() {
  return screen.getAllByRole("link").find((el) => el.textContent?.includes("mt#3694"))!;
}
function memoryRef() {
  return screen.getAllByRole("link").find((el) => el.textContent?.includes("fbcb360f"))!;
}

describe("AT1 — an ordinary click peeks without navigating or opening a tab", () => {
  test("renders a pane, leaves the underlying page mounted, and adds no tab", async () => {
    renderShell();
    expect(screen.queryByTestId("peek-host")).toBeNull();

    fireEvent.click(taskRef(), { button: 0 });

    const pane = await screen.findByTestId("peek-pane");
    expect(pane.getAttribute("data-peek-type")).toBe("task");
    expect(pane.getAttribute("data-peek-id")).toBe("mt#3694");

    // The page behind is still mounted — this is the point of a peek.
    expect(screen.getByText("Underlying page")).toBeTruthy();

    // ...and the pathname never changed, which is WHY it is still mounted and
    // why TabsProvider's open-on-visit effect (keyed on pathname) cannot fire.
    // The id is percent-encoded inside the value AND by URLSearchParams, so
    // `mt#3694` → `mt%233694` → `mt%25233694`. AT3 below loads this exact URL
    // back and gets the same pane, which is what makes the double pass safe.
    expect(screen.getByTestId("location").textContent).toBe(
      "/tasks/mt%232370?peek=task%3Amt%25233694"
    );

    // The persisted tab set is untouched. A route change would have added one.
    expect(localStorage.getItem("minsky.cockpit.tabs")).toBeNull();
  });
});

describe("AT2 — Esc closes the peek and clears the parameter", () => {
  test("removes the pane and leaves no ?peek= residue in the URL", async () => {
    renderShell();
    fireEvent.click(taskRef(), { button: 0 });
    await screen.findByTestId("peek-pane");

    fireEvent.keyDown(document, { key: "Escape" });

    await waitFor(() => expect(screen.queryByTestId("peek-pane")).toBeNull());
    expect(screen.getByTestId("location").textContent).toBe("/tasks/mt%232370");
  });
});

describe("AT3 — a peeked URL is addressable", () => {
  test("loading a URL that already carries ?peek= opens that pane", async () => {
    renderShell(["/tasks/mt%232370?peek=task%3Amt%25233694"]);
    const pane = await screen.findByTestId("peek-pane");
    expect(pane.getAttribute("data-peek-id")).toBe("mt#3694");
  });
});

describe("AT4 — the promote gesture still navigates", () => {
  test("Cmd-click is left to the browser rather than peeked", async () => {
    renderShell();
    fireEvent.click(taskRef(), { button: 0, metaKey: true });
    // No pane, and no peek param — the anchor's own navigation is untouched.
    expect(screen.queryByTestId("peek-pane")).toBeNull();
    expect(screen.getByTestId("location").textContent).not.toContain("peek=");
  });

  test("middle-click is left to the browser too", () => {
    renderShell();
    fireEvent.click(taskRef(), { button: 1 });
    expect(screen.queryByTestId("peek-pane")).toBeNull();
  });
});

describe("AT5 — clicking a ref REPLACES, holding makes the next one land beside", () => {
  test("a second ordinary click replaces the pane rather than stacking", async () => {
    renderShell();
    fireEvent.click(taskRef(), { button: 0 });
    await screen.findByTestId("peek-pane");

    fireEvent.click(memoryRef(), { button: 0 });

    await waitFor(() => {
      const panes = screen.getAllByTestId("peek-pane");
      expect(panes).toHaveLength(1);
      expect(panes[0]?.getAttribute("data-peek-type")).toBe("memory");
    });

    // Assert the URL too, not just the pane count: "replaced the task pane"
    // and "never had a task pane" both render one memory pane, so the count
    // alone does not discriminate between a working replace and a controller
    // that lost its state between clicks.
    // Scoped to the parameter, not the whole URL — the pathname here is
    // `/tasks/...`, so a bare "task" substring check matches the page we are
    // peeking FROM and would pass no matter what the peek did.
    const loc = screen.getByTestId("location").textContent ?? "";
    expect(loc).toContain("peek=memory");
    expect(loc).not.toContain("peek=task");
  });

  test("shift-click holds the current pane so the next opens beside it", async () => {
    renderShell();
    fireEvent.click(taskRef(), { button: 0 });
    await screen.findByTestId("peek-pane");

    // Shift-click is the hold gesture: it keeps what is on screen and opens
    // the new entity alongside it.
    fireEvent.click(memoryRef(), { button: 0, shiftKey: true });

    await waitFor(() => {
      const panes = screen.getAllByTestId("peek-pane");
      expect(panes).toHaveLength(2);
      expect(panes[0]?.getAttribute("data-peek-type")).toBe("task");
      expect(panes[0]?.getAttribute("data-peek-held")).toBe("true");
      expect(panes[1]?.getAttribute("data-peek-type")).toBe("memory");
    });
  });
});

describe("AT6 — every routable type is accounted for", () => {
  test("the with-body list is a subset of the routable types, with no unknown entries", () => {
    for (const type of PEEKABLE_WITH_BODY) {
      expect(ROUTABLE_ENTITY_TYPES).toContain(type);
    }
  });

  test("PEEKABLE_WITH_BODY pins the current split so a new adapter is a deliberate edit", () => {
    // This is the coverage ratchet the spec asks for. It fails when a routable
    // type is ADDED (the total moves) or when an adapter lands without being
    // declared — either way, the gap surfaces here rather than as a blank pane.
    expect([...PEEKABLE_WITH_BODY].sort()).toEqual(["changeset", "memory", "task"]);
    expect(ROUTABLE_ENTITY_TYPES).toHaveLength(7);
  });
});
