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
 * Reconnect: postgres-js auto-reconnects the underlying connection on loss
 * and re-invokes its `onlisten` callback, so LISTEN registrations re-establish
 * automatically in the typical case. This library's explicit retry loop wraps
 * the INITIAL `sql.listen()` call to absorb startup-time failures (DB unreachable
 * at boot) without forcing the caller to retry.
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
import { log } from "../../utils/logger";

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
// PostgresChannelListener — production implementation
// ---------------------------------------------------------------------------

export class PostgresChannelListener implements ChannelListener {
  private readonly channels = new Map<string, ChannelState>();
  private closed = false;
  private readonly retryConfig: RetryConfig;

  constructor(
    private readonly sql: Sql,
    retryConfig?: Partial<RetryConfig>
  ) {
    this.retryConfig = { ...DEFAULT_RETRY_CONFIG, ...retryConfig };
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

    // Only register one postgres-js LISTEN per channel; the handler multiplexes
    // to all subscriptions in `state.subscriptions`. If this is not the first
    // subscriber, there's nothing more to do.
    if (state.unlisten) {
      return;
    }

    // First subscriber for this channel — establish the postgres-js LISTEN
    // with retry-on-initial-failure. postgres-js auto-reconnects on connection
    // loss and re-establishes the LISTEN itself, so this retry covers only
    // the startup-time path.
    try {
      const handle = await this.listenWithRetry(channel);
      state.unlisten = handle.unlisten;
    } catch (err) {
      // All retries exhausted; remove the subscription so we don't leak a
      // zombie state.subscriptions[] entry without a backing LISTEN.
      this.removeSubscription(channel, subscription);
      throw err;
    }
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

  async close(): Promise<void> {
    this.closed = true;
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
