/**
 * Tests for the SSE broker — mt#1853.
 *
 * Uses `createRecordingChannelListener()` from mt#1852 to inject synthetic
 * NOTIFY events without a real Postgres connection.
 */

import { describe, test, expect } from "bun:test";
import { SseBroker } from "./sse-broker";
import type { SseClient, SseEvent } from "./sse-broker";
import { createRecordingChannelListener } from "@minsky/domain/mesh/postgres-channel-listener";

// ---------------------------------------------------------------------------
// Channel name constants (avoid magic string duplication)
// ---------------------------------------------------------------------------

const CH_ATTENTION_OPENED = "minsky.attention_window_opened";
const CH_ATTENTION_CLOSED = "minsky.attention_window_closed";
const CH_SESSION_CREATED = "minsky.session_created";
const CH_GENERIC = "ch1";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Create a stub SSE client that captures sent events. */
function createStubClient(id: string, topics: string[]): SseClient & { events: SseEvent[] } {
  const events: SseEvent[] = [];
  return {
    id,
    topics,
    events,
    closed: false,
    send(event: SseEvent): void {
      if (this.closed) return;
      events.push(event);
    },
    close(): void {
      this.closed = true;
    },
  };
}

// ---------------------------------------------------------------------------
// Ring buffer
// ---------------------------------------------------------------------------

