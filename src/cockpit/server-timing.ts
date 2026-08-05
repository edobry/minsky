/**
 * `Server-Timing` emission for cockpit API routes (mt#3696).
 *
 * A browser-side measurement can see how long a request took in total, but not
 * what the server spent that time ON. Splitting "API request wait" from
 * "server-side query time" therefore needs a signal the server itself emits —
 * without one, every server-side phase collapses into one opaque number and a
 * latency investigation can only guess which query is responsible.
 *
 * The mechanism here is the W3C one rather than a bespoke channel: the
 * `Server-Timing` response header, which browsers surface to page scripts at
 * `PerformanceResourceTiming.serverTiming` / `PerformanceNavigationTiming.serverTiming`.
 * That is what lets `scripts/verify-cockpit-navigation-latency.ts` attribute
 * server phases from inside the page, with no second transport and no parallel
 * bookkeeping.
 *
 * `PerformanceServerTiming` is restricted to same-origin responses unless the
 * server also sends `Timing-Allow-Origin`. The cockpit SPA is served by this
 * same daemon and sets no permissive CORS (see the same-origin-only comment
 * block above the `/api` mounts in `./server.ts`), so every measured request is
 * same-origin and no `Timing-Allow-Origin` is required. If the cockpit ever
 * serves its SPA from a different origin than its API, that changes and this
 * comment is the thing to revisit.
 *
 * Emission is unconditional rather than gated behind a debug flag: the header
 * is a few dozen bytes, it carries no data the same-origin caller could not
 * already obtain, and a measurement channel that is off by default is reliably
 * off when someone finally needs it.
 */

/**
 * Characters permitted in an RFC 9110 `token`, which is what the `Server-Timing`
 * grammar requires for a metric name. Anything else is replaced so a caller
 * cannot emit a header that parsers reject (a stray space or comma would
 * silently split one metric into two, or drop the rest of the header).
 */
