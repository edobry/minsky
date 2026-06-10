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
import { TabBar, resolveKindIcon } from "../components/TabBar";

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

  test("persisted agent-kind tab renders on an unrelated route (the mt#2440 crash shape)", () => {
    // The originating incident: an agent tab already in localStorage blanked
    // the shell on EVERY route, not just /agents/:id. loadTabs accepts the
    // kind; rendering must not crash.
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

  test("resolveKindIcon falls back for a kind missing from the icon map", () => {
    // The realistic gap: a kind the loader accepts but the map doesn't carry
    // (how mt#2440 happened). An unmapped kind must resolve to a component,
    // never undefined. (Lucide icons are forwardRef components — typeof
    // "object" — so assert defined-ness, which is what React #130 is about.)
    const icon = resolveKindIcon("pr" as Parameters<typeof resolveKindIcon>[0]);
    expect(icon).toBeDefined();
    expect(icon).not.toBeNull();
    // Known kinds resolve to defined components too.
    expect(resolveKindIcon("agent")).toBeDefined();
    expect(resolveKindIcon("task")).toBeDefined();
    expect(resolveKindIcon("session")).toBeDefined();
  });
});