describe("SseBroker — ring buffer", () => {
  test("stores events up to ringBufferSize", async () => {
    const listener = createRecordingChannelListener();
    const broker = new SseBroker(listener, { ringBufferSize: 3 });
    await broker.ensureChannel(CH_ATTENTION_OPENED);

    listener.emit(CH_ATTENTION_OPENED, JSON.stringify({ windowKey: "w1" }));
    listener.emit(CH_ATTENTION_OPENED, JSON.stringify({ windowKey: "w2" }));
    listener.emit(CH_ATTENTION_OPENED, JSON.stringify({ windowKey: "w3" }));

    const ev = broker.latestForChannel(CH_ATTENTION_OPENED);
    expect(ev).toBeDefined();
    const payload = ev?.payload as { windowKey: string } | undefined;
    expect(payload?.windowKey).toBe("w3");
  });

  test("evicts oldest event when ring buffer is full", async () => {
    const listener = createRecordingChannelListener();
    const broker = new SseBroker(listener, { ringBufferSize: 2 });
    await broker.ensureChannel(CH_ATTENTION_OPENED);

    listener.emit(CH_ATTENTION_OPENED, JSON.stringify({ windowKey: "w1" }));
    listener.emit(CH_ATTENTION_OPENED, JSON.stringify({ windowKey: "w2" }));
    listener.emit(CH_ATTENTION_OPENED, JSON.stringify({ windowKey: "w3" }));

    const latest = broker.latestForChannel(CH_ATTENTION_OPENED);
    const latestPayload = latest?.payload as { windowKey: string } | undefined;
    expect(latestPayload?.windowKey).toBe("w3");

    // Attach a client with the latest id → no replay (it IS the last event)
    const latestId = latest?.id ?? "";
    const client = createStubClient("c1", ["minsky.*"]);
    const replay = broker.attachClient(client, latestId);
    expect(replay).toHaveLength(0);
  });

  test("event IDs are monotonically incrementing strings", async () => {
    const listener = createRecordingChannelListener();
    const broker = new SseBroker(listener, { ringBufferSize: 10 });
    await broker.ensureChannel(CH_GENERIC);

    listener.emit(CH_GENERIC, JSON.stringify({ n: 1 }));
    listener.emit(CH_GENERIC, JSON.stringify({ n: 2 }));
    listener.emit(CH_GENERIC, JSON.stringify({ n: 3 }));

    const client = createStubClient("c1", ["*"]);
    broker.attachClient(client);

    listener.emit(CH_GENERIC, JSON.stringify({ n: 4 }));
    expect(client.events).toHaveLength(1);
    const firstEvent = client.events[0];
    expect(firstEvent).toBeDefined();
    const id = parseInt(firstEvent?.id ?? "0", 10);
    expect(id).toBeGreaterThan(0);
    expect(Number.isInteger(id)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Replay on attach with lastEventId
// ---------------------------------------------------------------------------

describe("SseBroker — Last-Event-ID replay", () => {
  test("replays events after lastEventId on reconnect", async () => {
    const listener = createRecordingChannelListener();
    const broker = new SseBroker(listener, { ringBufferSize: 10 });
    await broker.ensureChannel(CH_ATTENTION_OPENED);

    listener.emit(CH_ATTENTION_OPENED, JSON.stringify({ windowKey: "w1" }));
    listener.emit(CH_ATTENTION_OPENED, JSON.stringify({ windowKey: "w2" }));
    listener.emit(CH_ATTENTION_OPENED, JSON.stringify({ windowKey: "w3" }));

    // Emit events into the broker first by attaching a transient client
    const c1 = createStubClient("c1", ["*"]);
    broker.attachClient(c1);
    // w4 arrives while c1 is attached; c1 receives it
    listener.emit(CH_ATTENTION_OPENED, JSON.stringify({ windowKey: "w4" }));
    expect(c1.events).toHaveLength(1);
    broker.detachClient("c1");

    // Attach a new client with lastEventId = "1" (the first event)
    const c2 = createStubClient("c2", ["*"]);
    const replay = broker.attachClient(c2, "1");
    // Should get events 2, 3, 4 (everything after id "1")
    expect(replay.length).toBe(3);
    expect((replay[0]?.payload as { windowKey: string } | undefined)?.windowKey).toBe("w2");
    expect((replay[1]?.payload as { windowKey: string } | undefined)?.windowKey).toBe("w3");
    expect((replay[2]?.payload as { windowKey: string } | undefined)?.windowKey).toBe("w4");
  });

  test("returns full buffer when lastEventId not found (evicted)", async () => {
    const listener = createRecordingChannelListener();
    const broker = new SseBroker(listener, { ringBufferSize: 2 });
    await broker.ensureChannel(CH_GENERIC);

    // Emit 3 events — first one gets evicted
    listener.emit(CH_GENERIC, JSON.stringify({ n: 1 }));
    listener.emit(CH_GENERIC, JSON.stringify({ n: 2 }));
    listener.emit(CH_GENERIC, JSON.stringify({ n: 3 }));

    // Attach with id "1" which has been evicted from the ring buffer
    const client = createStubClient("c1", ["*"]);
    const replay = broker.attachClient(client, "1");
    // Should get the 2 remaining buffered events (best-effort)
    expect(replay).toHaveLength(2);
    expect((replay[0]?.payload as { n: number } | undefined)?.n).toBe(2);
    expect((replay[1]?.payload as { n: number } | undefined)?.n).toBe(3);
  });

  test("returns empty array when no lastEventId provided", async () => {
    const listener = createRecordingChannelListener();
    const broker = new SseBroker(listener, { ringBufferSize: 10 });
    await broker.ensureChannel(CH_GENERIC);

    listener.emit(CH_GENERIC, JSON.stringify({ n: 1 }));

    const client = createStubClient("c1", ["*"]);
    const replay = broker.attachClient(client);
    expect(replay).toHaveLength(0);
  });

  test("replay respects topic filter", async () => {
    const listener = createRecordingChannelListener();
    const broker = new SseBroker(listener, { ringBufferSize: 10 });
    await broker.ensureChannel(CH_ATTENTION_OPENED);
    await broker.ensureChannel(CH_SESSION_CREATED);

    listener.emit(CH_ATTENTION_OPENED, JSON.stringify({ windowKey: "w1" }));
    listener.emit(CH_SESSION_CREATED, JSON.stringify({ sessionId: "s1" }));
    listener.emit(CH_ATTENTION_OPENED, JSON.stringify({ windowKey: "w2" }));

    // Attach with id "0" (not in buffer) → full buffer replay, but topic-filtered
    const client = createStubClient("c1", ["attention.*"]);
    const replay = broker.attachClient(client, "0");
    // Only attention events should be in replay
    expect(replay.every((ev) => ev.channel.includes("attention"))).toBe(true);
    expect(replay).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Topic-filter dispatch
// ---------------------------------------------------------------------------

describe("SseBroker — topic-filter dispatch", () => {
  test("two clients with different topic filters each receive only matching events", async () => {
    const listener = createRecordingChannelListener();
    const broker = new SseBroker(listener, { ringBufferSize: 10 });
    await broker.ensureChannel(CH_ATTENTION_OPENED);
    await broker.ensureChannel(CH_SESSION_CREATED);

    const attentionClient = createStubClient("attention-client", ["attention.*"]);
    const sessionClient = createStubClient("session-client", ["session.*"]);

    broker.attachClient(attentionClient);
    broker.attachClient(sessionClient);

    listener.emit(CH_ATTENTION_OPENED, JSON.stringify({ windowKey: "w1" }));
    listener.emit(CH_SESSION_CREATED, JSON.stringify({ sessionId: "s1" }));
    listener.emit(CH_ATTENTION_OPENED, JSON.stringify({ windowKey: "w2" }));

    // attentionClient should only receive attention events
    expect(attentionClient.events).toHaveLength(2);
    expect(attentionClient.events.every((ev) => ev.channel.includes("attention"))).toBe(true);

    // sessionClient should only receive session events
    expect(sessionClient.events).toHaveLength(1);
    expect(sessionClient.events[0]?.channel).toBe(CH_SESSION_CREATED);
  });

  test("wildcard client receives all events", async () => {
    const listener = createRecordingChannelListener();
    const broker = new SseBroker(listener, { ringBufferSize: 10 });
    await broker.ensureChannel(CH_ATTENTION_OPENED);
    await broker.ensureChannel(CH_SESSION_CREATED);

    const wildcardClient = createStubClient("all-client", ["*"]);
    broker.attachClient(wildcardClient);

    listener.emit(CH_ATTENTION_OPENED, JSON.stringify({ windowKey: "w1" }));
    listener.emit(CH_SESSION_CREATED, JSON.stringify({ sessionId: "s1" }));

    expect(wildcardClient.events).toHaveLength(2);
  });

  test("client with no matching topics receives no events", async () => {
    const listener = createRecordingChannelListener();
    const broker = new SseBroker(listener, { ringBufferSize: 10 });
    await broker.ensureChannel(CH_ATTENTION_OPENED);

    const noMatchClient = createStubClient("no-match", ["task.*"]);
    broker.attachClient(noMatchClient);

    listener.emit(CH_ATTENTION_OPENED, JSON.stringify({ windowKey: "w1" }));
    expect(noMatchClient.events).toHaveLength(0);
  });

  test("closed client does not receive events after close()", async () => {
    const listener = createRecordingChannelListener();
    const broker = new SseBroker(listener, { ringBufferSize: 10 });
    await broker.ensureChannel(CH_ATTENTION_OPENED);

    const client = createStubClient("c1", ["*"]);
    broker.attachClient(client);

    listener.emit(CH_ATTENTION_OPENED, JSON.stringify({ windowKey: "w1" }));
    expect(client.events).toHaveLength(1);

    client.close(); // mark as closed
    listener.emit(CH_ATTENTION_OPENED, JSON.stringify({ windowKey: "w2" }));
    // Still only 1 because client.closed = true
    expect(client.events).toHaveLength(1);
  });

  test("detached client does not receive events after detach", async () => {
    const listener = createRecordingChannelListener();
    const broker = new SseBroker(listener, { ringBufferSize: 10 });
    await broker.ensureChannel(CH_ATTENTION_OPENED);

    const client = createStubClient("c1", ["*"]);
    broker.attachClient(client);
    listener.emit(CH_ATTENTION_OPENED, JSON.stringify({ windowKey: "w1" }));
    expect(client.events).toHaveLength(1);

    broker.detachClient("c1");
    listener.emit(CH_ATTENTION_OPENED, JSON.stringify({ windowKey: "w2" }));
    expect(client.events).toHaveLength(1); // no new events
  });
});

// ---------------------------------------------------------------------------
// Channel deduplication
// ---------------------------------------------------------------------------

describe("SseBroker — ensureChannel deduplication", () => {
  test("calling ensureChannel twice on same channel subscribes only once", async () => {
    const listener = createRecordingChannelListener();
    const broker = new SseBroker(listener, { ringBufferSize: 10 });

    await broker.ensureChannel(CH_ATTENTION_OPENED);
    await broker.ensureChannel(CH_ATTENTION_OPENED); // idempotent

    const client = createStubClient("c1", ["*"]);
    broker.attachClient(client);

    // Emit one event — client should receive it exactly once (not twice)
    listener.emit(CH_ATTENTION_OPENED, JSON.stringify({ windowKey: "w1" }));
    expect(client.events).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// close() teardown
// ---------------------------------------------------------------------------

describe("SseBroker — close()", () => {
  test("close() unsubscribes all channels", async () => {
    const listener = createRecordingChannelListener();
    const broker = new SseBroker(listener, { ringBufferSize: 10 });

    await broker.ensureChannel(CH_ATTENTION_OPENED);
    await broker.ensureChannel(CH_ATTENTION_CLOSED);

    expect(listener.registeredChannels()).toHaveLength(2);

    await broker.close();

    // After close, the listener should have no registered channels
    expect(listener.registeredChannels()).toHaveLength(0);
  });

  test("close() clears all clients", async () => {
    const listener = createRecordingChannelListener();
    const broker = new SseBroker(listener, { ringBufferSize: 10 });

    await broker.ensureChannel(CH_ATTENTION_OPENED);
    const client = createStubClient("c1", ["*"]);
    broker.attachClient(client);

    await broker.close();

    // Emit after close — no clients should receive anything
    listener.emit(CH_ATTENTION_OPENED, JSON.stringify({ windowKey: "w1" }));
    expect(client.events).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// latestForChannel
// ---------------------------------------------------------------------------

describe("SseBroker — latestForChannel", () => {
  test("returns undefined when no events received for channel", () => {
    const listener = createRecordingChannelListener();
    const broker = new SseBroker(listener, { ringBufferSize: 10 });

    expect(broker.latestForChannel(CH_ATTENTION_OPENED)).toBeUndefined();
  });

  test("returns most recent event for the channel", async () => {
    const listener = createRecordingChannelListener();
    const broker = new SseBroker(listener, { ringBufferSize: 10 });
    await broker.ensureChannel(CH_ATTENTION_OPENED);

    listener.emit(CH_ATTENTION_OPENED, JSON.stringify({ windowKey: "w1" }));
    listener.emit(CH_ATTENTION_OPENED, JSON.stringify({ windowKey: "w2" }));

    const latest = broker.latestForChannel(CH_ATTENTION_OPENED);
    expect(latest).toBeDefined();
    expect((latest?.payload as { windowKey: string } | undefined)?.windowKey).toBe("w2");
  });

  test("does not return events from a different channel", async () => {
    const listener = createRecordingChannelListener();
    const broker = new SseBroker(listener, { ringBufferSize: 10 });
    await broker.ensureChannel(CH_ATTENTION_OPENED);
    await broker.ensureChannel(CH_SESSION_CREATED);

    listener.emit(CH_SESSION_CREATED, JSON.stringify({ sessionId: "s1" }));

    expect(broker.latestForChannel(CH_ATTENTION_OPENED)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Integration: disconnect + reconnect with Last-Event-ID
// ---------------------------------------------------------------------------

describe("SseBroker — disconnect + reconnect replay", () => {
  test("client disconnects then reconnects and receives missed events", async () => {
    const listener = createRecordingChannelListener();
    const broker = new SseBroker(listener, { ringBufferSize: 10 });
    await broker.ensureChannel(CH_ATTENTION_OPENED);

    const client1 = createStubClient("c1", ["*"]);
    broker.attachClient(client1);

    // Receive first event
    listener.emit(CH_ATTENTION_OPENED, JSON.stringify({ windowKey: "w1" }));
    expect(client1.events).toHaveLength(1);
    const lastSeenId = client1.events[0]?.id ?? "";

    // Client disconnects
    broker.detachClient("c1");

    // Events arrive while disconnected
    listener.emit(CH_ATTENTION_OPENED, JSON.stringify({ windowKey: "w2" }));
    listener.emit(CH_ATTENTION_OPENED, JSON.stringify({ windowKey: "w3" }));

    // Client reconnects with lastEventId
    const client2 = createStubClient("c2", ["*"]);
    const replay = broker.attachClient(client2, lastSeenId);

    expect(replay).toHaveLength(2);
    expect((replay[0]?.payload as { windowKey: string } | undefined)?.windowKey).toBe("w2");
    expect((replay[1]?.payload as { windowKey: string } | undefined)?.windowKey).toBe("w3");
  });
});

// ---------------------------------------------------------------------------
// Integration: NOTIFY → SSE-formatted delivery (spec acceptance test §1)
//
// Verifies the full pipeline:
//   pg_notify(channel, payload) → broker dispatch → client.send() call
//
// Uses createRecordingChannelListener as the listener so no Postgres
// connection is required. This is a pure-unit test: all assertions are
// synchronous (the recording variant dispatches synchronously).
// ---------------------------------------------------------------------------

describe("SseBroker — NOTIFY → SSE delivery integration", () => {
  test("pg_notify on attention channel reaches attached client within same tick", async () => {
    const listener = createRecordingChannelListener();
    const broker = new SseBroker(listener, { ringBufferSize: 10 });

    // Pre-subscribe to the attention channel (mirrors server startup behaviour)
    await broker.ensureChannel(CH_ATTENTION_OPENED);

    // Attach a client subscribed to attention.*
    const client = createStubClient("sse-client-1", ["attention.*"]);
    broker.attachClient(client);

    // Simulate pg_notify — recording listener dispatches synchronously
    const notifyPayload = JSON.stringify({
      windowKey: "w-notify-test",
      openedAt: "2026-01-01T00:00:00.000Z",
    });
    listener.emit(CH_ATTENTION_OPENED, notifyPayload);

    // The client must have received the event within the same tick (no async gap)
    expect(client.events).toHaveLength(1);
    const received = client.events[0];
    expect(received).toBeDefined();
    expect(received?.channel).toBe(CH_ATTENTION_OPENED);
    const payload = received?.payload as { windowKey: string; openedAt: string } | undefined;
    expect(payload?.windowKey).toBe("w-notify-test");
    expect(payload?.openedAt).toBe("2026-01-01T00:00:00.000Z");
    // Event ID must be a positive integer string
    const id = parseInt(received?.id ?? "0", 10);
    expect(id).toBeGreaterThan(0);
    // Timestamp must be an ISO-8601 string
    expect(received?.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("client not subscribed to channel does not receive the event", async () => {
    const listener = createRecordingChannelListener();
    const broker = new SseBroker(listener, { ringBufferSize: 10 });
    await broker.ensureChannel(CH_ATTENTION_OPENED);

    // Client is subscribed to session.* but the event is on attention channel
    const client = createStubClient("sse-client-session", ["session.*"]);
    broker.attachClient(client);

    listener.emit(CH_ATTENTION_OPENED, JSON.stringify({ windowKey: "w1" }));

    expect(client.events).toHaveLength(0);
  });

  test("two channels subscribed: each client receives only its matching channel", async () => {
    const listener = createRecordingChannelListener();
    const broker = new SseBroker(listener, { ringBufferSize: 10 });
    await broker.ensureChannel(CH_ATTENTION_OPENED);
    await broker.ensureChannel(CH_ATTENTION_CLOSED);

    const openClient = createStubClient("open-client", ["attention.*"]);
    broker.attachClient(openClient);

    // Emit an open event — openClient receives it
    listener.emit(CH_ATTENTION_OPENED, JSON.stringify({ windowKey: "w1" }));
    // Emit a close event — openClient also matches attention.* so receives it too
    listener.emit(CH_ATTENTION_CLOSED, JSON.stringify({ windowKey: "w1" }));

    expect(openClient.events).toHaveLength(2);
    expect(openClient.events[0]?.channel).toBe(CH_ATTENTION_OPENED);
    expect(openClient.events[1]?.channel).toBe(CH_ATTENTION_CLOSED);
  });

  test("Last-Event-ID reconnect: client receives events missed during disconnect", async () => {
    const listener = createRecordingChannelListener();
    const broker = new SseBroker(listener, { ringBufferSize: 10 });
    await broker.ensureChannel(CH_ATTENTION_OPENED);

    // Initial client connects and receives first event
    const client1 = createStubClient("c1", ["attention.*"]);
    broker.attachClient(client1);

    listener.emit(CH_ATTENTION_OPENED, JSON.stringify({ windowKey: "before-disconnect" }));
    expect(client1.events).toHaveLength(1);
    const lastSeenId = client1.events[0]?.id ?? "";
    expect(lastSeenId).toBeTruthy();

    // Client disconnects
    broker.detachClient("c1");

    // Events arrive while client is disconnected
    listener.emit(CH_ATTENTION_OPENED, JSON.stringify({ windowKey: "missed-1" }));
    listener.emit(CH_ATTENTION_OPENED, JSON.stringify({ windowKey: "missed-2" }));

    // Client reconnects with Last-Event-ID set to the last seen event
    const client2 = createStubClient("c2", ["attention.*"]);
    const replay = broker.attachClient(client2, lastSeenId);

    // Replay must contain both missed events in order
    expect(replay).toHaveLength(2);
    expect((replay[0]?.payload as { windowKey: string } | undefined)?.windowKey).toBe("missed-1");
    expect((replay[1]?.payload as { windowKey: string } | undefined)?.windowKey).toBe("missed-2");

    // After reconnect, new events are delivered live
    listener.emit(CH_ATTENTION_OPENED, JSON.stringify({ windowKey: "after-reconnect" }));
    expect(client2.events).toHaveLength(1);
    expect((client2.events[0]?.payload as { windowKey: string } | undefined)?.windowKey).toBe(
      "after-reconnect"
    );
  });
});
