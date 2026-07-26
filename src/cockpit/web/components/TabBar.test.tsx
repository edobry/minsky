/**
 * TabBar overflow + bulk-close tests (mt#3252).
 *
 * The strip's scrollbar chrome is deliberately suppressed, so before this task
 * an overflowing strip gave the operator no indicator, no count, and no way to
 * reach an off-screen tab (measured: 49 open, 9 visible, 40 unreachable). These
 * tests cover the affordances that replace the missing scrollbar.
 *
 * jsdom performs no layout — every `getBoundingClientRect` is zero — so the
 * hidden-COUNT rule is verified against `countHiddenTabs` directly (pure, rects
 * in / count out) and the live geometry is checked against the running cockpit
 * per this task's acceptance test 6. What jsdom does verify is the control's
 * presence, its listing of every open tab, and the bulk-close wiring.
 *
 * Run via: bun run test:components
 */
import { describe, test, expect, afterEach, beforeEach } from "bun:test";
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TabBar, countHiddenTabs, resolveKindIcon } from "./TabBar";
import { TabsProvider, MAX_OPEN_TABS, evictToCap, type EntityTab } from "../lib/tabs";

const STORAGE_KEY = "cockpit.tabs.v1"; // gitleaks:allow

function persistedTab(id: string): EntityTab {
  return {
    kind: "task",
    entityId: `mt#${id}`,
    path: `/tasks/mt%23${id}`,
    label: `mt#${id}`,
  };
}

function seedTabs(count: number): EntityTab[] {
  const tabs = Array.from({ length: count }, (_, i) => persistedTab(String(i + 1)));
  localStorage.setItem(STORAGE_KEY, JSON.stringify(tabs));
  return tabs;
}

function renderTabBar(initialPath: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[initialPath]}>
        <TabsProvider>
          <TabBar />
        </TabsProvider>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("countHiddenTabs — the hidden-count rule (mt#3252)", () => {
  const strip = { left: 100, right: 500 };

  test("a tab fully inside the strip is not hidden", () => {
    expect(countHiddenTabs(strip, [{ left: 150, right: 250 }])).toBe(0);
  });

  test("a tab clipped on the right counts as hidden", () => {
    expect(countHiddenTabs(strip, [{ left: 450, right: 600 }])).toBe(1);
  });

  test("a tab clipped on the left counts as hidden (the strip is scrolled)", () => {
    expect(countHiddenTabs(strip, [{ left: 20, right: 150 }])).toBe(1);
  });

  test("a tab flush with each edge is NOT counted (sub-pixel tolerance)", () => {
    expect(countHiddenTabs(strip, [{ left: 100, right: 500 }])).toBe(0);
    expect(countHiddenTabs(strip, [{ left: 99.6, right: 500.4 }])).toBe(0);
  });

  test("counts only the hidden ones in a mixed strip", () => {
    const tabs = [
      { left: 110, right: 200 },
      { left: 210, right: 300 },
      { left: 480, right: 570 },
      { left: 580, right: 670 },
    ];
    expect(countHiddenTabs(strip, tabs)).toBe(2);
  });

  test("the measured pre-fix geometry reports 40 of 49 hidden", () => {
    // 1360px strip, 127px median tab, 9 fitting — the numbers taken off the
    // running cockpit that motivated this task.
    const measuredStrip = { left: 0, right: 1360 };
    const tabs = Array.from({ length: 49 }, (_, i) => ({
      left: i * 149,
      right: i * 149 + 127,
    }));
    expect(countHiddenTabs(measuredStrip, tabs)).toBe(40);
  });

  test("an empty strip has nothing hidden", () => {
    expect(countHiddenTabs(strip, [])).toBe(0);
  });
});

