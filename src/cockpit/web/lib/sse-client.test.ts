/**
 * Unit tests for the SSE client adapter — mt#1148 Stage 2.
 *
 * Uses a stub EventSource class to test connection lifecycle, message
 * parsing, and error handling without a live server.
 */
import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { createCockpitSseClient } from "./sse-client";
import type { CockpitSseEvent } from "./sse-client";

// ---------------------------------------------------------------------------
// Stub EventSource
// ---------------------------------------------------------------------------

type EventListener = (event: MessageEvent | Event) => void;

class StubEventSource {
  static instances: StubEventSource[] = [];

  url: string;
  readyState: number = 0; // CONNECTING
  private listeners: Map<string, EventListener[]> = new Map();

  constructor(url: string) {
    this.url = url;
    StubEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: EventListener): void {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, []);
    }
    const bucket = this.listeners.get(type);
    if (bucket) bucket.push(listener);
  }

  removeEventListener(type: string, listener: EventListener): void {
    const existing = this.listeners.get(type);
    if (existing) {
      const idx = existing.indexOf(listener);
      if (idx !== -1) {
        existing.splice(idx, 1);
      }
    }
  }

  close(): void {
    this.readyState = 2; // CLOSED
  }

  /** Test helper: simulate an open event. */
  _simulateOpen(): void {
    this.readyState = 1; // OPEN
    for (const listener of this.listeners.get("open") ?? []) {
      listener(new Event("open"));
    }
  }

  /** Test helper: simulate a message event with raw data string. */
  _simulateMessage(data: string): void {
    const event = new MessageEvent("message", { data });
    for (const listener of this.listeners.get("message") ?? []) {
      listener(event);
    }
  }

  /** Test helper: simulate an error event. */
  _simulateError(): void {
    this.readyState = 0; // CONNECTING (auto-reconnect)
    for (const listener of this.listeners.get("error") ?? []) {
      listener(new Event("error"));
    }
  }
}

// ---------------------------------------------------------------------------
// Install / remove stub
// ---------------------------------------------------------------------------

let originalEventSource: typeof globalThis.EventSource;

beforeEach(() => {
  StubEventSource.instances = [];
  originalEventSource = globalThis.EventSource;
  // @ts-expect-error — replacing EventSource with a stub for testing
  globalThis.EventSource = StubEventSource;
});

afterEach(() => {
  globalThis.EventSource = originalEventSource;
  StubEventSource.instances = [];
});

// ---------------------------------------------------------------------------
// Helper to get the most recently created StubEventSource
// ---------------------------------------------------------------------------

