/**
 * Provider-level tests for the held-MRU-cycle interaction with open-on-visit
 * (mt#3469, PR #2478 R1).
 *
 * The pure ordering math lives in `tabs.cycle.test.ts`. What needs a rendered
 * provider is the interaction between the cycle's recency-stamp suppression and
 * the effect that creates tabs: those two live in the same effect, and R1 found
 * that suppressing the whole effect during a cycle silently disabled tab
 * creation for any navigation that was not itself a cycle step.
 *
 * Run via: bun run test:components
 */
import { describe, test, expect, afterEach, beforeEach } from "bun:test";
import { render, screen, cleanup, act } from "@testing-library/react";
import { MemoryRouter, useNavigate } from "react-router-dom";
import { useEffect } from "react";
import { TabsProvider, useTabs, type TabCycleDirection, type TabCycleMode } from "./tabs";

interface Api {
  paths: string[];
  recency: Record<string, number | undefined>;
  navigate: (to: string) => void;
  activateRelativeTab: (d: TabCycleDirection, m: TabCycleMode) => string | null;
  commitTabCycle: () => void;
}

let api: Api;

function Harness() {
  const { tabs, activateRelativeTab, commitTabCycle } = useTabs();
  const navigate = useNavigate();
  useEffect(() => {
    api = {
      paths: tabs.map((t) => t.path),
      recency: Object.fromEntries(tabs.map((t) => [t.path, t.lastActiveAt])),
      navigate: (to: string) => navigate(to),
      activateRelativeTab,
      commitTabCycle,
    };
  });
  return <div data-testid="paths">{tabs.map((t) => t.path).join(" ")}</div>;
}

const A = "/tasks/mt%23A";
const B = "/tasks/mt%23B";
const C = "/tasks/mt%23C";

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <TabsProvider>
        <Harness />
      </TabsProvider>
    </MemoryRouter>
  );
}

/**
 * Navigate and let the open-on-visit effect settle.
 *
 * The leading wait is load-bearing, not padding. Recency stamps come from
 * `Date.now()`, and consecutive navigations in a test complete well inside one
 * millisecond — which makes the fixture's recency order a TIE, and
 * `mruOrderedPaths` then falls back to open order (its documented tie-break).
 * A cycle step would land on a different tab depending on how the clock
 * happened to fall, which is exactly the 1-in-6 flake this replaced.
 */
async function go(to: string) {
  await new Promise((r) => setTimeout(r, 2));
  await act(async () => {
    api.navigate(to);
  });
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("open-on-visit during a held MRU cycle", () => {
  test("still creates a tab for a route visited mid-cycle (R1 regression)", async () => {
    renderAt(A);
    await go(B);
    expect(api.paths).toEqual([A, B]);

    // Open a cycle WITHOUT releasing Control — no commitTabCycle call.
    await act(async () => {
      api.activateRelativeTab("next", "mru");
    });

    // A navigation that is not a cycle step: a rail click with Control still
    // held, or any navigation after a keyup that never reached us. Before the
    // fix the effect returned early here and this tab was never created.
    await go(C);

    expect(api.paths).toContain(C);
    expect(screen.getByTestId("paths").textContent).toContain(C);
  });

  test("a mid-cycle escape ends the cycle, so recency tracking resumes", async () => {
    renderAt(A);
    await go(B);
    await act(async () => {
      api.activateRelativeTab("next", "mru");
    });
    await go(C);

    // The cycle is over: a subsequent revisit must stamp normally rather than
    // being swallowed as a "pass-through". Without the cycle being cleared, a
    // missed keyup would suppress stamping for the rest of the session.
    const before = api.recency[A];
    await new Promise((r) => setTimeout(r, 5)); // see the note in the test below
    await go(A);
    expect(api.recency[A]).toBeGreaterThan(before ?? 0);
  });

  test("a genuine cycle step still does NOT re-stamp the tab it passes through", async () => {
    renderAt(A);
    await go(B);
    await go(C);

    // Assert against the tab the step ACTUALLY landed on rather than a
    // hardcoded one: the landing depends on recency order, so hardcoding it
    // couples the test to fixture timing for no benefit.
    let landed: string | null = null;
    await act(async () => {
      landed = api.activateRelativeTab("next", "mru");
    });
    expect(landed).not.toBeNull();
    const before = api.recency[landed as unknown as string];
    if (before === undefined) throw new Error("fixture: landed tab was never stamped");

    // It is a real cycle step, so it must keep its recency or the frozen order
    // would re-sort underneath the next press.
    await new Promise((r) => setTimeout(r, 5));
    expect(api.recency[landed as unknown as string]).toBe(before);
  });

  test("commitTabCycle stamps the landed tab", async () => {
    renderAt(A);
    await go(B);
    await go(C);

    let landed: string | null = null;
    await act(async () => {
      landed = api.activateRelativeTab("next", "mru");
    });
    expect(landed).not.toBeNull();
    const before = api.recency[landed as unknown as string] ?? 0;

    // Let the clock advance: without it a correct `Date.now()` stamp is
    // indistinguishable from no stamp at all, and the assertion would have to
    // weaken to `toBeGreaterThanOrEqual` — which also passes when
    // commitTabCycle does nothing.
    await new Promise((r) => setTimeout(r, 5));
    await act(async () => {
      api.commitTabCycle();
    });

    expect(api.recency[landed as unknown as string]).toBeGreaterThan(before);
  });
});