describe("TabBar overflow control (mt#3252)", () => {
  test("the strip renders nothing when the working set is empty", () => {
    const { container } = renderTabBar("/");
    expect(container.querySelector('nav[aria-label="Open entities"]')).toBeNull();
  });

  test("the control is present whenever tabs exist, since it hosts bulk close", () => {
    seedTabs(2);
    renderTabBar("/tasks/mt%231");
    expect(screen.getByRole("button", { name: /Open entities: \d+ open/ })).toBeDefined();
  });

  test("the control reports no hidden count when nothing is measured out of view", () => {
    // jsdom lays nothing out, so every tab measures as visible — which is
    // exactly the "everything fits" case: the count must stay silent.
    seedTabs(3);
    renderTabBar("/tasks/mt%231");
    const trigger = screen.getByRole("button", { name: /Open entities/ });
    expect(trigger.getAttribute("aria-label")).toBe("Open entities: 3 open");
    expect(trigger.textContent).not.toContain("+");
  });

  test("opening the control lists every open tab, including ones off-screen", () => {
    seedTabs(5);
    renderTabBar("/tasks/mt%231");
    fireEvent.click(screen.getByRole("button", { name: /Open entities/ }));
    // Scoped to the popover: the same entity is also a link in the strip
    // itself, so an unscoped query would match both.
    const menu = within(screen.getByRole("dialog"));
    for (const id of ["mt#1", "mt#2", "mt#3", "mt#4", "mt#5"]) {
      expect(menu.getByRole("link", { name: id })).toBeDefined();
    }
  });

  test("each listed entry links to its own entity route", () => {
    seedTabs(3);
    renderTabBar("/tasks/mt%231");
    fireEvent.click(screen.getByRole("button", { name: /Open entities/ }));
    const menu = within(screen.getByRole("dialog"));
    expect(menu.getByRole("link", { name: "mt#3" }).getAttribute("href")).toBe("/tasks/mt%233");
  });
});

describe("TabBar bulk close (mt#3252)", () => {
  test("close all empties the strip and the persisted set", () => {
    seedTabs(4);
    const { container } = renderTabBar("/tasks/mt%231");
    fireEvent.click(screen.getByRole("button", { name: /Open entities/ }));
    fireEvent.click(screen.getByText("Close all"));
    expect(container.querySelector('nav[aria-label="Open entities"]')).toBeNull();
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null")).toEqual([]);
  });

  test("close others leaves exactly the active tab", () => {
    seedTabs(4);
    renderTabBar("/tasks/mt%232");
    fireEvent.click(screen.getByRole("button", { name: /Open entities/ }));
    fireEvent.click(screen.getByText("Close others"));
    const remaining = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]") as EntityTab[];
    expect(remaining.map((t) => t.entityId)).toEqual(["mt#2"]);
  });

  test("close others is not offered when the active tab is the only one", () => {
    seedTabs(1);
    renderTabBar("/tasks/mt%231");
    fireEvent.click(screen.getByRole("button", { name: /Open entities/ }));
    expect(screen.queryByText("Close others")).toBeNull();
    expect(screen.getByText("Close all")).toBeDefined();
  });

  test("per-tab close still works and leaves the rest standing", () => {
    seedTabs(3);
    renderTabBar("/tasks/mt%231");
    fireEvent.click(screen.getByRole("button", { name: "Close mt#3" }));
    const remaining = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]") as EntityTab[];
    expect(remaining.map((t) => t.entityId)).toEqual(["mt#1", "mt#2"]);
  });
});

