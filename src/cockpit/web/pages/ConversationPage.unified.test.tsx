/**
 * The unified conversation route (mt#3132).
 *
 * Covers the acceptance tests that need a rendered page rather than a pure
 * function:
 *
 *  - **AT5** — a conversation navigated to before its `init` frame renders,
 *    rather than 404ing while the harness id is still unknown.
 *  - **AT4 / SC5** — no composer is reachable on this route in ANY state.
 *    Asserted directly, because mt#3095's liveness gate does not exist yet and
 *    "we didn't mount one" is a convention until something checks.
 *  - **AT2** — a conversation with no telemetry reads `UNKNOWN`, not a blank
 *    and not a falsely confident value.
 *  - **In scope item 6** — the tab set is a property of the KEYSPACE, so a
 *    conversation that arrived through the session driver pipeline gets the same tabs
 *    as any other. Pinned so nobody special-cases the driven path back in.
 *
 * Run via:
 *   bun run test:components
 *   (or) bun test --preload ./tests/dom-setup.ts --preload ./tests/setup.ts
 *        --timeout=15000 src/cockpit/web/pages/ConversationPage.unified.test.tsx
 */
import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ConversationPage } from "./ConversationPage";
import { TabsProvider } from "../lib/tabs";
import { TabBar } from "../components/TabBar";

const CONVERSATION_UUID = "2154425b-1e39-4a6f-9f0e-6b3b1a2c4d5e";
const LOCAL_ID = "39d94344-36ad-4a17-b8b3-d35dd8f50714";

type EventListener = (event: MessageEvent | Event) => void;

/** The page's ConversationView opens a live-tail SSE channel; stub it out. */
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
let originalWebSocket: typeof globalThis.WebSocket;
/** Every WS url the page caused to be opened — must stay empty (SC5). */
let openedSockets: string[] = [];

beforeEach(() => {
  originalEventSource = globalThis.EventSource;
  originalFetch = globalThis.fetch;
  originalWebSocket = globalThis.WebSocket;
  openedSockets = [];
  // @ts-expect-error — stub
  globalThis.EventSource = StubEventSource;
  // A WebSocket constructor that RECORDS rather than connects: the read-only
  // guarantee is "no session driver channel is opened", and the only way to assert
  // that from outside is to watch the constructor.
  // @ts-expect-error — stub
  globalThis.WebSocket = class {
    constructor(url: string) {
      openedSockets.push(url);
    }
    addEventListener(): void {}
    removeEventListener(): void {}
    send(): void {}
    close(): void {}
  };
});

afterEach(() => {
  cleanup();
  globalThis.EventSource = originalEventSource;
  globalThis.fetch = originalFetch;
  globalThis.WebSocket = originalWebSocket;
});

function createTestQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
}

