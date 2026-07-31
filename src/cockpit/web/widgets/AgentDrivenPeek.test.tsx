/**
 * AgentDrivenPeek tests (mt#2912).
 *
 * Stubs the global `WebSocket` constructor (via the shared `StubWebSocket`
 * test double in `../lib/stub-websocket.ts`, which mirrors
 * `../hooks/useDrivenSession.test.ts` / `../pages/DrivenSessionPage.test.tsx`)
 * to exercise the peek's status + preview + composer off simulated frames,
 * without a live spawn.
 *
 * Run via:
 *   bun run test:components
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { AgentDrivenPeek } from "./AgentDrivenPeek";
import { StubWebSocket, firstStubWs } from "../lib/stub-websocket";

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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AgentDrivenPeek (mt#2912)", () => {
  test("AT2 evidence: mounting the peek opens exactly ONE WebSocket connection — the single-connection contract useDrivenSession/DrivenSessionPage already establish", async () => {
    render(<AgentDrivenPeek sessionId="peek-1" />);
    await waitFor(() => expect(StubWebSocket.instances).toHaveLength(1));
    expect(firstStubWs().url).toBe("/api/driven-session/peek-1/ws");
  });

  test("shows Connecting… before the channel opens, and No messages yet with an empty block stream", () => {
    render(<AgentDrivenPeek sessionId="peek-2" />);
    expect(screen.getByText("Connecting…")).toBeDefined();
    expect(screen.getByText("No messages yet.")).toBeDefined();
  });

  test("a block with no extractable text (e.g. a bare tool-result) renders the distinct 'no preview available' message, not 'no messages yet'", async () => {
    render(<AgentDrivenPeek sessionId="peek-2b" />);
    await waitFor(() => expect(StubWebSocket.instances).toHaveLength(1));

    firstStubWs().simulateOpen();
    firstStubWs().simulateMessage({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "tool_result", content: "", tool_use_id: "t1" }],
      },
    });

    await waitFor(() => expect(screen.getByText("No preview available for the latest message.")).toBeDefined());
    expect(screen.queryByText("No messages yet.")).toBeNull();
  });

  test("renders the last blocking prompt and its status once the channel is live", async () => {
    render(<AgentDrivenPeek sessionId="peek-3" />);
    await waitFor(() => expect(StubWebSocket.instances).toHaveLength(1));

    firstStubWs().simulateOpen();
    firstStubWs().simulateMessage({ type: "system", subtype: "init", session_id: "harness-1" });
    firstStubWs().simulateMessage({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "need your input here" }] },
    });
    firstStubWs().simulateMessage({ type: "result", subtype: "success", total_cost_usd: 0.01 });

    await waitFor(() => expect(screen.getByText("need your input here")).toBeDefined());
    expect(screen.getByText("Live")).toBeDefined();
  });

  test("AT1: sending a message from the peek round-trips over the SAME WS channel used by /driven/:id", async () => {
    render(<AgentDrivenPeek sessionId="peek-4" />);
    await waitFor(() => expect(StubWebSocket.instances).toHaveLength(1));

    firstStubWs().simulateOpen();
    firstStubWs().simulateMessage({ type: "system", subtype: "init", session_id: "harness-2" });

    const textarea = screen.getByLabelText("Message to the driven session") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "go ahead" } });
    fireEvent.click(screen.getByText("Send"));

    await waitFor(() => expect(firstStubWs().sent).toHaveLength(1));
    expect(JSON.parse(firstStubWs().sent[0] ?? "{}")).toEqual({ text: "go ahead" });
    // Still exactly one connection — sending a message doesn't open a second one.
    expect(StubWebSocket.instances).toHaveLength(1);
  });

  test("switching sessionId opens a fresh connection for the new session (never reuses a stale one across ids)", async () => {
    const { rerender } = render(<AgentDrivenPeek sessionId="peek-5a" />);
    await waitFor(() => expect(StubWebSocket.instances).toHaveLength(1));
    expect(StubWebSocket.instances[0]?.url).toBe("/api/driven-session/peek-5a/ws");

    rerender(<AgentDrivenPeek sessionId="peek-5b" />);
    await waitFor(() => expect(StubWebSocket.instances).toHaveLength(2));
    expect(StubWebSocket.instances[1]?.url).toBe("/api/driven-session/peek-5b/ws");
  });
});