describe("TabBar working-set bound at load (mt#3252)", () => {
  test("a 49-tab payload from an earlier build loads bounded to the cap", () => {
    seedTabs(49);
    renderTabBar("/tasks/mt%2349");
    const rendered = screen.getAllByRole("link", { name: /^mt#\d+$/ });
    expect(rendered).toHaveLength(MAX_OPEN_TABS);
  });

  test("the tab just navigated to survives the load-time trim", () => {
    seedTabs(49);
    renderTabBar("/tasks/mt%2349");
    expect(screen.getByRole("link", { name: "mt#49" })).toBeDefined();
  });

  test("the trimmed set is persisted, so the backlog does not return on reload", () => {
    seedTabs(49);
    renderTabBar("/tasks/mt%2349");
    const persisted = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]") as EntityTab[];
    expect(persisted).toHaveLength(MAX_OPEN_TABS);
  });
});

describe("resolveKindIcon (mt#2440 regression guard)", () => {
  test("every accepted kind resolves to a renderable component", () => {
    // lucide icons are forwardRef objects, not plain functions — assert only
    // that a component exists, since an `undefined` here is what blanked the
    // whole shell in mt#2440.
    for (const kind of ["task", "session", "agent", "ask", "memory", "changeset"] as const) {
      expect(resolveKindIcon(kind)).toBeTruthy();
    }
  });
});

// ---------------------------------------------------------------------------
// Measurement-rule regressions from the PR #2339 R1 review.
//
// Both findings below were checked against the running cockpit and refuted;
// these tests pin the behavior so the suggested "fixes" cannot land silently as
// regressions. See the countHiddenTabs / evictToCap doc comments.
// ---------------------------------------------------------------------------

describe("countHiddenTabs — the bound is the padding box (PR #2339 R1)", () => {
  // overflow-x:auto clips at the PADDING box, so the strip's (border-less)
  // bounding rect IS the clip region. Subtracting padding would narrow it below
  // the real clip and call a visible tab hidden.
  const PADDING = 4; // px-1
  const strip = { left: 100, right: 500 };

  test("a tab sitting inside the leading padding band is VISIBLE, not hidden", () => {
    // Scrolled such that the tab starts 2px into the 4px padding zone: still
    // painted, still clickable.
    const tab = { left: strip.left + 2, right: strip.left + 120 };
    expect(countHiddenTabs(strip, [tab])).toBe(0);
    // The padding-subtracting variant the review asked for would report 1 here.
    const contentBound = { left: strip.left + PADDING, right: strip.right - PADDING };
    expect(countHiddenTabs(contentBound, [tab])).toBe(1);
  });

  test("a tab sitting inside the trailing padding band is VISIBLE, not hidden", () => {
    const tab = { left: strip.right - 120, right: strip.right - 2 };
    expect(countHiddenTabs(strip, [tab])).toBe(0);
  });

  test("a tab genuinely past the clip edge is still counted", () => {
    expect(countHiddenTabs(strip, [{ left: strip.right + 6, right: strip.right + 120 }])).toBe(1);
  });
});

describe("countHiddenTabs — a partially clipped tab counts as hidden, by design", () => {
  const strip = { left: 100, right: 500 };

  test("a tab straddling an edge counts as hidden even though its midpoint is still visible", () => {
    // Midpoint 460 sits inside the strip, so a hit-test-style rule would call
    // this tab visible; its label is clipped, so the count reports it.
    const straddling = { left: 420, right: 500 + 20 };
    const midpoint = (straddling.left + straddling.right) / 2;
    expect(midpoint).toBeLessThan(strip.right);
    expect(countHiddenTabs(strip, [straddling])).toBe(1);
  });

  test("the disagreement with a midpoint rule is exactly the straddling tabs", () => {
    const tabs = [
      { left: 60, right: 160 }, // straddles the leading edge, midpoint inside
      { left: 200, right: 300 }, // fully visible
      { left: 460, right: 560 }, // straddles the trailing edge, midpoint outside
      { left: 600, right: 700 }, // fully hidden
    ];
    const midpointRule = tabs.filter((t) => {
      const mid = (t.left + t.right) / 2;
      return mid < strip.left || mid > strip.right;
    }).length;
    // The clipped-edge rule reports 3; a midpoint rule reports 2, differing on
    // the leading straddler whose midpoint (110) remains inside the strip.
    expect(countHiddenTabs(strip, tabs)).toBe(3);
    expect(midpointRule).toBe(2);
  });
});

describe("evictToCap — the over-budget case needs cap < 1 (PR #2339 R1)", () => {
  test("at any cap >= 1 the result never exceeds the cap, protected tab or not", () => {
    for (let cap = 1; cap <= 6; cap++) {
      const tabs = Array.from({ length: 20 }, (_, i) => persistedTab(String(i)));
      const withRecency = tabs.map((t, i) => ({ ...t, lastActiveAt: i }));
      const protectedPath = withRecency[0]?.path; // the COLDEST tab, worst case
      expect(evictToCap(withRecency, { cap, protectPath: protectedPath })).toHaveLength(cap);
    }
  });

  test("the documented over-cap result is reachable only at cap 0", () => {
    const tabs = [persistedTab("1"), persistedTab("2")].map((t, i) => ({ ...t, lastActiveAt: i }));
    expect(evictToCap(tabs, { cap: 0, protectPath: tabs[0]?.path })).toHaveLength(1);
    expect(evictToCap(tabs, { cap: 1, protectPath: tabs[0]?.path })).toHaveLength(1);
  });
});

describe("TabOverflowMenu trigger labelling (PR #2339 R1)", () => {
  test("the icon-only trigger carries a hover title for sighted users, matching its aria-label", () => {
    seedTabs(3);
    renderTabBar("/tasks/mt%231");
    const trigger = screen.getByRole("button", { name: /Open entities/ });
    expect(trigger.getAttribute("title")).toBe(trigger.getAttribute("aria-label"));
  });
});
