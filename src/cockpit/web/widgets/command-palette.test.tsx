/**
 * CommandPalette entity-tab routing tests (mt#2399).
 *
 * Pins the shell-C behaviors: ⌘K opens the transient overlay; nothing renders
 * until the operator types (no recents-as-default); selecting an entity lands
 * on its URL-addressable detail route (%23-encoded for mt#X ids), which the
 * tab model turns into an entity tab on visit.
 *
 * Lives in widgets/ so `bun run test:components` picks it up, per the
 * cross-component test precedent (tab-bar-kinds, ask-page-settle).
 */
import { describe, test, expect, afterEach, beforeEach } from "bun:test";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TabsProvider } from "../lib/tabs";
import { TabBar } from "../components/TabBar";
import { CommandPalette } from "../components/CommandPalette";

function LocationProbe() {
  const { pathname } = useLocation();
  return <div data-testid="location">{pathname}</div>;
}

function renderPalette() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/"]}>
        <TabsProvider>
          <TabBar />
          <LocationProbe />
          <CommandPalette />
        </TabsProvider>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

function openPalette() {
  fireEvent.keyDown(window, { key: "k", metaKey: true });
}

describe("CommandPalette (mt#2399)", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    localStorage.clear();
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/tasks")) {
        return new Response(
          JSON.stringify({
            tasks: [{ id: "mt#2320", title: "Palette fixture task", status: "TODO" }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url.startsWith("/api/widget/agents/data")) {
        return new Response(
          JSON.stringify({
            state: "ok",
            payload: {
              agents: [
                {
                  sessionId: "11112222-0000-0000-0000-000000000000",
                  taskId: "mt#2321",
                  taskTitle: "Session fixture title",
                  liveness: "healthy",
                },
              ],
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url.startsWith("/api/widget/attention/data")) {
        return new Response(
          JSON.stringify({
            state: "ok",
            payload: {
              cohort: [
                {
                  id: "55556666-0000-0000-0000-000000000000",
                  title: "Palette fixture ask",
                  kind: "direction.decide",
                  parentTaskId: "mt#2320",
                },
              ],
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url.startsWith("/api/widget/memories-list/data")) {
        return new Response(
          JSON.stringify({
            state: "ok",
            payload: {
              records: [
                {
                  id: "33334444-0000-0000-0000-000000000000",
                  name: "Palette fixture memory",
                  type: "project",
                },
              ],
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      throw new Error(`Unexpected fetch in test: ${url}`);
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    cleanup();
  });

  test("⌘K opens; nothing renders until typing", async () => {
    renderPalette();
    openPalette();

    await waitFor(() =>
      expect(screen.getByPlaceholderText(/Search tasks, sessions/)).toBeDefined()
    );
    expect(screen.getByText("Type to search…")).toBeDefined();
    // No groups, no entities — even though the sources have data.
    expect(screen.queryByText("Pages")).toBeNull();
    expect(screen.queryByText("Palette fixture task")).toBeNull();
    expect(screen.queryByText(/Recent/)).toBeNull();
  });

  test("typing surfaces entities; selecting a task lands on /tasks/:id (%23-encoded)", async () => {
    renderPalette();
    openPalette();

    const input = await screen.findByPlaceholderText(/Search tasks, sessions/);
    fireEvent.change(input, { target: { value: "2320" } });

    const taskItem = await screen.findByText("Palette fixture task", undefined, {
      timeout: 3000,
    });
    fireEvent.click(taskItem);

    await waitFor(() => {
      expect(screen.getByTestId("location").textContent).toBe("/tasks/mt%232320");
    });
    // The visit opened a task entity tab.
    expect(screen.getByText("mt#2320")).toBeDefined();
  });

  test("selecting an ask lands on /ask/:id and opens its tab", async () => {
    renderPalette();
    openPalette();

    const input = await screen.findByPlaceholderText(/Search tasks, sessions/);
    fireEvent.change(input, { target: { value: "fixture ask" } });

    const askItem = await screen.findByText("Palette fixture ask", undefined, { timeout: 3000 });
    fireEvent.click(askItem);

    await waitFor(() => {
      expect(screen.getByTestId("location").textContent).toBe(
        "/ask/55556666-0000-0000-0000-000000000000"
      );
    });
    // The visit opened an ask entity tab (short-id label).
    expect(screen.getByText("55556666…")).toBeDefined();
  });

  test("selecting a memory lands on /memory/:id", async () => {
    renderPalette();
    openPalette();

    const input = await screen.findByPlaceholderText(/Search tasks, sessions/);
    fireEvent.change(input, { target: { value: "fixture memory" } });

    const memoryItem = await screen.findByText("Palette fixture memory", undefined, {
      timeout: 3000,
    });
    fireEvent.click(memoryItem);

    await waitFor(() => {
      expect(screen.getByTestId("location").textContent).toBe(
        "/memory/33334444-0000-0000-0000-000000000000"
      );
    });
  });

  test("selecting a session lands on the workspace-session detail /agents/:id", async () => {
    renderPalette();
    openPalette();

    const input = await screen.findByPlaceholderText(/Search tasks, sessions/);
    fireEvent.change(input, { target: { value: "11112222" } });

    const sessionItem = await screen.findByText("Session fixture title", undefined, {
      timeout: 3000,
    });
    fireEvent.click(sessionItem);

    await waitFor(() => {
      expect(screen.getByTestId("location").textContent).toBe(
        "/agents/11112222-0000-0000-0000-000000000000"
      );
    });
  });
});
