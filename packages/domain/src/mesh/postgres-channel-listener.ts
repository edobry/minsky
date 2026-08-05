/**
 * Postgres LISTEN/NOTIFY subscriber library for the mesh signal channel — mt#1852.
 *
 * Provides a `PostgresChannelListener` class that subscribes to one or more
 * Postgres NOTIFY channels via postgres-js's `sql.listen()`, multiplexes
 * multiple listeners per channel, dispatches typed parsed payloads, and
 * handles initial-subscribe failures with exponential-backoff retry.
 *
 * The library takes a `Sql` instance via constructor DI — it does NOT manage
 * connection lifecycle. Callers obtain a session-mode-capable `Sql` from the
 * persistence provider's `getListenCapableSqlConnection()` capability method
 * (Layer A of mt#1852) and pass it in. Provider tears down the connection on
 * `close()`.
 *
 * Reconnect: do NOT rely on postgres-js to restore subscriptions. Its
 * `onclose` handler (node_modules/postgres/src/index.js:156-161, read
 * 2026-08-05) deletes every channel from its own map and then re-listens with
 * the rejection swallowed:
 *
 *     onclose() {
 *       Object.entries(listen.channels).forEach(([name, { listeners }]) => {
 *         delete listen.channels[name]
 *         Promise.all(listeners.map(l => listen(name, l.fn, l.onlisten).catch(() => {})))
 *       })
 *     }
 *
 * So a single unreachable moment during a reconnect drops every subscription
 * permanently, with no error surfaced anywhere. The explicit retry loop below
 * cannot see it either — that loop wraps only the INITIAL `sql.listen()`.
 *
 * Worse, `onclose` fires only on an OBSERVABLE close. A half-open connection
 * (peer gone, no FIN) never triggers it at all, leaving this listener
 * permanently deaf with zero errors — the mt#3092 failure shape, on the one
 * connection mt#3592's bounded socket deliberately does not cover.
 *
 * Both are closed by the heartbeat below (mt#3497): this class detects its own
 * silence and re-establishes every channel from ITS OWN `channels` map, which
 * is authoritative precisely because postgres-js has already discarded its.
 *
 * Foundational for ADR-010's mesh-signal substrate. Consumers: cockpit SSE
 * broker (mt#1853), event-taxonomy emitters' downstream subscribers (mt#1854).
 *
 * Pattern reference: `src/domain/ask/attention-windows/notify.ts`
 * (`createPostgresWindowNotifier` family) is the emit-side template; this
 * library mirrors its injectable + no-op + recording variant shape on the
 * subscribe side.
 */

import type postgres from "postgres";
import { log } from "@minsky/shared/logger";

type Sql = ReturnType<typeof postgres>;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Listener callback shape — receives the channel name and parsed payload. */
export type ChannelListenerFn<T = unknown> = (channel: string, payload: T) => void | Promise<void>;

/** Parser for raw payload strings; defaults to `JSON.parse`. */
export type PayloadParser<T = unknown> = (raw: string) => T;

/** Per-subscription options. */
export interface SubscribeOptions<T = unknown> {
  /** Override the default `JSON.parse` payload parser. */
  parse?: PayloadParser<T>;
}

/**
 * Common interface implemented by `PostgresChannelListener` (production) and
 * the no-op / recording test variants.
 */
