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
 * callers already degrade to an empty result for (see use-entity-index.ts),
 * UNLESS `overviewLabel` is provided (mt#3343 header-label tests), in which
 * case `/api/conversation/<id>/overview` resolves with that label.
 *
 * NOTE (mt#3343): `/api/widget/context-inspector/data` deliberately ALWAYS
 * 404s here now. The header label no longer comes from that top-50 picker
 * window — a conversation outside it used to have no name at all — so leaving
 * it unmocked is what proves the page reads its OWN record.
 */
function mockFetches(conversationId: string, opts: { overviewLabel?: string } = {}) {
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
    if (
      pathname === `/api/conversation/${encodeURIComponent(conversationId)}/overview` &&
      opts.overviewLabel !== undefined
    ) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            agentSessionId: conversationId,
            label: opts.overviewLabel,
            conversationMeta: {
              cwd: null,
              harness: "claude_code",
              startedAt: null,
              endedAt: null,
              turnCount: 0,
              relatedTaskIds: [],
              relatedPrNumbers: [],
              lastActivityAt: null,
            },
            workspace: null,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      );
    }
    return Promise.resolve(new Response("Not found", { status: 404 }));
  }) as unknown as typeof globalThis.fetch;
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
    ) as unknown as typeof globalThis.fetch;

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

describe("ConversationPage — header label from the conversation's own record (mt#2770, mt#3343)", () => {
  test("shows the label from the overview payload even when the picker window doesn't contain it", async () => {
    const conversationId = "mt3343-header-label-test";
    // No context-inspector payload is served at all — the page must still name
    // itself. This is the regression the task exists to prevent: before
    // mt#3343 the heading fell through to the raw id whenever the conversation
    // was absent from the top-50 window.
    mockFetches(conversationId, { overviewLabel: "Conversation labeling: task-binding" });

    const { findByRole } = renderConversationPage(conversationId);

    const heading = await findByRole("heading", { level: 1 });
    expect(heading.textContent).toBe("Conversation labeling: task-binding");
  });

  test("renders the id exactly once when no label resolves", async () => {
    const conversationId = "mt3343-header-label-not-found";
    mockFetches(conversationId); // no overviewLabel — /api/conversation/.../overview 404s

    const { findByRole, container } = renderConversationPage(conversationId);

    const heading = await findByRole("heading", { level: 1 });
    expect(heading.textContent).toBe(conversationId);

    // The mono sub-line exists to show the raw id ALONGSIDE a human name. When
    // the heading already IS the raw id, repeating it underneath is the
    // duplicate-uuid defect (mt#3343 SC4).
    const occurrences = Array.from(container.querySelectorAll("*")).filter(
      (el) => el.children.length === 0 && el.textContent === conversationId
    );
    expect(occurrences.length).toBe(1);
  });
});
