/**
 * Pinned run-detail chrome + tail-mounted activity readout (mt#3344).
 *
 * Covers the task's AT1-AT3. AT4 (the live check that the pinned bar actually
 * stays in the viewport while the transcript scrolls) is deliberately NOT here:
 * jsdom does not lay out or scroll, so `position: sticky` has no observable
 * effect in this environment. What IS checkable here — and is the part that
 * regressed historically — is the STRUCTURE the sticky behavior depends on:
 * that the header and the tab strip live inside ONE pinned container carrying
 * the positioning + opaque-background classes, and that the activity readout
 * has left that container for the transcript tail.
 *
 * Run via:
 *   bun run test:components
 *   (or) bun test --preload ./tests/dom-setup.ts --preload ./tests/setup.ts
 *        --timeout=15000 src/cockpit/web/pages/ConversationPage.chrome.test.tsx
 */
import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { render, waitFor, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ConversationPage } from "./ConversationPage";
import { TabsProvider } from "../lib/tabs";

const CONVERSATION_ID = "mt3344-chrome-test";

type EventListener = (event: MessageEvent | Event) => void;

/** The live-tail channel is irrelevant here; a stub keeps it from opening. */
class StubEventSource {
  url: string;
  readyState = 0;
  constructor(url: string) {
    this.url = url;
  }
  addEventListener(_type: string, _listener: EventListener): void {}
  removeEventListener(): void {}
  close(): void {
    this.readyState = 2;
  }
}

let originalEventSource: typeof globalThis.EventSource;
let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalEventSource = globalThis.EventSource;
  originalFetch = globalThis.fetch;
  // @ts-expect-error — replacing EventSource with a stub for testing
  globalThis.EventSource = StubEventSource;
});

afterEach(() => {
  cleanup();
  globalThis.EventSource = originalEventSource;
  globalThis.fetch = originalFetch;
});

function createTestQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
}

/**
 * A LIVE presence payload mid-tool-call — the one state that produces BOTH a
 * presence value and an activity sub-line, which is what AT2/AT3 need in order
 * to assert the two land in different places.
 */
function mockFetches(opts: { presence?: Record<string, unknown> } = {}) {
  globalThis.fetch = mock((url: string) => {
    const pathname = typeof url === "string" ? new URL(url, "http://localhost").pathname : "";

    if (pathname === "/api/cockpit/context-inspector/snapshot") {
      return Promise.resolve(
        new Response(JSON.stringify({ agentSessionId: CONVERSATION_ID, blocks: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      );
    }

    if (pathname === `/api/conversation/${encodeURIComponent(CONVERSATION_ID)}/overview`) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            agentSessionId: CONVERSATION_ID,
            label: "a named run",
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

    if (pathname === `/api/conversation/${encodeURIComponent(CONVERSATION_ID)}/presence`) {
      return Promise.resolve(
        new Response(
          JSON.stringify(
            opts.presence ?? {
              presence: "LIVE",
              needsInputReason: null,
              needsInputTool: null,
              toolName: "mcp__minsky__tasks_get",
              toolElapsedMs: 12_000,
              quietForMs: null,
              isQuiet: false,
              basis: "test",
              conversationId: CONVERSATION_ID,
              ask: null,
            }
          ),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      );
    }

    return Promise.resolve(new Response("Not found", { status: 404 }));
  }) as unknown as typeof globalThis.fetch;
}

function renderConversationPage() {
  const queryClient = createTestQueryClient();
  return render(
    <MemoryRouter initialEntries={[`/conversation/${CONVERSATION_ID}`]}>
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

describe("mt#3344 — pinned run-detail chrome", () => {
  test("AT1: the header and the tab strip share ONE pinned, opaque container", async () => {
    mockFetches();
    const { getByTestId, getByRole } = renderConversationPage();

    const chrome = await waitFor(() => getByTestId("run-detail-chrome"));

    // Positioning + opacity. The container must pin to the scroller's top edge
    // and must not let transcript text show through it.
    expect(chrome.className).toContain("sticky");
    expect(chrome.className).toContain("top-0");
    expect(chrome.className).toContain("bg-background");

    // Both must be INSIDE it — two separate sticky elements would overlap
    // rather than stack, which is the whole reason for the shared container.
    const heading = await waitFor(() => getByRole("heading", { level: 1 }));
    const tablist = getByRole("tablist");
    expect(chrome.contains(heading)).toBe(true);
    expect(chrome.contains(tablist)).toBe(true);
  });

  test("AT2: the activity readout renders at the transcript tail, not in the header", async () => {
    mockFetches();
    const { getByTestId } = renderConversationPage();

    const activity = await waitFor(() => getByTestId("conversation-presence-activity"));
    expect(activity.textContent).toContain("Running mcp__minsky__tasks_get");

    const chrome = getByTestId("run-detail-chrome");
    expect(chrome.contains(activity)).toBe(false);

    // It pins to the BOTTOM edge, and needs its own opaque background for the
    // same reason the header does — transcript text scrolls underneath it.
    expect(activity.className).toContain("sticky");
    expect(activity.className).toContain("bottom-0");
    expect(activity.className).toContain("bg-background");
  });

  test("AT3: the presence VALUE stays in the header and is not duplicated in the tail", async () => {
    mockFetches();
    const { getByTestId, getAllByTestId } = renderConversationPage();

    const value = await waitFor(() => getByTestId("conversation-presence-value"));
    expect(value.textContent).toBe("LIVE");

    const chrome = getByTestId("run-detail-chrome");
    expect(chrome.contains(value)).toBe(true);

    // One value in each place, no duplicated readout: the tail renders the
    // activity line ONLY, so exactly one presence-value node exists.
    expect(getAllByTestId("conversation-presence-value")).toHaveLength(1);
  });

  test("a resting conversation renders the presence value with no tail activity line", async () => {
    mockFetches({
      presence: {
        presence: "IDLE",
        needsInputReason: null,
        needsInputTool: null,
        toolName: null,
        toolElapsedMs: null,
        quietForMs: null,
        isQuiet: false,
        basis: "test",
        conversationId: CONVERSATION_ID,
        ask: null,
      },
    });
    const { getByTestId, queryByTestId } = renderConversationPage();

    const value = await waitFor(() => getByTestId("conversation-presence-value"));
    expect(value.textContent).toBe("IDLE");

    // `describeActivity` returns null off LIVE/STALLED, and the tail renders
    // nothing rather than repeating the presence value the header already has.
    expect(queryByTestId("conversation-presence-activity")).toBeNull();
  });
});