export interface ChannelListener {
  subscribe<T = unknown>(
    channel: string,
    listener: ChannelListenerFn<T>,
    opts?: SubscribeOptions<T>
  ): Promise<void>;
  unsubscribe(channel: string, listener: ChannelListenerFn<unknown>): Promise<void>;
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Internal subscription record
// ---------------------------------------------------------------------------

interface Subscription {
  listener: ChannelListenerFn<unknown>;
  parse?: PayloadParser<unknown>;
}

interface ChannelState {
  subscriptions: Subscription[];
  /** postgres-js listen handle; present once `sql.listen()` resolved. */
  unlisten?: () => Promise<void>;
  /**
   * In-flight `sql.listen()` promise. Set by the first concurrent subscriber;
   * subsequent concurrent subscribers `await` it instead of calling
   * `sql.listen()` themselves. Cleared when the promise settles.
   */
  inFlight?: Promise<void>;
}

// ---------------------------------------------------------------------------
// Reconnect-backoff parameters
// ---------------------------------------------------------------------------

/**
 * Retry/backoff configuration for initial `sql.listen()` failures. Sensible
 * defaults cover production startup-time DB unreachability; tests inject tiny
 * values to keep the suite fast.
 */
export interface RetryConfig {
  initialBackoffMs: number;
  maxBackoffMs: number;
  backoffMultiplier: number;
  maxAttempts: number;
}

const DEFAULT_RETRY_CONFIG: RetryConfig = {
  initialBackoffMs: 100,
  maxBackoffMs: 30_000,
  backoffMultiplier: 2,
  maxAttempts: 10,
};

// ---------------------------------------------------------------------------
// Heartbeat / liveness (mt#3497)
// ---------------------------------------------------------------------------

/** Channel the liveness heartbeat is published on. */
export const HEARTBEAT_CHANNEL = "minsky.mesh.heartbeat";

/**
 * Liveness configuration. Optional: without it the listener behaves exactly as
 * before (no heartbeat, no self-reconnect), which is what the no-Postgres and
 * unit-test paths want.
 *
 * Both collaborators are INJECTED rather than reached for, so a test can drive
 * the whole state machine without a database (`testing-standards §Testable
 * Design`).
 */
export interface HeartbeatConfig {
  /**
   * Publish a heartbeat. MUST go through the POOLED (transaction-mode)
   * connection, not the session connection this listener holds — the whole
   * point is to detect that the session connection has stopped delivering, so
   * emitting over it would make the probe unable to fail (mem#704).
   */
  emit: (channel: string, payload: string) => Promise<void>;
  /**
   * Open a FRESH session-mode connection, replacing the one judged dead.
   * Typically `() => provider.getListenCapableSqlConnection()` after the
   * provider has dropped its cached handle.
   */
  reopen: () => Promise<Sql>;
  /** Interval between ticks. Only used by `startHeartbeat()`'s timer. */
  intervalMs: number;
  /** Consecutive missed beats tolerated before reconnecting. */
  missesBeforeReconnect: number;
}

const DEFAULT_HEARTBEAT: Pick<HeartbeatConfig, "intervalMs" | "missesBeforeReconnect"> = {
  // 30s: fast enough that a wedged broker is caught inside a poll cycle,
  // slow enough that the extra NOTIFY traffic is negligible. Grounded in the
  // cockpit's existing widget-poll cadence rather than a round number.
  intervalMs: 30_000,
  missesBeforeReconnect: 2,
};

/**
 * Outcome of one heartbeat tick. Returned (not just logged) so tests assert on
 * the decision directly instead of patching a collaborator to observe it.
 */
export type HeartbeatTickResult =
  | { action: "skipped"; reason: "closed" | "not-configured" }
  | { action: "alive"; missedBeats: 0 }
  | { action: "missed"; missedBeats: number }
  | { action: "reconnected"; channels: string[] }
  | { action: "reconnect-failed"; error: string };

// ---------------------------------------------------------------------------
// PostgresChannelListener — production implementation
// ---------------------------------------------------------------------------

export class PostgresChannelListener implements ChannelListener {
  private readonly channels = new Map<string, ChannelState>();
  private closed = false;
  private readonly retryConfig: RetryConfig;

  /**
   * NOT readonly: `reconnect()` swaps in a fresh connection after the current
   * one is judged dead. Every `sql.listen()` call below goes through this
   * field so a swap is picked up by subsequent re-establishes.
   */
  private sql: Sql;

  private readonly heartbeat?: HeartbeatConfig;
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  /**
   * Beat accounting is a monotonic SEQUENCE, deliberately not a clock.
   * Timestamps fail here: `Date.now()` has millisecond granularity, so an emit
   * and a receipt landing in the same millisecond compare equal and a beat
   * that was never delivered reads as "alive". A counter cannot tie.
   */
  private beatSeq = 0;
  /** Highest sequence actually published. */
  private lastEmittedSeq = 0;
  /** Highest sequence observed coming back through the session connection. */
  private lastReceivedSeq = 0;
  private missedBeats = 0;

