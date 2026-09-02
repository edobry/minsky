/**
 * Catch-all route tests (mt#3470).
 *
 * Pins two things:
 *
 *  1. An unmatched path renders the not-found surface, naming the path, with
 *     the shell still around it. The bug this replaces was measurable as
 *     `main.innerHTML.length === 0` against the running cockpit — the shell
 *     rendered and `<main>` was literally empty.
 *  2. No currently-registered route falls through to the catch-all. React
 *     Router v7 ranks route branches by computed score rather than declaration
 *     order (`splatPenalty = -2` puts a splat below every concrete route), so
 *     this is the property worth asserting; "the catch-all is declared last"
 *     would pin a placement that isn't what makes it safe.
 *
 * Mounts the REAL <App/> rather than a hand-built route table, because a
 * fixture route table would only prove the fixture ranks correctly. Lazy page
 * chunks never have to resolve for these assertions: on first render a lazy
 * route suspends and the Suspense fallback fills `<main>`, which is already
 * the "did not fall through" signal. `/` is included deliberately — HomePage
 * is the one eagerly-imported page, so it exercises the non-suspending shape.
 *
 * Network is stubbed (Layout's Rail and ProjectProvider fetch on mount) per
 * the save-mock-restore convention in Layout.test.tsx — a component test must
 * not depend on a live daemon.
 *
 * Run via: bun run test:components
 */
import { describe, test, expect, afterEach, beforeEach, mock } from "bun:test";
import { render, screen, within, waitFor, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ProjectProvider } from "../lib/project-context";
import { stubProjectsRoute } from "../lib/test-support/projects";
import { App } from "../App";

/**
 * happy-dom ships no EventSource, and mounting <App/> opens the cockpit SSE
 * channel on mount (App.tsx -> lib/sse-client.ts). Inert stub: these tests are
 * about route matching, and nothing here asserts on pushed events. Kept local
 * rather than in tests/dom-setup.ts so a future SSE-behavior test isn't handed
 * a silently-inert global.
 */
class InertEventSource {
  addEventListener(): void {}
  removeEventListener(): void {}
  close(): void {}
}

let originalFetch: typeof globalThis.fetch;
let originalEventSource: typeof globalThis.EventSource | undefined;

beforeEach(() => {
  originalEventSource = globalThis.EventSource;
  globalThis.EventSource = InertEventSource as unknown as typeof globalThis.EventSource;
  originalFetch = globalThis.fetch;
  globalThis.fetch = mock(() =>
    Promise.resolve(
      new Response(JSON.stringify({ projects: [], tasks: [], asks: [], widgets: [], count: 0 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    )
  ) as unknown as typeof globalThis.fetch;
  stubProjectsRoute();
  try {
    localStorage.clear();
  } catch {
    /* happy-dom always provides localStorage; ignore if not */
  }
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  globalThis.EventSource = originalEventSource as typeof globalThis.EventSource;
});

function renderAt(path: string) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <ProjectProvider>
          <App />
        </ProjectProvider>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe("unmatched route (mt#3470)", () => {
  test("renders the not-found surface instead of an empty main", () => {
    renderAt("/this-route-does-not-exist-xyz");

    expect(screen.queryByTestId("not-found-page")).not.toBeNull();
    // The literal inverse of the measured defect: <main> was empty.
    expect(screen.getByRole("main").innerHTML.length).toBeGreaterThan(0);
  });

  test("names the path that did not resolve", () => {
    renderAt("/this-route-does-not-exist-xyz");

    expect(screen.getByTestId("not-found-path").textContent).toBe("/this-route-does-not-exist-xyz");
  });

  test("keeps the shell around it", () => {
    renderAt("/this-route-does-not-exist-xyz");

    expect(screen.getByRole("main")).not.toBeNull();
    expect(screen.getByRole("navigation", { name: "Sections" })).not.toBeNull();
  });

  test("offers a route onward rather than redirecting", () => {
    renderAt("/this-route-does-not-exist-xyz");

    const surface = screen.getByTestId("not-found-page");
    // Scoped to the surface: the Rail also carries section links.
    expect(within(surface).getByRole("link").getAttribute("href")).toBe("/");
    // A redirect would have replaced the surface entirely; it must still be here.
    expect(screen.queryByTestId("not-found-page")).not.toBeNull();
  });

  test("names a deep unmatched path, not just a top-level one", () => {
    renderAt("/agents/nope/not-a-tab");

    expect(screen.getByTestId("not-found-path").textContent).toBe("/agents/nope/not-a-tab");
  });
});

/**
 * One entry per registered route SHAPE, not per route: a static top-level path,
 * a dynamic segment, a literal sub-route, a nested index, a nested literal
 * child, and the two retired-route redirect shapes. `/plant` is deliberately
 * absent — react-flow measures the DOM and does not render meaningfully under
 * happy-dom (see src/cockpit/CLAUDE.md §react-flow height trap).
 */
const REGISTERED_ROUTES: Array<[label: string, path: string]> = [
  ["home (eager, does not suspend)", "/"],
  ["static top-level", "/agents"],
  ["dynamic segment", "/agents/4d44d12b-58f0-433e-95b3-8b914693fa39"],
  ["dynamic segment with literal sub-route", "/agents/4d44d12b/context"],
  ["nested index", "/tasks"],
  ["nested literal child", "/tasks/graph"],
  ["nested dynamic child", "/tasks/mt%233470"],
  ["list surface", "/asks"],
  ["utility surface", "/settings"],
  ["phone view", "/vitals"],
  ["retired-route redirect", "/context"],
  ["legacy id redirect", "/session/4d44d12b"],
];

describe("registered routes do not fall through to the catch-all (mt#3470)", () => {
  for (const [label, path] of REGISTERED_ROUTES) {
    test(`${label}: ${path}`, async () => {
      renderAt(path);

      // Guards the catch-all assertion below from passing vacuously: "the
      // catch-all did not render" would also hold if NOTHING rendered, which
      // is the very defect this task fixes. A matched lazy route fills main
      // with the Suspense fallback; a matched eager route fills it with the
      // page. `waitFor` covers the redirect shapes, whose <Navigate> renders
      // null for one tick before the destination route takes over.
      await waitFor(() => {
        expect(screen.getByRole("main").innerHTML.length).toBeGreaterThan(0);
      });
      expect(screen.queryByTestId("not-found-page")).toBeNull();
    });
  }
});