interface StubOptions {
  /** Rows served by `GET /api/driven-session`. */
  sessionDrivers?: Array<{ sessionId: string; harnessSessionId: string | null; status: string }>;
  /** Conversation ids that have a transcript. Anything else 404s. */
  transcripts?: string[];
  /** Presence payload per conversation id; absent ids get `UNKNOWN`. */
  presence?: Record<string, string>;
  /**
   * Delay the registry response so the page renders optimistically FIRST.
   *
   * Without this every stub resolves in the same microtask burst and the
   * address is settled before the transcript fetch is ever issued — which is
   * not the live ordering, and is why the first version of the tab-prune
   * regression test below passed against the bug it was written for.
   */
  registryDelayMs?: number;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function stubFetches(opts: StubOptions = {}) {
  const sessionDrivers = opts.sessionDrivers ?? [];
  const transcripts = new Set(opts.transcripts ?? []);

  globalThis.fetch = mock((url: string) => {
    const parsed = new URL(typeof url === "string" ? url : String(url), "http://localhost");
    const pathname = parsed.pathname;

    if (pathname === "/api/driven-session") {
      const body = () => json({ sessions: sessionDrivers });
      return opts.registryDelayMs
        ? new Promise<Response>((resolve) => setTimeout(() => resolve(body()), opts.registryDelayMs))
        : Promise.resolve(body());
    }

    if (pathname === "/api/cockpit/context-inspector/snapshot") {
      const id = parsed.searchParams.get("sessionId") ?? "";
      if (!transcripts.has(id)) return Promise.resolve(json({ error: "not found" }, 404));
      return Promise.resolve(json({ agentSessionId: id, blocks: [] }));
    }

    const presenceMatch = pathname.match(/^\/api\/conversation\/([^/]+)\/presence$/);
    if (presenceMatch) {
      const id = decodeURIComponent(presenceMatch[1] as string);
      return Promise.resolve(
        json({
          presence: opts.presence?.[id] ?? "UNKNOWN",
          needsInputReason: null,
          needsInputTool: null,
          toolName: null,
          toolElapsedMs: null,
          quietForMs: null,
          isQuiet: false,
          basis: "test",
          conversationId: id,
          ask: null,
        })
      );
    }

    const overviewMatch = pathname.match(/^\/api\/conversation\/([^/]+)\/overview$/);
    if (overviewMatch) {
      const id = decodeURIComponent(overviewMatch[1] as string);
      if (!transcripts.has(id)) return Promise.resolve(json({ error: "not found" }, 404));
      return Promise.resolve(
        json({
          agentSessionId: id,
          label: `Conversation ${id.slice(0, 8)}`,
          conversationMeta: { startedAt: null, cwd: null, harness: null, turnCount: 0 },
          workspace: null,
        })
      );
    }

    // Auxiliary reads (entity-linkification etc.) already degrade to empty.
    return Promise.resolve(json({ error: "not found" }, 404));
  }) as unknown as typeof globalThis.fetch;
}

function renderAt(routeId: string) {
  const queryClient = createTestQueryClient();
  return render(
    <MemoryRouter initialEntries={[`/conversation/${routeId}`]}>
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

/** Same, plus the tab strip — needed to observe the error chip's title. */
function renderWithTabBar(routeId: string) {
  const queryClient = createTestQueryClient();
  return render(
    <MemoryRouter initialEntries={[`/conversation/${routeId}`]}>
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
}

/**
 * The composer's textarea is the operator-reachable send path. Its accessible
 * name is the shared composer's own default, so this catches the component
 * being mounted regardless of which host mounted it.
 */
function queryComposer(): HTMLElement | null {
  return screen.queryByLabelText(/Message to this session/i);
}

describe("AT5 — a conversation reached before its init frame", () => {
  test("renders the starting state rather than 404ing", async () => {
    stubFetches({
      sessionDrivers: [{ sessionId: LOCAL_ID, harnessSessionId: null, status: "running" }],
    });
    renderAt(LOCAL_ID);

    const starting = await screen.findByTestId("conversation-starting");
    expect(starting.textContent).toContain("has not produced a transcript yet");
    // The local id stays the address — it is not rewritten or redirected away.
    expect(screen.getByTitle(LOCAL_ID)).toBeDefined();
  });

  test("a session driver that died before linking says so, rather than starting forever", async () => {
    stubFetches({
      sessionDrivers: [{ sessionId: LOCAL_ID, harnessSessionId: null, status: "crashed" }],
    });
    renderAt(LOCAL_ID);

    const starting = await screen.findByTestId("conversation-starting");
    expect(starting.textContent).toContain("ended before it produced a transcript");
  });

  test("...including `unrecoverable`, the terminal status the first cut missed", async () => {
    // PR #2502 R1. `unrecoverable` has been terminal since mt#3038 R1 delta #2,
    // but the predicate was a denylist of `exited`/`crashed`, so a run that can
    // never link rendered "Starting…" indefinitely and kept the registry poll
    // alive behind it.
    stubFetches({
      sessionDrivers: [{ sessionId: LOCAL_ID, harnessSessionId: null, status: "unrecoverable" }],
    });
    renderAt(LOCAL_ID);

    const starting = await screen.findByTestId("conversation-starting");
    expect(starting.textContent).toContain("ended before it produced a transcript");
    expect(starting.textContent).not.toContain("has not produced a transcript yet");
  });

  test("once linked, the same local-id URL serves the conversation", async () => {
    stubFetches({
      sessionDrivers: [
        { sessionId: LOCAL_ID, harnessSessionId: CONVERSATION_UUID, status: "running" },
      ],
      transcripts: [CONVERSATION_UUID],
    });
    renderAt(LOCAL_ID);

    // The label comes from the RESOLVED conversation, proving the local id was
    // translated for data while remaining the address.
    await waitFor(() =>
      expect(screen.getByText(`Conversation ${CONVERSATION_UUID.slice(0, 8)}`)).toBeDefined()
    );
    expect(screen.queryByTestId("conversation-starting")).toBeNull();
  });

  test("the first-render 404 under the local id does not kill the tab", async () => {
    // Found live, not in this suite: a linked local-id URL spends its first
    // render fetching under the LOCAL id (the optimistic fallback), which 404s.
    // The address then resolves and the real conversation loads — but the stale
    // 404 was pruning the tab anyway, so a working conversation rendered under
    // an errored, non-persisted tab. The deferred prune records WHICH id it was
    // about, and drops it when that is not the id finally resolved to.
    stubFetches({
      sessionDrivers: [
        { sessionId: LOCAL_ID, harnessSessionId: CONVERSATION_UUID, status: "running" },
      ],
      transcripts: [CONVERSATION_UUID],
      // Forces the live ordering: the page renders under the local id and its
      // transcript fetch 404s BEFORE the address resolves.
      registryDelayMs: 40,
    });
    const { container } = renderWithTabBar(LOCAL_ID);

    await waitFor(() =>
      expect(screen.getByText(`Conversation ${CONVERSATION_UUID.slice(0, 8)}`)).toBeDefined()
    );
    // Let any deferred prune land before asserting its absence.
    await new Promise((r) => setTimeout(r, 50));
    expect(container.querySelector(`[title="${LOCAL_ID} (not found)"]`)).toBeNull();
    expect(container.querySelector(`[title="${CONVERSATION_UUID} (not found)"]`)).toBeNull();
  });
});

describe("SC5 / AT4 — the unified route is read-only by construction", () => {
  test("no composer renders for a plain conversation", async () => {
    stubFetches({ transcripts: [CONVERSATION_UUID] });
    renderAt(CONVERSATION_UUID);
    await waitFor(() =>
      expect(screen.getByText(`Conversation ${CONVERSATION_UUID.slice(0, 8)}`)).toBeDefined()
    );
    expect(queryComposer()).toBeNull();
  });

  test("no composer renders for a starting session driver", async () => {
    stubFetches({
      sessionDrivers: [{ sessionId: LOCAL_ID, harnessSessionId: null, status: "running" }],
    });
    renderAt(LOCAL_ID);
    await screen.findByTestId("conversation-starting");
    expect(queryComposer()).toBeNull();
  });

  test("no composer renders for a conversation with a LIVE session driver attached", async () => {
    // The state most likely to tempt a composer back in: the cockpit owns a
    // running session driver for this exact conversation. It still must not mount one
    // here — mt#3325 owns that, once mt#3095's liveness gate exists.
    stubFetches({
      sessionDrivers: [
        { sessionId: LOCAL_ID, harnessSessionId: CONVERSATION_UUID, status: "running" },
      ],
      transcripts: [CONVERSATION_UUID],
      presence: { [CONVERSATION_UUID]: "LIVE" },
    });
    renderAt(CONVERSATION_UUID);
    await waitFor(() =>
      expect(screen.getByText(`Conversation ${CONVERSATION_UUID.slice(0, 8)}`)).toBeDefined()
    );
    expect(queryComposer()).toBeNull();
  });

  test("opens no session driver WebSocket in any of those states", async () => {
    stubFetches({
      sessionDrivers: [
        { sessionId: LOCAL_ID, harnessSessionId: CONVERSATION_UUID, status: "running" },
      ],
      transcripts: [CONVERSATION_UUID],
    });
    renderAt(CONVERSATION_UUID);
    await waitFor(() =>
      expect(screen.getByText(`Conversation ${CONVERSATION_UUID.slice(0, 8)}`)).toBeDefined()
    );
    // Not merely "no composer rendered" — no channel was opened at all, which
    // is what makes the read-only guarantee structural rather than cosmetic.
    expect(openedSockets.filter((u) => u.includes("driven-session"))).toEqual([]);
  });
});

describe("AT2 — a conversation with no telemetry", () => {
  test("reads UNKNOWN rather than blank or falsely confident", async () => {
    stubFetches({ transcripts: [CONVERSATION_UUID], presence: { [CONVERSATION_UUID]: "UNKNOWN" } });
    renderAt(CONVERSATION_UUID);

    const value = await screen.findByTestId("conversation-presence-value");
    expect(value.textContent).toBe("UNKNOWN");
  });
});

describe("In scope item 6 — the tab set belongs to the keyspace, not the pipeline", () => {
  async function renderedTabs(routeId: string): Promise<string[]> {
    await waitFor(() => expect(screen.getAllByRole("tab").length).toBeGreaterThan(0));
    return screen.getAllByRole("tab").map((t) => (t.textContent ?? "").trim());
  }

  test("a plain conversation and a session driver-delivered one render the SAME tabs", async () => {
    stubFetches({ transcripts: [CONVERSATION_UUID] });
    renderAt(CONVERSATION_UUID);
    const plain = await renderedTabs(CONVERSATION_UUID);
    expect(plain).toEqual(["overview", "conversation", "context", "film"]);
    cleanup();

    stubFetches({
      sessionDrivers: [
        { sessionId: LOCAL_ID, harnessSessionId: CONVERSATION_UUID, status: "running" },
      ],
      transcripts: [CONVERSATION_UUID],
    });
    renderAt(LOCAL_ID);
    const viaDriver = await renderedTabs(LOCAL_ID);
    expect(viaDriver).toEqual(plain);
  });
});