  constructor(sql: Sql, retryConfig?: Partial<RetryConfig>, heartbeat?: Partial<HeartbeatConfig>) {
    this.sql = sql;
    this.retryConfig = { ...DEFAULT_RETRY_CONFIG, ...retryConfig };
    // A heartbeat is only usable with BOTH collaborators; a partial config is
    // treated as absent rather than half-armed.
    this.heartbeat =
      heartbeat?.emit && heartbeat?.reopen
        ? ({ ...DEFAULT_HEARTBEAT, ...heartbeat } as HeartbeatConfig)
        : undefined;
  }

  async subscribe<T = unknown>(
    channel: string,
    listener: ChannelListenerFn<T>,
    opts?: SubscribeOptions<T>
  ): Promise<void> {
    if (this.closed) {
      throw new Error("PostgresChannelListener: cannot subscribe after close()");
    }

    const subscription: Subscription = {
      listener: listener as ChannelListenerFn<unknown>,
      parse: opts?.parse as PayloadParser<unknown> | undefined,
    };

    let state = this.channels.get(channel);
    if (!state) {
      state = { subscriptions: [] };
      this.channels.set(channel, state);
    }

    state.subscriptions.push(subscription);

    // LISTEN already established — multiplex onto it.
    if (state.unlisten) {
      return;
    }

    // LISTEN being established by an earlier concurrent caller — await the
    // same in-flight promise instead of issuing a duplicate `sql.listen()`.
    // This enforces the single-LISTEN-per-channel invariant under concurrent
    // subscribe() calls (PR #1135 R1 BLOCKING — fix per reviewer-bot).
    if (state.inFlight) {
      try {
        await state.inFlight;
      } catch (err) {
        this.removeSubscription(channel, subscription);
        throw err;
      }
      return;
    }

    // First subscriber for this channel — establish the postgres-js LISTEN.
    // Set the in-flight marker BEFORE awaiting so concurrent subscribe() calls
    // see it and wait. postgres-js auto-reconnects on connection loss and
    // re-establishes the LISTEN; this retry path covers startup-time failures.
    const promise = this.establishListen(channel).finally(() => {
      const s = this.channels.get(channel);
      if (s) {
        s.inFlight = undefined;
      }
    });
    state.inFlight = promise;

    try {
      await promise;
    } catch (err) {
      this.removeSubscription(channel, subscription);
      throw err;
    }
  }

