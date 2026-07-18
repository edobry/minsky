/**
 * StubWebSocket (mt#2912) — a minimal `WebSocket`-shaped test double, shared
 * by the tests this task added (`AgentDrivenPeek.test.tsx`, `Agents.peek.test.tsx`).
 *
 * Mirrors the SAME shape already duplicated between `useDrivenSession.test.ts`
 * and `DrivenSessionPage.test.tsx` (that pre-existing duplication is
 * documented in `DrivenSessionPage.test.tsx`'s own docblock as an accepted
 * pattern and is left as-is — out of this task's scope). This module exists
 * so the TWO NEW test files this task adds don't grow a third and fourth
 * independent copy: both import `StubWebSocket` from here instead.
 *
 * Not a production module — lives under `lib/` (no dedicated frontend
 * test-utils directory exists yet) alongside the peek's other small pure
 * helpers, matching this codebase's "co-locate, don't invent a new
 * directory for one file" convention (`code-organization` skill).
 */

export type WsListener = (ev: unknown) => void;

export class StubWebSocket {
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

  // Test-only server-simulation helpers.
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

/** The first constructed `StubWebSocket` instance, or throws if none exists yet. */
export function firstStubWs(): StubWebSocket {
  const ws = StubWebSocket.instances[0];
  if (!ws) throw new Error("expected a StubWebSocket instance to have been constructed");
  return ws;
}
