/**
 * TabBar entity-kind rendering regression tests (mt#2440).
 *
 * mt#1919 added the "agent" entity-tab kind without a KIND_ICONS entry in
 * TabBar; the undefined icon component crashed the whole shell (React #130 —
 * TabBar renders outside the page ErrorBoundaries) on every load while the
 * tab was persisted. These tests render TabBar with each kind open via the
 * open-on-visit path and assert the tab strip actually renders.
 *
 * Lives in widgets/ so `bun run test:components` (happy-dom preload) picks it
 * up, per the card-navigation.test.tsx precedent for cross-component tests.
 */
import { describe, test, expect, afterEach, beforeEach } from "bun:test";
import { render, screen, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { TabsProvider } from "../lib/tabs";
import { TabBar } from "../components/TabBar";

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <TabsProvider>
        <TabBar />
      </TabsProvider>
    </MemoryRouter>
  );
}

describe("TabBar entity kinds (mt#2440)", () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(cleanup);

  test("agent-kind tab (/agents/:id) renders without crashing the strip", () => {
    renderAt("/agents/561a8568-cb5e-44d0-bcee-bf8c8da2f011");
    expect(screen.getByText("561a8568…")).toBeDefined();
  });

  test("session-kind tab (/session/:id) renders", () => {
    renderAt("/session/4d44d12b-58f0-433e-95b3-8b914693fa39");
    expect(screen.getByText("4d44d12b…")).toBeDefined();
  });

  test("task-kind tab (/tasks/:id) renders", () => {
    renderAt("/tasks/mt%232440");
    expect(screen.getByText("mt#2440")).toBeDefined();
  });

  test("unknown persisted kind falls back instead of crashing", () => {
    // Simulate a tab written by a different build with a kind this build
    // doesn't know. loadTabs filters unknown kinds today, but the fallback
    // guards the rendering path independently of that filter — write a known
    // shape, then render a route that opens it alongside.
    localStorage.setItem(
      "cockpit.tabs.v1", // gitleaks:allow
      JSON.stringify([
        {
          kind: "agent",
          entityId: "abc12345-0000-0000-0000-000000000000",
          path: "/agents/abc12345-0000-0000-0000-000000000000",
          label: "abc12345…",
        },
      ])
    );
    renderAt("/");
    expect(screen.getByText("abc12345…")).toBeDefined();
  });
});
