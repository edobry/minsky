/**
 * DrivenSessionPage tests (mt#2751, Rung 2B).
 *
 * Stubs the global `WebSocket` constructor (mirrors `ConversationPage.test.tsx`'s
 * `StubEventSource` for the SSE case) to exercise the whole page — status bar,
 * ConversationView (drivenSessionId variant), and composer — off simulated
 * frames matching the real mt#2750 stream-json protocol, without a live spawn.
 *
 * Run via:
 *   bun run test:components
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { DrivenSessionPage } from "./DrivenSessionPage";

// ---------------------------------------------------------------------------
// Stub WebSocket (mirrors ../hooks/useDrivenSession.test.ts's StubWebSocket)
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
  removeEventListener(): void {
    // not exercised by this suite
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = StubWebSocket.CLOSED;
  }
  simulateOpen(): void {
    this.readyState = StubWebSocket.OPEN;
    this.dispatch("open", {});
  }
  simulateMessage(payload: unknown): void {
    this.dispatch("message", { data: JSON.stringify(payload) });
  }
  simulateError(): void {
    this.dispatch("error", {});
  }
  private dispatch(type: string, ev: unknown): void {
    for (const l of this.listeners.get(type) ?? []) l(ev);
  }
}

let originalWebSocket: typeof globalThis.WebSocket;

beforeEach(() => {
  StubWebSocket.instances = [];
  originalWebSocket = globalThis.WebSocket;
  // @ts-expect-error — replacing WebSocket with a stub for testing
  globalThis.WebSocket = StubWebSocket;
});

afterEach(() => {
  cleanup();
  globalThis.WebSocket = originalWebSocket;
  StubWebSocket.instances = [];
});

function firstWs(): StubWebSocket {
  const ws = StubWebSocket.instances[0];
  if (!ws) throw new Error("expected a StubWebSocket instance to have been constructed");
  return ws;
}

function renderPage(id: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter initialEntries={[`/driven/${id}`]}>
      <QueryClientProvider client={client}>
        <Routes>
          <Route path="/driven/:id" element={<DrivenSessionPage />} />
        </Routes>
      </QueryClientProvider>
    </MemoryRouter>
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DrivenSessionPage (mt#2751)", () => {
  test("opens the driven-session WS channel for the URL's id", async () => {
    renderPage("driven-page-1");
    await waitFor(() => expect(StubWebSocket.instances).toHaveLength(1));
    expect(firstWs().url).toBe("/api/driven-session/driven-page-1/ws");
  });

  test("shows Connecting… before the channel opens", () => {
    renderPage("driven-page-2");
    expect(screen.getByText("Connecting…")).toBeDefined();
  });

  test("acceptance test 1 shape: init + streamed assistant text renders live, then sending input forwards {\"text\":...} over the channel", async () => {
    renderPage("driven-page-3");
    await waitFor(() => expect(StubWebSocket.instances).toHaveLength(1));

    firstWs().simulateOpen();
    firstWs().simulateMessage({ type: "system", subtype: "init", session_id: "harness-1" });
    firstWs().simulateMessage({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "hello operator" }] },
    });
    // `result` marks the full agentic turn done — the channel is ready for the
    // next operator message (interactionState back to "awaiting-input").
    firstWs().simulateMessage({ type: "result", subtype: "success", total_cost_usd: 0.01 });

    await waitFor(() => expect(screen.getByText("hello operator")).toBeDefined());
    expect(screen.getByText("Live")).toBeDefined();

    const textarea = screen.getByLabelText("Message to the driven session") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "continue please" } });
    fireEvent.click(screen.getByText("Send"));

    await waitFor(() => expect(firstWs().sent).toHaveLength(1));
    expect(JSON.parse(firstWs().sent[0] ?? "{}")).toEqual({ text: "continue please" });
  });

  test("acceptance test 3 shape: a minsky_exit frame surfaces the exit and result summary rather than freezing", async () => {
    renderPage("driven-page-4");
    await waitFor(() => expect(StubWebSocket.instances).toHaveLength(1));

    firstWs().simulateOpen();
    firstWs().simulateMessage({ type: "system", subtype: "init", session_id: "harness-2" });
    firstWs().simulateMessage({
      type: "result",
      subtype: "success",
      total_cost_usd: 0.01,
      duration_ms: 1200,
      num_turns: 1,
    });
    firstWs().simulateMessage({ type: "minsky_exit", code: 0, signal: null, status: "exited" });

    await waitFor(() => expect(screen.getByText("Exited")).toBeDefined());
    expect(screen.getByText("1.2s · $0.0100 · 1 turn")).toBeDefined();

    const textarea = screen.getByLabelText("Message to the driven session") as HTMLTextAreaElement;
    expect(textarea.disabled).toBe(true);
  });

  test("a channel that fails to connect (auth failure / unknown session) renders a readable error, not a frozen thread", async () => {
    renderPage("driven-page-5");
    await waitFor(() => expect(StubWebSocket.instances).toHaveLength(1));

    firstWs().simulateError();

    await waitFor(() =>
      expect(
        screen.getByText(
          "Could not connect to the driven session channel. It may not exist, or the connection was refused."
        )
      ).toBeDefined()
    );
  });

  test("a minsky_error frame (daemon-side crash mid-stream) surfaces as Crashed with the error text — 'surfaces the exit rather than freezing'", async () => {
    renderPage("driven-page-6");
    await waitFor(() => expect(StubWebSocket.instances).toHaveLength(1));

    firstWs().simulateOpen();
    firstWs().simulateMessage({ type: "system", subtype: "init", session_id: "harness-3" });
    firstWs().simulateMessage({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "working..." }] },
    });
    await waitFor(() => expect(screen.getByText("working...")).toBeDefined());

    firstWs().simulateMessage({
      type: "minsky_error",
      message: "Failed to start claude: ENOENT",
    });

    await waitFor(() => expect(screen.getByText("Crashed")).toBeDefined());
    expect(screen.getByText("Failed to start claude: ENOENT")).toBeDefined();
    // The transcript up to the crash point stays visible — not replaced by the
    // channel-failure ErrorState (the channel DID open; the session crashed).
    expect(screen.getByText("working...")).toBeDefined();
  });
});
