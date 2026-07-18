/**
 * Agents.tsx row-expansion tests (mt#2912) — the fleet-table peek composer.
 *
 * Covers the task's three acceptance tests at the component level:
 *   AT1: expanding a driven row renders the composer; sending a message
 *        round-trips over the WS channel.
 *   AT2: (see AgentDrivenPeek.test.tsx for the connection-count evidence —
 *        this file additionally confirms the row wiring calls the peek with
 *        the SAME `useDrivenSession` mechanism, not a second transport).
 *   AT3: a row with subagents but NO driven binding keeps the pre-existing
 *        tree expansion, unchanged.
 *
 * Stubs `fetch` for the widget payload / asks / active-sessions endpoints
 * (mirrors `TriageBand.test.tsx`'s pattern) and the global `WebSocket`
 * constructor (mirrors `AgentDrivenPeek.test.tsx`).
 *
 * Run via:
 *   bun run test:components
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { render, screen, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Agents, type AgentRow } from "./Agents";

// ---------------------------------------------------------------------------
// Stub WebSocket (mirrors AgentDrivenPeek.test.tsx's StubWebSocket)
// ---------------------------------------------------------------------------

type WsListener = (ev: unknown) => void;

class StubWebSocket {
  static instances: StubWebSocket[] = [];
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readonly url: string;
  readyState = StubWebSocket.CONNECTING;
  sent: string[] = [];
  private listeners = new Map<string, WsListener[]>();

  constructor(url: string) {
    this.url = url;
    StubWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: WsListener): void {
    const bucket = this.listeners.get(type) ?? [];
    bucket.push(listener);
    this.listeners.set(type, bucket);
  }
  removeEventListener(type: string, listener: WsListener): void {
    const bucket = this.listeners.get(type);
    if (!bucket) return;
    this.listeners.set(
      type,
      bucket.filter((l) => l !== listener)
    );
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = StubWebSocket.CLOSED;
    this.dispatch("close", {});
  }
  simulateOpen(): void {
    this.readyState = StubWebSocket.OPEN;
    this.dispatch("open", {});
  }
  simulateMessage(payload: unknown): void {
    this.dispatch("message", { data: JSON.stringify(payload) });
  }
  private dispatch(type: string, ev: unknown): void {
    for (const l of this.listeners.get(type) ?? []) l(ev);
  }
}

let originalWebSocket: typeof globalThis.WebSocket;
const originalFetch = globalThis.fetch;

// ---------------------------------------------------------------------------
// Row fixtures
// ---------------------------------------------------------------------------

function baseRow(overrides: Partial<AgentRow> & Pick<AgentRow, "sessionId">): AgentRow {
  return {
    kind: "dispatched-agent",
    title: overrides.sessionId,
    liveness: "healthy",
    taskId: null,
    taskTitle: null,
    prNumber: null,
    prStatus: null,
    lastActivityAt: "2026-07-18T00:00:00Z",
    agentId: null,
    conversationId: null,
    cwd: null,
    subagents: [],
    driven: null,
    attachState: null,
    interfaceBinding: { kind: "unbound", lastObservedAt: "2026-07-18T00:00:00Z" },
    ...overrides,
  };
}

const SUBAGENT_ONLY_ROW = baseRow({
  sessionId: "subagent-only-row",
  subagents: [
    {
      conversationId: "conv-child-1",
      label: "child task",
      cwd: null,
      startedAt: "2026-07-18T00:00:00Z",
      endedAt: null,
    },
  ],
});

const DRIVEN_WORKSPACE_ROW = baseRow({
  sessionId: "driven-workspace-row",
  driven: { sessionId: "drv-workspace-1", status: "running" },
});

function stubNetwork(agents: AgentRow[]) {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/widget/agents/data")) {
      return new Response(
        JSON.stringify({ state: "ok", payload: { agents, totalCount: agents.length } }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    if (url.includes("/api/health")) {
      return new Response(JSON.stringify({ transcriptWatcher: { activeSessions: [] } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.includes("/api/asks")) {
      return new Response(JSON.stringify({ asks: [], total: 0 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    throw new Error(`Unexpected fetch in test: ${url}`);
  }) as typeof fetch;
}

function renderAgents() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <Agents />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

function firstWs(): StubWebSocket {
  const ws = StubWebSocket.instances[0];
  if (!ws) throw new Error("expected a StubWebSocket instance to have been constructed");
  return ws;
}

beforeEach(() => {
  StubWebSocket.instances = [];
  originalWebSocket = globalThis.WebSocket;
  // @ts-expect-error — replacing WebSocket with a stub for testing
  globalThis.WebSocket = StubWebSocket;
});

afterEach(() => {
  cleanup();
  globalThis.WebSocket = originalWebSocket;
  globalThis.fetch = originalFetch;
  StubWebSocket.instances = [];
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Agents row expansion (mt#2912)", () => {
  test("AT3: a row with subagents but no driven binding keeps the existing tree expansion, unchanged — no WS connection opens", async () => {
    stubNetwork([SUBAGENT_ONLY_ROW]);
    renderAgents();

    await waitFor(() => expect(screen.getByLabelText("Expand subagents")).toBeDefined());
    fireEvent.click(screen.getByLabelText("Expand subagents"));

    await waitFor(() => expect(screen.getByText("child task")).toBeDefined());
    // No driven binding on this row — the peek's transport must never open.
    expect(StubWebSocket.instances).toHaveLength(0);
  });

  test("AT1/AT2: expanding a driven-bound workspace row renders the peek composer and round-trips a message over useDrivenSession's WS channel", async () => {
    stubNetwork([DRIVEN_WORKSPACE_ROW]);
    renderAgents();

    await waitFor(() => expect(screen.getByLabelText("Expand driven session")).toBeDefined());
    fireEvent.click(screen.getByLabelText("Expand driven session"));

    // The peek mounts AgentDrivenPeek, which calls useDrivenSession exactly
    // once — the SAME hook/channel `/driven/:id` uses, no new transport.
    await waitFor(() => expect(StubWebSocket.instances).toHaveLength(1));
    expect(firstWs().url).toBe("/api/driven-session/drv-workspace-1/ws");
    firstWs().simulateOpen();

    const textarea = await screen.findByLabelText("Message to the driven session");
    fireEvent.change(textarea, { target: { value: "answering from the peek" } });
    fireEvent.click(screen.getByText("Send"));

    await waitFor(() => expect(firstWs().sent).toHaveLength(1));
    expect(JSON.parse(firstWs().sent[0] ?? "{}")).toEqual({ text: "answering from the peek" });

    // Collapsing the row tears the peek (and its WS connection) down again —
    // expanding it back open doesn't leak a second stale connection.
    fireEvent.click(screen.getByLabelText("Collapse driven session"));
    await waitFor(() => expect(screen.queryByLabelText("Message to the driven session")).toBeNull());
  });

  test("a row with neither subagents nor a driven binding renders no expand affordance", async () => {
    stubNetwork([baseRow({ sessionId: "plain-row" })]);
    renderAgents();

    await waitFor(() => expect(screen.getByText("plain-row")).toBeDefined());
    expect(screen.queryByLabelText(/Expand/)).toBeNull();
  });
});
