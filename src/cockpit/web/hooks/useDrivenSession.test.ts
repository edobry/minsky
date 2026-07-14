/**
 * Tests for useDrivenSession (mt#2751, Rung 2B) — the WS client hook that
 * drives the mt#2750 driven-session channel.
 *
 * Stubs the global `WebSocket` constructor (mirrors `StubEventSource` in
 * `../lib/sse-client.test.ts` / `../pages/ConversationPage.test.tsx`) rather
 * than opening a real network connection.
 *
 * Run via:
 *   bun run test:components
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useDrivenSession } from "./useDrivenSession";

// ---------------------------------------------------------------------------
// Stub WebSocket
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
  closed = false;
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
    this.closed = true;
    this.readyState = StubWebSocket.CLOSED;
    this.dispatch("close", {});
  }

  // Test-only server-simulation helpers.
  simulateOpen(): void {
    this.readyState = StubWebSocket.OPEN;
    this.dispatch("open", {});
  }
  simulateMessage(payload: unknown): void {
    this.dispatch("message", { data: JSON.stringify(payload) });
  }
  /** Dispatch a raw (possibly non-JSON) message payload, bypassing JSON.stringify. */
  simulateRawMessage(raw: string): void {
    this.dispatch("message", { data: raw });
  }
  simulateError(): void {
    this.dispatch("error", {});
  }
  simulateServerClose(): void {
    this.readyState = StubWebSocket.CLOSED;
    this.dispatch("close", {});
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
  globalThis.WebSocket = originalWebSocket;
  StubWebSocket.instances = [];
});

function firstWs(): StubWebSocket {
  const ws = StubWebSocket.instances[0];
  if (!ws) throw new Error("expected a StubWebSocket instance to have been constructed");
  return ws;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("useDrivenSession", () => {
  test("opens the driven-session WS channel at the expected relative URL", () => {
    renderHook(() => useDrivenSession("local-abc-123"));
    expect(StubWebSocket.instances).toHaveLength(1);
    expect(firstWs().url).toBe("/api/driven-session/local-abc-123/ws");
  });

  test("does not connect when localId is falsy", () => {
    renderHook(() => useDrivenSession(null));
    expect(StubWebSocket.instances).toHaveLength(0);
  });

  test("status is 'connecting' before open, 'live' once open and the session is running", async () => {
    const { result } = renderHook(() => useDrivenSession("s1"));
    expect(result.current.status).toBe("connecting");

    act(() => {
      firstWs().simulateOpen();
      firstWs().simulateMessage({ type: "system", subtype: "init", session_id: "h-1" });
    });

    await waitFor(() => expect(result.current.status).toBe("live"));
    expect(result.current.harnessSessionId).toBe("h-1");
  });

  test("accumulates blocks from streamed events into `blocks`, growing token by token", async () => {
    const { result } = renderHook(() => useDrivenSession("s1"));
    act(() => firstWs().simulateOpen());

    act(() => {
      firstWs().simulateMessage({ type: "stream_event", event: { type: "message_start" } });
      firstWs().simulateMessage({
        type: "stream_event",
        event: { type: "content_block_start", index: 0, content_block: { type: "text" } },
      });
    });
    await waitFor(() => expect(result.current.blocks).toHaveLength(1));

    act(() => {
      firstWs().simulateMessage({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "Hel" },
        },
      });
    });
    await waitFor(() => {
      const content = (result.current.blocks[0]?.content as { content: Array<{ text?: string }> })
        .content;
      expect(content[0]?.text).toBe("Hel");
    });

    act(() => {
      firstWs().simulateMessage({
        type: "stream_event",
        event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "lo" } },
      });
    });
    await waitFor(() => {
      const content = (result.current.blocks[0]?.content as { content: Array<{ text?: string }> })
        .content;
      expect(content[0]?.text).toBe("Hello");
    });
  });

  test('sendText sends {"text":...} over the open socket', async () => {
    const { result } = renderHook(() => useDrivenSession("s1"));
    act(() => firstWs().simulateOpen());
    await waitFor(() => expect(firstWs().readyState).toBe(StubWebSocket.OPEN));

    act(() => result.current.sendText("hello there"));
    expect(firstWs().sent).toHaveLength(1);
    expect(JSON.parse(firstWs().sent[0] ?? "{}")).toEqual({ text: "hello there" });
  });

  test("sendText before the socket is open is a no-op (no throw, no send)", () => {
    const { result } = renderHook(() => useDrivenSession("s1"));
    expect(() => act(() => result.current.sendText("too early"))).not.toThrow();
    expect(firstWs().sent).toHaveLength(0);
  });

  test('stop sends {"type":"stop"} over the open socket', async () => {
    const { result } = renderHook(() => useDrivenSession("s1"));
    act(() => firstWs().simulateOpen());
    await waitFor(() => expect(firstWs().readyState).toBe(StubWebSocket.OPEN));

    act(() => result.current.stop());
    expect(JSON.parse(firstWs().sent[0] ?? "{}")).toEqual({ type: "stop" });
  });

  test("a minsky_exit frame surfaces status 'exited' — the view surfaces the exit rather than freezing", async () => {
    const { result } = renderHook(() => useDrivenSession("s1"));
    act(() => {
      firstWs().simulateOpen();
      firstWs().simulateMessage({ type: "system", subtype: "init", session_id: "h-1" });
    });
    await waitFor(() => expect(result.current.status).toBe("live"));

    act(() =>
      firstWs().simulateMessage({ type: "minsky_exit", code: 0, signal: null, status: "exited" })
    );
    await waitFor(() => expect(result.current.status).toBe("exited"));
  });

  test("a minsky_error frame (daemon-side crash) surfaces status 'crashed' with a readable errorMessage", async () => {
    const { result } = renderHook(() => useDrivenSession("s1"));
    act(() => firstWs().simulateOpen());

    act(() =>
      firstWs().simulateMessage({ type: "minsky_error", message: "Failed to start claude: ENOENT" })
    );
    await waitFor(() => expect(result.current.status).toBe("crashed"));
    expect(result.current.errorMessage).toBe("Failed to start claude: ENOENT");
  });

  test("a channel that never opens (auth failure / unknown session) surfaces as a readable crashed status, not a frozen 'connecting'", async () => {
    const { result } = renderHook(() => useDrivenSession("s1"));
    act(() => firstWs().simulateError());
    await waitFor(() => expect(result.current.connectionState).toBe("error"));
    expect(result.current.status).toBe("crashed");
  });

  test("a malformed (non-JSON) frame is tolerated — skipped, no throw, no state change", async () => {
    const { result } = renderHook(() => useDrivenSession("s1"));
    act(() => firstWs().simulateOpen());
    const before = result.current.blocks;

    expect(() => act(() => firstWs().simulateRawMessage("not json at all"))).not.toThrow();
    expect(result.current.blocks).toBe(before);
  });

  test("switching localId resets accumulated state and opens a fresh connection", async () => {
    const { result, rerender } = renderHook(({ id }) => useDrivenSession(id), {
      initialProps: { id: "s1" },
    });
    act(() => {
      firstWs().simulateOpen();
      firstWs().simulateMessage({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "first session" }] },
      });
    });
    await waitFor(() => expect(result.current.blocks).toHaveLength(1));

    rerender({ id: "s2" });
    expect(StubWebSocket.instances).toHaveLength(2);
    expect(result.current.blocks).toHaveLength(0);
  });
});