  /**
   * Establish the postgres-js LISTEN for a channel and store the unlisten
   * handle on the channel state. Handles three races at handle-receipt time:
   *   - `close()` was called during the await → unlisten immediately.
   *   - All subscribers unsubscribed during the await → unlisten immediately.
   *   - Channel state was removed → unlisten immediately.
   * Otherwise, the handle is stored on the channel state for future teardown.
   */
  private async establishListen(channel: string): Promise<void> {
    const handle = await this.listenWithRetry(channel);
    const state = this.channels.get(channel);
    if (this.closed || !state || state.subscriptions.length === 0) {
      try {
        await handle.unlisten();
      } catch (err) {
        log.warn(
          `PostgresChannelListener: post-establish unlisten on ${channel} failed: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
      if (state && state.subscriptions.length === 0) {
        this.channels.delete(channel);
      }
      return;
    }
    state.unlisten = handle.unlisten;
  }

  async unsubscribe(channel: string, listener: ChannelListenerFn<unknown>): Promise<void> {
    const state = this.channels.get(channel);
    if (!state) {
      return;
    }

    const idx = state.subscriptions.findIndex((s) => s.listener === listener);
    if (idx === -1) {
      return;
    }
    state.subscriptions.splice(idx, 1);

    // If no subscriptions remain, tear down the postgres-js LISTEN.
    if (state.subscriptions.length === 0) {
      this.channels.delete(channel);
      if (state.unlisten) {
        try {
          await state.unlisten();
        } catch (err) {
          log.warn(
            `PostgresChannelListener: error during unlisten on ${channel}: ${
              err instanceof Error ? err.message : String(err)
            }`
          );
        }
      }
    }
  }

  /**
   * Arm the liveness heartbeat. Idempotent, and a no-op when no heartbeat was
   * configured — callers may invoke it unconditionally.
   */
  async startHeartbeat(): Promise<void> {
    if (!this.heartbeat || this.heartbeatTimer || this.closed) {
      return;
    }

    // Subscribed through the normal path so the heartbeat channel lives in
    // `this.channels` and is itself re-established by reconnect().
    await this.subscribe(
      HEARTBEAT_CHANNEL,
      (_channel: string, payload: string) => {
        const seq = Number(payload);
        if (Number.isFinite(seq) && seq > this.lastReceivedSeq) {
          this.lastReceivedSeq = seq;
        }
      },
      { parse: (raw: string) => raw }
    );

    this.heartbeatTimer = setInterval(() => {
      void this.heartbeatTick();
    }, this.heartbeat.intervalMs);
    // A liveness timer must not be what keeps the process alive.
    this.heartbeatTimer.unref?.();
  }

  /** Disarm the heartbeat timer. Safe to call when never armed. */
  stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }

  /**
   * One liveness evaluation, exposed publicly so tests drive the state machine
   * directly instead of waiting on wall-clock timers.
   *
   * Ordering is deliberate: a tick judges the PREVIOUS tick's beat and only
   * then publishes the next one. Judging the beat it just published would race
   * the NOTIFY round-trip and report a false miss on every tick.
   */
  async heartbeatTick(): Promise<HeartbeatTickResult> {
    if (this.closed) {
      return { action: "skipped", reason: "closed" };
    }
    const hb = this.heartbeat;
    if (!hb) {
      return { action: "skipped", reason: "not-configured" };
    }

    if (this.lastEmittedSeq > 0) {
      if (this.lastReceivedSeq >= this.lastEmittedSeq) {
        this.missedBeats = 0;
      } else {
        this.missedBeats++;
      }
    }

    if (this.missedBeats >= hb.missesBeforeReconnect) {
      try {
        const channels = await this.reconnect();
        return { action: "reconnected", channels };
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        log.error(`PostgresChannelListener: heartbeat reconnect failed: ${error}`);
        return { action: "reconnect-failed", error };
      }
    }

    try {
      const seq = this.beatSeq + 1;
      await hb.emit(HEARTBEAT_CHANNEL, String(seq));
      // Advance ONLY after a successful publish, so a failed emit leaves the
      // next tick re-judging the last beat we actually sent.
      this.beatSeq = seq;
      this.lastEmittedSeq = seq;
    } catch (err) {
      // Deliberately does NOT count as a missed beat. A failed publish is a
      // POOLED-connection problem; it says nothing about whether the session
      // connection is still delivering. Counting it would let an unrelated
      // outage tear down a healthy LISTEN. Because lastBeatEmittedAt is left
      // unadvanced, the next tick re-judges the last beat we actually sent.
      log.warn(
        `PostgresChannelListener: heartbeat emit failed (not counted as a missed beat): ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }

    return this.missedBeats === 0
      ? { action: "alive", missedBeats: 0 }
      : { action: "missed", missedBeats: this.missedBeats };
  }

  /**
   * Replace the session connection and re-establish every channel from THIS
   * class's own map.
   *
   * postgres-js's internal channel map is deliberately not consulted: by the
   * time we reach here it has already deleted those entries and swallowed the
   * re-listen failures (see the file header). Ours is the only surviving
   * record of what was subscribed.
   */
  private async reconnect(): Promise<string[]> {
    const hb = this.heartbeat;
    if (!hb) {
      return [];
    }

    const previous = this.sql;
    try {
      await previous.end({ timeout: 0 });
    } catch (err) {
      // A connection we have already judged dead may well fail to close
      // cleanly; that must not block reopening.
      log.warn(
        `PostgresChannelListener: closing the wedged connection failed: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }

    this.sql = await hb.reopen();

    const channels = Array.from(this.channels.keys());
    for (const channel of channels) {
      const state = this.channels.get(channel);
      if (!state) {
        continue;
      }
      state.unlisten = undefined;
      const handle = await this.listenWithRetry(channel);
      state.unlisten = handle.unlisten;
    }

    // `beatSeq` stays monotonic across reconnects; the emitted/received marks
    // reset so the first tick on the fresh connection has nothing to judge.
    this.missedBeats = 0;
    this.lastEmittedSeq = 0;
    this.lastReceivedSeq = 0;
    log.info(
      `PostgresChannelListener: reconnected; re-established ${channels.length} channel(s): ${channels.join(", ")}`
    );
    return channels;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.stopHeartbeat();
    const channels = Array.from(this.channels.entries());
    this.channels.clear();
    for (const [channel, state] of channels) {
      if (state.unlisten) {
        try {
          await state.unlisten();
        } catch (err) {
          log.warn(
            `PostgresChannelListener: error during close() unlisten on ${channel}: ${
              err instanceof Error ? err.message : String(err)
            }`
          );
        }
      }
    }
  }

  /**
   * Establish a postgres-js LISTEN with exponential-backoff retry. Returns the
   * postgres-js listen handle (with `.unlisten()`).
   */
  private async listenWithRetry(channel: string): Promise<{ unlisten: () => Promise<void> }> {
    const { initialBackoffMs, maxBackoffMs, backoffMultiplier, maxAttempts } = this.retryConfig;
    let attempt = 0;
    let backoff = initialBackoffMs;
    let lastErr: unknown;

    while (attempt < maxAttempts) {
      try {
        const handle = await this.sql.listen(channel, (payload: string) =>
          this.dispatch(channel, payload)
        );
        if (attempt > 0) {
          log.info(
            `PostgresChannelListener: LISTEN ${channel} established after ${attempt} retries`
          );
        }
        return handle as { unlisten: () => Promise<void> };
      } catch (err) {
        lastErr = err;
        attempt++;
        if (this.closed) {
          throw new Error("PostgresChannelListener: closed during listen retry");
        }
        if (attempt >= maxAttempts) {
          break;
        }
        log.warn(
          `PostgresChannelListener: LISTEN ${channel} attempt ${attempt} failed (${
            err instanceof Error ? err.message : String(err)
          }); retrying in ${backoff}ms`
        );
        await sleep(backoff);
        backoff = Math.min(backoff * backoffMultiplier, maxBackoffMs);
      }
    }

    throw new Error(
      `PostgresChannelListener: LISTEN ${channel} failed after ${maxAttempts} attempts: ${
        lastErr instanceof Error ? lastErr.message : String(lastErr)
      }`
    );
  }

  /**
   * Multiplex a single NOTIFY payload to all subscribers for this channel.
   * Per-listener errors are logged but do not interrupt dispatch to siblings.
   * Parse errors short-circuit dispatch for that one payload.
   */
  private dispatch(channel: string, raw: string): void {
    const state = this.channels.get(channel);
    if (!state || state.subscriptions.length === 0) {
      return;
    }

    // Snapshot subscriptions to avoid mutation-during-iteration if a listener
    // calls back into subscribe/unsubscribe.
    const subs = state.subscriptions.slice();
    for (const sub of subs) {
      let parsed: unknown;
      try {
        parsed = sub.parse ? sub.parse(raw) : JSON.parse(raw);
      } catch (err) {
        log.warn(
          `PostgresChannelListener: parse error on ${channel} (skipping listener): ${
            err instanceof Error ? err.message : String(err)
          }`
        );
        continue;
      }
      try {
        const result = sub.listener(channel, parsed);
        if (result instanceof Promise) {
          result.catch((err) => {
            log.warn(
              `PostgresChannelListener: async listener error on ${channel}: ${
                err instanceof Error ? err.message : String(err)
              }`
            );
          });
        }
      } catch (err) {
        log.warn(
          `PostgresChannelListener: sync listener error on ${channel}: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
    }
  }

  private removeSubscription(channel: string, subscription: Subscription): void {
    const state = this.channels.get(channel);
    if (!state) return;
    const idx = state.subscriptions.indexOf(subscription);
    if (idx >= 0) {
      state.subscriptions.splice(idx, 1);
    }
    if (state.subscriptions.length === 0) {
      this.channels.delete(channel);
    }
  }
}

// ---------------------------------------------------------------------------
// No-op variant — for environments without Postgres (tests, offline CLI)
// ---------------------------------------------------------------------------

/**
 * Returns a no-op `ChannelListener`. All subscribe / unsubscribe / close calls
 * are accepted silently; no Postgres connection is required.
 *
 * Use in tests or bare-CLI flows where the mesh signal channel is unwired.
 */
export function createNoopChannelListener(): ChannelListener {
  return {
    async subscribe(): Promise<void> {},
    async unsubscribe(): Promise<void> {},
    async close(): Promise<void> {},
  };
}

// ---------------------------------------------------------------------------
// Recording variant — for unit tests
// ---------------------------------------------------------------------------

export interface CapturedEvent {
  channel: string;
  payload: unknown;
}

export interface RecordingChannelListener extends ChannelListener {
  /**
   * Inject a raw NOTIFY payload onto a channel, as if Postgres had delivered
   * it. Dispatches synchronously to all subscribers (with per-subscription
   * parse application).
   */
  emit(channel: string, raw: string): void;

  /** All payloads delivered to registered listeners. */
  readonly capturedEvents: CapturedEvent[];

  /** Snapshot of currently-registered channels. */
  readonly registeredChannels: () => string[];
}

/**
 * Returns a `ChannelListener` that records every payload delivered to its
 * subscribers. Used in unit tests to verify dispatch shape without a real
 * Postgres connection. Supports `emit()` for injecting NOTIFY payloads.
 */
export function createRecordingChannelListener(): RecordingChannelListener {
  const channels = new Map<string, Subscription[]>();
  const captured: CapturedEvent[] = [];
  let closed = false;

  function dispatch(channel: string, raw: string): void {
    const subs = channels.get(channel);
    if (!subs || subs.length === 0) {
      return;
    }
    for (const sub of subs.slice()) {
      let parsed: unknown;
      try {
        parsed = sub.parse ? sub.parse(raw) : JSON.parse(raw);
      } catch (err) {
        log.warn(
          `RecordingChannelListener: parse error on ${channel} (skipping listener): ${
            err instanceof Error ? err.message : String(err)
          }`
        );
        continue;
      }
      captured.push({ channel, payload: parsed });
      try {
        const result = sub.listener(channel, parsed);
        if (result instanceof Promise) {
          result.catch(() => {
            // Errors swallowed in recording variant; tests assert on captured.
          });
        }
      } catch {
        // Errors swallowed in recording variant.
      }
    }
  }

  return {
    capturedEvents: captured,
    registeredChannels: () => Array.from(channels.keys()),

    async subscribe<T = unknown>(
      channel: string,
      listener: ChannelListenerFn<T>,
      opts?: SubscribeOptions<T>
    ): Promise<void> {
      if (closed) {
        throw new Error("RecordingChannelListener: cannot subscribe after close()");
      }
      const list = channels.get(channel) ?? [];
      list.push({
        listener: listener as ChannelListenerFn<unknown>,
        parse: opts?.parse as PayloadParser<unknown> | undefined,
      });
      channels.set(channel, list);
    },

    async unsubscribe(channel: string, listener: ChannelListenerFn<unknown>): Promise<void> {
      const list = channels.get(channel);
      if (!list) return;
      const idx = list.findIndex((s) => s.listener === listener);
      if (idx === -1) return;
      list.splice(idx, 1);
      if (list.length === 0) {
        channels.delete(channel);
      }
    },

    async close(): Promise<void> {
      closed = true;
      channels.clear();
    },

    emit(channel: string, raw: string): void {
      dispatch(channel, raw);
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
