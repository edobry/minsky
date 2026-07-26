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
import { TabsProvider, MAX_OPEN_TABS, type EntityTab } from "../lib/tabs";

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
