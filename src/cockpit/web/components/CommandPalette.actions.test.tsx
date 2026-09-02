/**
 * CommandPalette Actions-group tests (mt#3464).
 *
 * The sibling `CommandPalette.test.ts` pins the NAVIGATION contract at the
 * codec level without a DOM. This file renders the real component, because
 * what it verifies — that an action RUNS instead of navigating — is behavior
 * the codec has nothing to say about.
 *
 * Entity queries are mocked to empty payloads: they are irrelevant here, and
 * an unmocked fetch would leave the palette perpetually loading.
 */
import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { CommandPalette } from "./CommandPalette";
import { NewConversationProvider } from "../hooks/useNewConversation";
import { ProjectProvider } from "../lib/project-context";

function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
}

function renderPalette() {
  return render(
    <QueryClientProvider client={createTestQueryClient()}>
      <MemoryRouter>
        <ProjectProvider>
          <NewConversationProvider>
            <CommandPalette />
          </NewConversationProvider>
        </ProjectProvider>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

let launches: string[] = [];
let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  launches = [];
  globalThis.fetch = mock(async (url: unknown, init?: RequestInit) => {
    const href = String(url);
    if (href.includes("/api/driven-session")) {
      launches.push(typeof init?.body === "string" ? init.body : "");
      return new Response(JSON.stringify({ sessionId: "sess-1", cwd: "/repo" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    // Every entity source: a well-formed but empty payload.
    return new Response(JSON.stringify({ state: "ok", payload: {} }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof globalThis.fetch;
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

/** Open with ⌘K and type `query` into the palette input. */
async function openAndType(query: string) {
  fireEvent.keyDown(window, { key: "k", metaKey: true });
  const input = await screen.findByPlaceholderText(/Search tasks/);
  fireEvent.change(input, { target: { value: query } });
  return input;
}

describe("CommandPalette — Actions group", () => {
  test("nothing renders before the operator types (unchanged by the Actions group)", async () => {
    renderPalette();
    fireEvent.keyDown(window, { key: "k", metaKey: true });

    expect(await screen.findByText("Type to search…")).toBeDefined();
    expect(screen.queryByText("Actions")).toBeNull();
  });

  test("typing 'new' surfaces the New conversation action with its shortcut hint", async () => {
    renderPalette();
    await openAndType("new");

    await waitFor(() => expect(screen.getByText("Actions")).toBeDefined());
    expect(screen.getByText("New conversation")).toBeDefined();
    // Teach-the-shortcut: the palette is where the chord is discovered.
    expect(screen.getByText("⌘⇧O")).toBeDefined();
  });

  test("the action is reachable by its description text, not just its label", async () => {
    renderPalette();
    await openAndType("start an agent");

    await waitFor(() => expect(screen.getByText("New conversation")).toBeDefined());
  });

  test("selecting the action LAUNCHES rather than navigating", async () => {
    renderPalette();
    await openAndType("new");

    const item = await screen.findByText("New conversation");
    fireEvent.click(item);

    await waitFor(() => expect(launches.length).toBe(1));
    expect(JSON.parse(launches[0]!)).toEqual({});
  });
});
