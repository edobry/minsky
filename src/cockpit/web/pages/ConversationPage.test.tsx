/**
 * ConversationPage conversation-keyed live-tail wiring tests (mt#2749).
 *
 * Verifies ConversationPage opens the conversation-keyed live-tail SSE
 * channel (`GET /api/conversation/:id/live-tail`) directly off the URL's
 * agentSessionId — no workspace bridge — by asserting the EventSource the
 * page's ConversationView constructs points at that endpoint. Uses a stub
 * EventSource (same pattern as `lib/sse-client.test.ts`) rather than a real
 * network connection.
 *
 * Run via:
 *   bun run test:components
 *   (or) bun test --preload ./tests/dom-setup.ts --preload ./tests/setup.ts
 *        --timeout=15000 src/cockpit/web/pages/ConversationPage.test.tsx
 */
import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { render, waitFor, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ConversationPage } from "./ConversationPage";
import { TabsProvider } from "../lib/tabs";
import { TabBar } from "../components/TabBar";

// ---------------------------------------------------------------------------
// Stub EventSource (mirrors lib/sse-client.test.ts's StubEventSource)
// ---------------------------------------------------------------------------

type EventListener = (event: MessageEvent | Event) => void;

class StubEventSource {
  static instances: StubEventSource[] = [];

  url: string;
  readyState = 0;
  private listeners: Map<string, EventListener[]> = new Map();

  constructor(url: string) {
    this.url = url;
    StubEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: EventListener): void {
    const bucket = this.listeners.get(type) ?? [];
    bucket.push(listener);
    this.listeners.set(type, bucket);
  }

  removeEventListener(): void {
    // not exercised by this suite
  }

  close(): void {
    this.readyState = 2;
  }
}

let originalEventSource: typeof globalThis.EventSource;
let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  StubEventSource.instances = [];
  originalEventSource = globalThis.EventSource;
  originalFetch = globalThis.fetch;
  // @ts-expect-error — replacing EventSource with a stub for testing
  globalThis.EventSource = StubEventSource;
});

afterEach(() => {
  cleanup();
  globalThis.EventSource = originalEventSource;
  globalThis.fetch = originalFetch;
  StubEventSource.instances = [];
});

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
}

function renderConversationPage(conversationId: string) {
  const queryClient = createTestQueryClient();
  return render(
    <MemoryRouter initialEntries={[`/conversation/${conversationId}`]}>
      <QueryClientProvider client={queryClient}>
        <TabsProvider>
          <Routes>
            <Route path="/conversation/:id" element={<ConversationPage />} />
          </Routes>
        </TabsProvider>
      </QueryClientProvider>
    </MemoryRouter>
  );
}

/**
 * Minimal valid empty snapshot for the given conversation id — enough to
 * satisfy ConversationFetcher's `isSnapshot` guard. Any auxiliary fetch (task
 * ids, widget data used for entity-linkification) gets a 404, which those
 * callers already degrade to an empty result for (see use-entity-index.ts).
 */
function mockFetches(conversationId: string) {
  globalThis.fetch = mock((url: string) => {
    const pathname = typeof url === "string" ? new URL(url, "http://localhost").pathname : "";
    if (pathname === "/api/cockpit/context-inspector/snapshot") {
      return Promise.resolve(
        new Response(
          JSON.stringify({ agentSessionId: conversationId, blocks: [] }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      );
    }
    return Promise.resolve(new Response("Not found", { status: 404 }));
  }) as typeof globalThis.fetch;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ConversationPage — unresolvable id tab hygiene (mt#2769)", () => {
  test("a 404 conversation id marks its tab errored and excludes it from persistence", async () => {
    const conversationId = "mt2769-not-found-test";
    localStorage.removeItem("cockpit.tabs.v1");
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify({ error: { code: "session_not_found" } }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      }))
    ) as typeof globalThis.fetch;

    const queryClient = createTestQueryClient();
    const { getByText, getByTitle } = render(
      <MemoryRouter initialEntries={[`/conversation/${conversationId}`]}>
        <QueryClientProvider client={queryClient}>
          <TabsProvider>
            <TabBar />
            <Routes>
              <Route path="/conversation/:id" element={<ConversationPage />} />
            </Routes>
          </TabsProvider>
        </QueryClientProvider>
      </MemoryRouter>
    );

    // The error state renders (the ConversationView-level "no transcript yet" surface).
    await waitFor(() =>
      expect(getByText(/No conversation transcript for this session yet/i)).toBeDefined()
    );

    // The tab strip reflects the error (title carries "(not found)", set by markTabError).
    await waitFor(() => {
      expect(getByTitle(`${conversationId} (not found)`)).toBeDefined();
    });

    // Excluded from persistence — a reload must not resurrect this dead tab.
    const persisted = JSON.parse(localStorage.getItem("cockpit.tabs.v1") ?? "[]") as Array<{
      path: string;
    }>;
    expect(persisted.some((t) => t.path === `/conversation/${conversationId}`)).toBe(false);
  });
});

describe("ConversationPage — conversation-keyed live tail (mt#2749)", () => {
  test("opens the conversation-keyed live-tail SSE channel off the URL's agentSessionId", async () => {
    const conversationId = "mt2749-page-live-test";
    mockFetches(conversationId);

    renderConversationPage(conversationId);

    await waitFor(() => {
      expect(StubEventSource.instances.length).toBe(1);
    });
    const stub = StubEventSource.instances[0];
    expect(stub?.url).toBe(`/api/conversation/${encodeURIComponent(conversationId)}/live-tail`);
  });

  test("does NOT open the workspace-keyed channel (/api/agents/.../live-tail)", async () => {
    const conversationId = "mt2749-page-live-test-2";
    mockFetches(conversationId);

    renderConversationPage(conversationId);

    await waitFor(() => {
      expect(StubEventSource.instances.length).toBe(1);
    });
    expect(StubEventSource.instances[0]?.url).not.toContain("/api/agents/");
  });
});
