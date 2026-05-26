/**
 * SSE broker for the cockpit server — mt#1853.
 *
 * Wraps a `ChannelListener` (from mt#1852) and:
 *   - Holds one shared listener instance per cockpit-server process
 *   - Forwards received NOTIFY payloads to connected SSE clients that
 *     match their topic filter
 *   - Maintains a ring buffer (default size 100) of recent events for
 *     `Last-Event-ID` resume on reconnect
 *   - Issues monotonically-incrementing event IDs (as strings)
 *
 * The broker is JS single-threaded so there are no concurrent mutation
 * races between `attachClient` / `detachClient` / `_dispatch`. However,
 * callers should check `client.closed` before each write to guard against
 * clients that closed between dispatch and the actual write.
 *
 * @see src/domain/mesh/postgres-channel-listener.ts  (the underlying listener)
 * @see src/cockpit/topic-filter.ts                   (pattern matching)
 * @see src/cockpit/server.ts                         (HTTP wiring)
 */

import type { ChannelListener } from "@minsky/domain/mesh/postgres-channel-listener";
import { matchesTopic } from "./topic-filter";
import { log } from "@minsky/shared/logger";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** An event stored in the ring buffer and forwarded to SSE clients. */
export interface SseEvent {
  /** Monotonically-incrementing string integer, e.g. "1", "2". */
  id: string;
  /** Postgres NOTIFY channel name. */
  channel: string;
  /** Parsed JSON payload from the NOTIFY. */
  payload: unknown;
  /** ISO-8601 timestamp when the event was received. */
  at: string;
}

/** An SSE client attached to the broker. */
export interface SseClient {
  /** Unique client ID (UUID). */
  id: string;
  /** Topic filter patterns from the `?topics=` query param. */
  topics: string[];
  /** Write an event to this client's SSE stream. */
  send(event: SseEvent): void;
  /** Mark the client as closed; the broker will not call send() after this. */
  close(): void;
  /** True after close() has been called. */
  closed: boolean;
}

/** Options for `SseBroker`. */
export interface SseBrokerOptions {
  /** Maximum number of events stored in the ring buffer. Defaults to 100. */
  ringBufferSize?: number;
}

// ---------------------------------------------------------------------------
// Default ring-buffer size
// ---------------------------------------------------------------------------

const DEFAULT_RING_BUFFER_SIZE = 100;

// ---------------------------------------------------------------------------
// SseBroker
// ---------------------------------------------------------------------------

export class SseBroker {
  private readonly listener: ChannelListener;
  private readonly ringBufferSize: number;

  /** Ring buffer of recent events (oldest first). */
  private readonly ringBuffer: SseEvent[] = [];

  /** Connected SSE clients, indexed by client ID. */
  private readonly clients = new Map<string, SseClient>();

  /** Monotonically-incrementing event counter. */
  private nextId = 1;

  /**
   * Per-channel subscription handles registered with the listener.
   * Value is the listener callback — stored so we can unsubscribe on close().
   */
  private readonly channelHandlers = new Map<string, (channel: string, payload: unknown) => void>();

  constructor(listener: ChannelListener, options?: SseBrokerOptions) {
    this.listener = listener;
    this.ringBufferSize = options?.ringBufferSize ?? DEFAULT_RING_BUFFER_SIZE;
  }

  /**
   * Subscribe the broker to a channel if not already subscribed.
   *
   * Idempotent: calling with an already-subscribed channel is a no-op.
   *
   * @throws if `listener.subscribe()` rejects
   */
  async ensureChannel(channel: string): Promise<void> {
    if (this.channelHandlers.has(channel)) {
      return; // Already subscribed
    }

    const handler = (_ch: string, payload: unknown): void => {
      this._dispatch(channel, payload);
    };

    // Register before subscribing so that even if subscribe is async and
    // dispatch fires synchronously (e.g., recording variant), the handler
    // map is up to date.
    this.channelHandlers.set(channel, handler);

    try {
      await this.listener.subscribe(channel, handler);
    } catch (err) {
      // Roll back the registration if subscribe fails
      this.channelHandlers.delete(channel);
      throw err;
    }
  }

  /**
   * Attach an SSE client to the broker.
   *
   * If `lastEventId` is provided and found in the ring buffer, returns all
   * events in the buffer AFTER that event (for reconnect replay).
   * If `lastEventId` is provided but not found (evicted from ring buffer),
   * returns the full ring buffer contents (best-effort replay).
   * If `lastEventId` is absent or empty, returns an empty array.
   *
   * @returns Array of events to replay immediately to the client.
   */
  attachClient(client: SseClient, lastEventId?: string): SseEvent[] {
    this.clients.set(client.id, client);

    if (!lastEventId || lastEventId === "") {
      return [];
    }

    // Find the index of lastEventId in the ring buffer
    const idx = this.ringBuffer.findIndex((ev) => ev.id === lastEventId);
    if (idx === -1) {
      // Event not found (evicted) — return full buffer as best-effort
      return this.ringBuffer.filter((ev) => matchesTopic(ev.channel, client.topics));
    }

    // Return events AFTER the last-seen event
    return this.ringBuffer.slice(idx + 1).filter((ev) => matchesTopic(ev.channel, client.topics));
  }

  /**
   * Detach and remove an SSE client from the broker.
   *
   * Idempotent: calling with an unknown client ID is a no-op.
   */
  detachClient(clientId: string): void {
    this.clients.delete(clientId);
  }

  /**
   * Return the most recent event for the given channel from the ring buffer,
   * or undefined if no events for that channel have been received.
   *
   * Used by the attention widget's `defaultDepsFactory` to seed the initial
   * active window key from broker state.
   */
  latestForChannel(channel: string): SseEvent | undefined {
    // Scan ring buffer from the end (most recent) to find the latest event
    for (let i = this.ringBuffer.length - 1; i >= 0; i--) {
      const ev = this.ringBuffer[i];
      if (ev && ev.channel === channel) {
        return ev;
      }
    }
    return undefined;
  }

  /**
   * Unsubscribe all channels and mark the broker as closed.
   *
   * Does NOT close individual SSE client connections — callers are
   * responsible for cleaning up HTTP response objects.
   */
  async close(): Promise<void> {
    for (const [channel, handler] of this.channelHandlers.entries()) {
      try {
        await this.listener.unsubscribe(channel, handler);
      } catch (err) {
        log.warn(
          `SseBroker: error unsubscribing channel ${channel} on close(): ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
    }
    this.channelHandlers.clear();
    this.clients.clear();
  }

  // ---------------------------------------------------------------------------
  // Internal dispatch
  // ---------------------------------------------------------------------------

  /**
   * Dispatch a received NOTIFY payload to all matching SSE clients and
   * append it to the ring buffer.
   *
   * Called from the listener callback registered in `ensureChannel`.
   */
  _dispatch(channel: string, payload: unknown): void {
    const event: SseEvent = {
      id: String(this.nextId++),
      channel,
      payload,
      at: new Date().toISOString(),
    };

    // Append to ring buffer, evicting oldest entry if at capacity
    this.ringBuffer.push(event);
    if (this.ringBuffer.length > this.ringBufferSize) {
      this.ringBuffer.shift();
    }

    // Forward to matching clients
    for (const client of this.clients.values()) {
      if (client.closed) {
        // Defensive: client closed but not yet detached
        continue;
      }
      if (matchesTopic(channel, client.topics)) {
        try {
          client.send(event);
        } catch (err) {
          log.warn(
            `SseBroker: error sending event ${event.id} to client ${client.id}: ${
              err instanceof Error ? err.message : String(err)
            }`
          );
        }
      }
    }
  }
}
