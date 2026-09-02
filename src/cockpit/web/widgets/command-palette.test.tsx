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
import { NewConversationProvider } from "../hooks/useNewConversation";
import { ProjectProvider } from "../lib/project-context";

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
        <ProjectProvider>
          <TabsProvider>
            {/* The palette carries actions as of mt#3464, so it now requires
                the same provider Layout mounts around the whole shell. */}
            <NewConversationProvider>
              <TabBar />
              <LocationProbe />
              <CommandPalette />
            </NewConversationProvider>
          </TabsProvider>
        </ProjectProvider>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

function openPalette() {
  fireEvent.keyDown(window, { key: "k", metaKey: true });
}

describe("CommandPalette (mt#2399)", () => {
  const originalFetch = globalThis.fetch;
  /** Every `/api/asks*` URL the palette requested this test (mt#4095). */
  let askUrls: string[] = [];

  beforeEach(() => {
    localStorage.clear();
    askUrls = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/asks")) askUrls.push(url);
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
      // The palette's ask source since mt#4095. It used to read the attention
      // widget's cohort below, which carries PENDING operator asks only — so a
      // resolved ask could never be found by a surface that advertises search.
      // The fixture therefore includes a terminal ask alongside the pending one.
      if (url.startsWith("/api/asks?")) {
        return new Response(
          JSON.stringify({
            asks: [
              {
                id: "55556666-0000-0000-0000-000000000000",
                shortId: "ask#2399",
                title: "Palette fixture ask",
                kind: "direction.decide",
                state: "suspended",
                parentTaskId: "mt#2320",
              },
              {
                id: "77778888-0000-0000-0000-000000000000",
                shortId: "ask#7754",
                title: "Paste the Supabase service_role key",
                kind: "direction.decide",
                state: "closed",
                parentTaskId: null,
              },
            ],
            total: 2,
            returned: 2,
            truncated: false,
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
    }) as unknown as typeof fetch;
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
    // The visit opened a task entity tab — enriched to anchor + title via the
    // shared entity-label resolver (mt#2883; the task index is in the shared
    // query cache from the palette's own fetch).
    expect(screen.getByText("mt#2320 · Palette fixture task")).toBeDefined();
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
    // The visit opened an ask entity tab — enriched to the ask subject via
    // the shared resolver (mt#2883; the attention cohort is in the shared
    // query cache from the palette's own fetch). The palette dialog closed on
    // selection, so the only "Palette fixture ask" text left is the tab's.
    expect(screen.getByText("Palette fixture ask")).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // Reaching a RESOLVED ask (mt#4095)
  //
  // The palette advertises "Search tasks, sessions, conversations, asks,
  // memories, pages..." and could not find an ask the operator had already
  // resolved — which is exactly when someone reaches for search. Its source was
  // the attention widget's pending-only cohort.
  // -------------------------------------------------------------------------

  test("the palette actually REQUESTS terminal asks, not just pending ones", async () => {
    // Without this, every assertion below is satisfied by a fixture that
    // returns terminal asks regardless of what was asked for — the test would
    // pass against a palette that still requests the pending queue only.
    renderPalette();
    openPalette();
    await screen.findByPlaceholderText(/Search tasks, sessions/);

    await waitFor(() => expect(askUrls.length).toBeGreaterThan(0));
    const listUrl = askUrls.find((u) => u.startsWith("/api/asks?")) ?? "";
    const state = new URLSearchParams(listUrl.split("?")[1] ?? "").get("state") ?? "";
    expect(state.split(",")).toContain("terminal");
    expect(state.split(",")).toContain("suspended");
  });

  test("a CLOSED ask is findable by its ask#N short id", async () => {
    renderPalette();
    openPalette();

    const input = await screen.findByPlaceholderText(/Search tasks, sessions/);
    fireEvent.change(input, { target: { value: "ask#7754" } });

    // cmdk filters on each item's `value`, so this can only match if the short
    // id is IN that string — which it was not before mt#4095.
    const askItem = await screen.findByText("Paste the Supabase service_role key", undefined, {
      timeout: 3000,
    });
    expect(askItem).toBeDefined();
  });

  test("a CLOSED ask is findable by a word from its title", async () => {
    renderPalette();
    openPalette();

    const input = await screen.findByPlaceholderText(/Search tasks, sessions/);
    fireEvent.change(input, { target: { value: "service_role" } });

    const askItem = await screen.findByText("Paste the Supabase service_role key", undefined, {
      timeout: 3000,
    });
    expect(askItem).toBeDefined();
  });

  test("selecting a CLOSED ask lands on its uuid route, not its short id", async () => {
    renderPalette();
    openPalette();

    const input = await screen.findByPlaceholderText(/Search tasks, sessions/);
    fireEvent.change(input, { target: { value: "ask#7754" } });

    const askItem = await screen.findByText("Paste the Supabase service_role key", undefined, {
      timeout: 3000,
    });
    fireEvent.click(askItem);

    // ADR-029: the uuid is the sole deeplink target. The palette may ACCEPT
    // `ask#N` as input; it must never navigate to it.
    await waitFor(() => {
      expect(screen.getByTestId("location").textContent).toBe(
        "/ask/77778888-0000-0000-0000-000000000000"
      );
    });
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