function lastStub(): StubEventSource {
  const stub = StubEventSource.instances[StubEventSource.instances.length - 1];
  if (!stub) throw new Error("No StubEventSource created yet");
  return stub;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createCockpitSseClient", () => {
  describe("connect()", () => {
    it("creates EventSource with default URL and topics=* when topics omitted", () => {
      const client = createCockpitSseClient({ onEvent: () => {} });
      client.connect();
      const stub = lastStub();
      expect(stub.url).toBe("/api/events?topics=*");
    });

    it("encodes multiple topics as comma-separated in the URL", () => {
      const client = createCockpitSseClient({
        topics: ["attention.*", "session.*"],
        onEvent: () => {},
      });
      client.connect();
      const stub = lastStub();
      // URL-encoded comma is %2C
      expect(stub.url).toBe("/api/events?topics=attention.*%2Csession.*");
    });

    it("uses custom url when provided", () => {
      const client = createCockpitSseClient({
        url: "/custom/events",
        onEvent: () => {},
      });
      client.connect();
      const stub = lastStub();
      expect(stub.url).toContain("/custom/events");
    });

    it("is idempotent — calling connect() twice does not create two EventSources", () => {
      const client = createCockpitSseClient({ onEvent: () => {} });
      client.connect();
      client.connect();
      expect(StubEventSource.instances).toHaveLength(1);
    });
  });

  describe("connected state", () => {
    it("starts as false before connect()", () => {
      const client = createCockpitSseClient({ onEvent: () => {} });
      expect(client.connected).toBe(false);
    });

    it("becomes true when open event fires", () => {
      const client = createCockpitSseClient({ onEvent: () => {} });
      client.connect();
      lastStub()._simulateOpen();
      expect(client.connected).toBe(true);
    });

    it("becomes false after disconnect()", () => {
      const client = createCockpitSseClient({ onEvent: () => {} });
      client.connect();
      lastStub()._simulateOpen();
      client.disconnect();
      expect(client.connected).toBe(false);
    });

    it("becomes false after error event", () => {
      const client = createCockpitSseClient({ onEvent: () => {} });
      client.connect();
      lastStub()._simulateOpen();
      lastStub()._simulateError();
      expect(client.connected).toBe(false);
    });
  });

  describe("onConnect callback", () => {
    it("is called when open event fires", () => {
      const onConnect = mock(() => {});
      const client = createCockpitSseClient({ onEvent: () => {}, onConnect });
      client.connect();
      lastStub()._simulateOpen();
      expect(onConnect).toHaveBeenCalledTimes(1);
    });
  });

  describe("onDisconnect callback", () => {
    it("is called with 'error' when error event fires", () => {
      let reason: string | undefined;
      const client = createCockpitSseClient({
        onEvent: () => {},
        onDisconnect: (r) => {
          reason = r;
        },
      });
      client.connect();
      lastStub()._simulateError();
      expect(reason).toBe("error");
    });

    it("is called with 'manual' when disconnect() is called", () => {
      let reason: string | undefined;
      const client = createCockpitSseClient({
        onEvent: () => {},
        onDisconnect: (r) => {
          reason = r;
        },
      });
      client.connect();
      client.disconnect();
      expect(reason).toBe("manual");
    });
  });

  describe("message handling", () => {
    it("parses valid SSE event data and calls onEvent", () => {
      const received: CockpitSseEvent[] = [];
      const client = createCockpitSseClient({
        onEvent: (ev) => received.push(ev),
      });
      client.connect();

      const eventData: CockpitSseEvent = {
        id: "42",
        channel: "minsky.attention_window_opened",
        payload: { windowKey: "k1" },
        at: "2026-05-15T10:00:00.000Z",
      };
      lastStub()._simulateMessage(JSON.stringify(eventData));

      expect(received).toHaveLength(1);
      expect(received[0]).toEqual(eventData);
    });

    it("skips malformed JSON without throwing and calls onParseError", () => {
      const received: CockpitSseEvent[] = [];
      const parseErrors: Array<[string, string]> = [];
      const client = createCockpitSseClient({
        onEvent: (ev) => received.push(ev),
        onParseError: (raw, reason) => parseErrors.push([raw, reason]),
      });
      client.connect();
      lastStub()._simulateMessage("not-json}{{");
      expect(received).toHaveLength(0);
      expect(parseErrors).toHaveLength(1);
      const firstJsonParseError = parseErrors[0];
      expect(firstJsonParseError?.[1]).toBe("json_parse");
    });

    it("skips events missing required fields without throwing and calls onParseError", () => {
      const received: CockpitSseEvent[] = [];
      const parseErrors: Array<[string, string]> = [];
      const client = createCockpitSseClient({
        onEvent: (ev) => received.push(ev),
        onParseError: (raw, reason) => parseErrors.push([raw, reason]),
      });
      client.connect();
      // Missing `id` field
      lastStub()._simulateMessage(
        JSON.stringify({ channel: "minsky.foo", payload: {}, at: "2026-05-15T10:00:00Z" })
      );
      expect(received).toHaveLength(0);
      expect(parseErrors).toHaveLength(1);
      const firstMissingFieldError = parseErrors[0];
      expect(firstMissingFieldError?.[1]).toBe("missing_fields");
    });

    it("skips malformed JSON silently when onParseError is not provided", () => {
      const received: CockpitSseEvent[] = [];
      const client = createCockpitSseClient({ onEvent: (ev) => received.push(ev) });
      client.connect();
      expect(() => lastStub()._simulateMessage("not-json}{{")).not.toThrow();
      expect(received).toHaveLength(0);
    });

    it("handles multiple consecutive messages correctly", () => {
      const received: CockpitSseEvent[] = [];
      const client = createCockpitSseClient({ onEvent: (ev) => received.push(ev) });
      client.connect();

      const stub = lastStub();
      const base = {
        channel: "minsky.attention_window_opened",
        payload: null,
        at: "2026-05-15T10:00:00Z",
      };
      stub._simulateMessage(JSON.stringify({ ...base, id: "1" }));
      stub._simulateMessage(JSON.stringify({ ...base, id: "2" }));
      stub._simulateMessage(JSON.stringify({ ...base, id: "3" }));

      expect(received).toHaveLength(3);
      expect(received.map((e) => e.id)).toEqual(["1", "2", "3"]);
    });
  });

  describe("disconnect()", () => {
    it("closes the underlying EventSource", () => {
      const client = createCockpitSseClient({ onEvent: () => {} });
      client.connect();
      const stub = lastStub();
      client.disconnect();
      expect(stub.readyState).toBe(2); // CLOSED
    });

    it("is idempotent — calling disconnect() twice does not throw", () => {
      const client = createCockpitSseClient({ onEvent: () => {} });
      client.connect();
      client.disconnect();
      expect(() => client.disconnect()).not.toThrow();
    });

    it("after disconnect, connect() creates a new EventSource", () => {
      const client = createCockpitSseClient({ onEvent: () => {} });
      client.connect();
      client.disconnect();
      client.connect();
      // Two instances: one from first connect, one from second
      expect(StubEventSource.instances).toHaveLength(2);
    });
  });
});
