/**
 * TabCloseBridge tests (mt#4059).
 *
 * The tray's ⌘W menu item reaches the SPA by `eval`-ing
 * `window.__minskyCloseActiveTab` (ADR-023). These tests exercise the SPA half
 * of that seam by calling the global directly — which is exactly what the
 * evaluated script does, so the call site under test is the real one.
 *
 * What they deliberately do NOT cover: that macOS delivers ⌘W to the menu item
 * at all. That is native-runtime behavior in WKWebView, invisible to happy-dom,
 * and is verified by hand against the installed tray app (see the task's
 * acceptance tests, and mt#3475 for the sibling question about the tab-switching
 * chords).
 *
 * Run via: bun run test:components
 */
import { describe, test, expect, afterEach, beforeEach } from "bun:test";
import { render, screen, cleanup, act } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TabBar } from "./TabBar";
import { TabCloseBridge } from "./TabCloseBridge";
import { TabsProvider, type EntityTab } from "../lib/tabs";

const STORAGE_KEY = "cockpit.tabs.v1"; // gitleaks:allow

function persistedTab(id: string): EntityTab {
  return {
    kind: "task",
    entityId: `mt#${id}`,
    path: `/tasks/mt%23${id}`,
    label: `mt#${id}`,
  };
}

function seedTabs(ids: string[]): EntityTab[] {
  const tabs = ids.map(persistedTab);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(tabs));
  return tabs;
}

function renderBridge(initialPath: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[initialPath]}>
        <TabsProvider>
          <TabBar />
          <TabCloseBridge />
        </TabsProvider>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

/** Invoke the global the way `menu.rs eval_close_active_tab` does. */
function pressCloseTab(): void {
  act(() => {
    window.__minskyCloseActiveTab?.();
  });
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  delete window.__minskyCloseActiveTab;
});

describe("TabCloseBridge — the ⌘W seam (mt#4059)", () => {
  test("installs the global the tray evals", () => {
    seedTabs(["100", "200"]);
    renderBridge("/tasks/mt%23100");

    expect(typeof window.__minskyCloseActiveTab).toBe("function");
  });

  test("closes the ACTIVE tab and leaves the others open", () => {
    seedTabs(["100", "200"]);
    renderBridge("/tasks/mt%23100");

    expect(screen.getByText("mt#100")).toBeDefined();

    pressCloseTab();

    expect(screen.queryByText("mt#100")).toBeNull();
    expect(screen.getByText("mt#200")).toBeDefined();
  });

  test("no-ops on a non-entity route rather than closing something arbitrary", () => {
    seedTabs(["100", "200"]);
    // A list route opens no tab, so there is nothing in view to close — the
    // tray side must not fall through to closing the window either.
    renderBridge("/tasks");

    pressCloseTab();

    expect(screen.getByText("mt#100")).toBeDefined();
    expect(screen.getByText("mt#200")).toBeDefined();
  });

  test("closing the last tab is safe and empties the strip", () => {
    seedTabs(["100"]);
    renderBridge("/tasks/mt%23100");

    pressCloseTab();

    expect(screen.queryByText("mt#100")).toBeNull();
  });

  test("removes the global on unmount so no stale closure survives", () => {
    seedTabs(["100"]);
    const { unmount } = renderBridge("/tasks/mt%23100");

    expect(typeof window.__minskyCloseActiveTab).toBe("function");
    unmount();
    expect(window.__minskyCloseActiveTab).toBeUndefined();
  });
});