const TOKEN_UNSAFE = /[^A-Za-z0-9!#$%&'*+\-.^_`|~]/g;

/** Duration precision. Sub-millisecond phases are real and worth keeping. */
const DURATION_DECIMALS = 2;

export interface ServerTimingEntry {
  /** Metric name, already token-safe. */
  readonly name: string;
  /** Wall-clock duration in milliseconds. */
  readonly durationMs: number;
  /** Optional human-readable label. */
  readonly description?: string;
}

/**
 * Coerce an arbitrary label into a `Server-Timing` metric name.
 *
 * Returns `"unnamed"` for input that is empty or entirely unsafe, so the result
 * is always a legal token — an empty name would produce a header the browser
 * discards wholesale, taking every other metric on the line with it.
 */
export function sanitizeMetricName(raw: string): string {
  const cleaned = raw.trim().replace(TOKEN_UNSAFE, "_");
  return cleaned.length > 0 ? cleaned : "unnamed";
}

/**
 * Escape a description for the `quoted-string` production: backslash first (so
 * the escapes this adds are not themselves re-escaped), then the quote.
 */
function quoteDescription(description: string): string {
  return `"${description.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Render entries as a `Server-Timing` header value.
 *
 * Returns `""` for an empty list — callers must not set the header in that
 * case, since an empty header value is not a legal metric list.
 */
export function formatServerTiming(entries: readonly ServerTimingEntry[]): string {
  return entries
    .map((entry) => {
      const parts = [sanitizeMetricName(entry.name)];
      if (entry.description !== undefined && entry.description !== "") {
        parts.push(`desc=${quoteDescription(entry.description)}`);
      }
      // A negative or non-finite duration means the clock misbehaved; clamping
      // keeps a bad sample from producing an unparseable header, and 0 reads
      // as "measured, no time" rather than silently omitting the phase.
      const duration = Number.isFinite(entry.durationMs) ? Math.max(0, entry.durationMs) : 0;
      parts.push(`dur=${duration.toFixed(DURATION_DECIMALS)}`);
      return parts.join(";");
    })
    .join(", ");
}

/** The subset of a response object this module needs — deliberately not `express.Response`. */
export interface HeaderSink {
  setHeader(name: string, value: string): unknown;
  headersSent?: boolean;
}

/**
 * A response {@link ServerTimingRecorder.attachTo} can wrap.
 *
 * `send` is optional so an express `Response` satisfies this without a cast
 * while a hand-rolled test double can supply only `json`.
 */
export interface JsonResponseSink extends HeaderSink {
  json: (body: unknown) => unknown;
  send?: (body?: unknown) => unknown;
}

/**
 * Accumulates per-phase durations for one request.
 *
 * The clock is injected so the formatting and accumulation logic can be tested
 * against exact values rather than against whatever `performance.now()` happens
 * to return.
 */
export class ServerTimingRecorder {
  private readonly entries: ServerTimingEntry[] = [];
  private readonly now: () => number;
  private readonly startedAt: number;

  constructor(now: () => number = () => performance.now()) {
    this.now = now;
    this.startedAt = now();
  }

  /** Record an already-measured phase. */
  record(name: string, durationMs: number, description?: string): void {
    this.entries.push({ name: sanitizeMetricName(name), durationMs, description });
  }

  /**
   * Time an async phase.
   *
   * The duration is recorded in a `finally`, so a phase that throws still shows
   * up in the header — a query that fails slowly is exactly the kind of thing a
   * latency measurement needs to see, and dropping it would make the remaining
   * phases fail to add up with no indication why.
   */
  async time<T>(name: string, fn: () => Promise<T>, description?: string): Promise<T> {
    const start = this.now();
    try {
      return await fn();
    } finally {
      this.record(name, this.now() - start, description);
    }
  }

  /** Total elapsed since construction. Not recorded as an entry until asked for. */
  elapsedMs(): number {
    return this.now() - this.startedAt;
  }

  /** Snapshot of the recorded phases, in the order they completed. */
  toJSON(): readonly ServerTimingEntry[] {
    return [...this.entries];
  }

  /**
   * Header value including a synthesized `total` covering the whole request.
   *
   * `total` is emitted last and computed at call time rather than summed from
   * the phases, so the gap between "time the phases account for" and "time the
   * request actually took" stays visible instead of being defined away.
   */
  toHeader(): string {
    return formatServerTiming([
      ...this.entries,
      { name: "total", durationMs: this.elapsedMs(), description: "handler total" },
    ]);
  }

  /**
   * Set the header on a response, if there is anything to report and the
   * response has not already been flushed. Returns whether it was set, so a
   * caller (or a test) can tell the difference between "emitted" and "too late".
   */
  applyTo(sink: HeaderSink): boolean {
    if (sink.headersSent === true) return false;
    const value = this.toHeader();
    if (value === "") return false;
    sink.setHeader("Server-Timing", value);
    return true;
  }

  /**
   * Make EVERY JSON response from this handler carry the header, by wrapping
   * `json` once so the timing is applied immediately before the body is sent.
   *
   * Called once at the top of a handler instead of calling {@link applyTo} at
   * each exit. The difference matters: a handler has an exit per failure mode
   * (503 when the service is down, 404, 500), and those are precisely the
   * responses someone investigating latency wants attributed — a slow failure
   * is a finding. Applying the header by hand at each `return` leaves the
   * instrumentation only as complete as the author's memory, and the next exit
   * path added silently loses it. This makes it structural instead.
   *
   * Idempotent per response: wrapping twice would apply the timing twice, which
   * is harmless (the second call overwrites the same header) but pointless, so
   * a second call is ignored.
   */
  attachTo(sink: JsonResponseSink): void {
    if (ATTACHED.has(sink)) return;
    ATTACHED.add(sink);

    const originalJson = sink.json.bind(sink);
    sink.json = (body: unknown) => {
      this.applyTo(sink);
      return originalJson(body);
    };

    // `send` too, not only `json` (PR #2639 R1). Every current handler exits
    // via `json`, so this changes nothing today — it exists so a later
    // non-JSON exit (an error page, a redirect body, a plain-text 503) does
    // not silently drop the attribution. `json` internally delegates to
    // `send`, which would double-apply; `applyTo` no-ops once the headers are
    // flushed and is idempotent before that, so the second call is harmless.
    const originalSend = sink.send?.bind(sink);
    if (originalSend) {
      sink.send = (body?: unknown) => {
        this.applyTo(sink);
        return originalSend(body);
      };
    }
  }
}

/**
 * Responses already wrapped by {@link ServerTimingRecorder.attachTo}. Weak so a
 * finished response is not retained — this holds one entry per in-flight
 * request, and a strong set would leak every response object the process ever
 * served.
 */
const ATTACHED = new WeakSet<object>();
