/**
 * SSE client adapter for the Cockpit frontend — mt#1148 Stage 2.
 *
 * Wraps the browser EventSource API to connect to `/api/events` and
 * dispatch parsed SSE events to a caller-provided callback. When the
 * connection drops, the browser's native EventSource auto-reconnects
 * and sends the `Last-Event-ID` header; the server's ring buffer replays
 * missed events on reconnect.
 *
 * Widgets continue to use their existing `refetchInterval` as a fallback
 * — this adapter only drives cache invalidation via `queryClient.invalidateQueries`
 * for faster-than-polling updates.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Parsed payload from a single SSE `message` event. */
export interface CockpitSseEvent {
  /** Monotonically-incrementing ID string from the broker. */
  id: string;
  /** Postgres NOTIFY channel name, e.g. `minsky.attention_window_opened`. */
  channel: string;
  /** Parsed JSON payload. */
  payload: unknown;
  /** ISO-8601 timestamp from the broker. */
  at: string;
}

/** Options for `createCockpitSseClient`. */
export interface SseClientOptions {
  /**
   * SSE endpoint URL. Defaults to `/api/events` (relative, works in
   * both dev and production via Vite's proxy and the Express server).
   */
  url?: string;
  /**
   * Topic filter patterns sent as `?topics=<comma-separated>`.
   * Defaults to `["*"]` (subscribe to all channels).
   *
   * Patterns support:
   *   - `*`              — match everything
   *   - `minsky.*`       — match all `minsky.` channels
   *   - `attention.*`    — cross-namespace match on any channel containing `.attention`
   *   - exact strings   — match a single channel name
   */
  topics?: string[];
  /**
   * Called for every successfully parsed SSE event.
   * Guaranteed not to be called with a malformed event — parse errors are
   * silently skipped (see `onParseError` for diagnostics).
   */
  onEvent: (event: CockpitSseEvent) => void;
  /** Called when the EventSource connection opens (or re-opens after reconnect). */
  onConnect?: () => void;
  /**
   * Called when the EventSource enters an error state.
   * EventSource will still auto-reconnect; this is informational only.
   * `reason` is always `"error"` from native EventSource errors.
   */
  onDisconnect?: (reason: "error" | "manual") => void;
  /**
   * Called when a message fails to parse or is missing required fields.
   * Defaults to a no-op. Use this to integrate with your telemetry or
   * debug logging system. Malformed events are always silently skipped.
   */
  onParseError?: (raw: string, reason: "json_parse" | "missing_fields") => void;
}

/** Handle returned by `createCockpitSseClient`. */
export interface SseClient {
  /** Open the SSE connection. Idempotent — no-op if already connected. */
  connect(): void;
  /** Close the SSE connection. Sets `connected` to false. */
  disconnect(): void;
  /** True while the EventSource is open. */
  readonly connected: boolean;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Create an SSE client that subscribes to the cockpit `/api/events` stream.
 *
 * Call `client.connect()` to open the connection; call `client.disconnect()`
 * in a React `useEffect` cleanup function to close it.
 *
 * @example
 * ```typescript
 * const client = createCockpitSseClient({
 *   onEvent: (event) => {
 *     for (const key of queryKeysForChannel(event.channel)) {
 *       queryClient.invalidateQueries({ queryKey: key });
 *     }
 *   },
 *   onDisconnect: (reason) => updateConnectionStatus(reason),
 * });
 * client.connect();
 * // cleanup
 * return () => client.disconnect();
 * ```
 */
export function createCockpitSseClient(options: SseClientOptions): SseClient {
  const {
    url = "/api/events",
    topics = ["*"],
    onEvent,
    onConnect,
    onDisconnect,
    onParseError,
  } = options;

  let eventSource: EventSource | null = null;
  let _connected = false;

  function buildUrl(): string {
    // `encodeURIComponent` per ECMAScript spec does NOT encode the "unreserved
    // marks" set: A-Z a-z 0-9 - _ . ! ~ * ' ( ). So `*` passes through raw,
    // `,` is encoded to `%2C`. Result for default topics=["*"] is `topics=*`;
    // for ["attention.*","session.*"] is `topics=attention.*%2Csession.*`.
    // The cockpit-server's `parseTopics` decodes both shapes correctly via
    // the URL query parser. (PR #1139 R1 defensive comment — reviewer-bot
    // misread `encodeURIComponent("*")` as `%2A`; verified empirically with
    // `node -e 'console.log(encodeURIComponent("*"))'` → `"*"`.)
    const topicsParam = encodeURIComponent(topics.join(","));
    return `${url}?topics=${topicsParam}`;
  }

  function handleMessage(ev: MessageEvent): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(ev.data as string);
    } catch {
      // Malformed JSON — call the optional parse error hook and skip silently.
      // The broker guarantees valid JSON; this case only fires if the SSE
      // framing is corrupted or a non-broker source sends events on the stream.
      onParseError?.(ev.data as string, "json_parse");
      return;
    }

    // Validate that the parsed value has the expected shape before calling
    // onEvent. All fields are required; a missing field means a broker bug.
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof (parsed as Record<string, unknown>)["id"] !== "string" ||
      typeof (parsed as Record<string, unknown>)["channel"] !== "string" ||
      typeof (parsed as Record<string, unknown>)["at"] !== "string"
    ) {
      onParseError?.(ev.data as string, "missing_fields");
      return;
    }

    const cockpitEvent: CockpitSseEvent = {
      id: (parsed as Record<string, unknown>)["id"] as string,
      channel: (parsed as Record<string, unknown>)["channel"] as string,
      payload: (parsed as Record<string, unknown>)["payload"],
      at: (parsed as Record<string, unknown>)["at"] as string,
    };

    onEvent(cockpitEvent);
  }

  function handleOpen(): void {
    _connected = true;
    onConnect?.();
  }

  function handleError(): void {
    // EventSource onerror fires on transient drops AND on permanent failure.
    // The browser will auto-reconnect with exponential backoff; we just
    // notify the caller so the UI can show a "polling fallback active" hint.
    _connected = false;
    onDisconnect?.("error");
  }

  return {
    connect(): void {
      if (eventSource !== null) {
        return; // Already connected or reconnecting
      }

      const src = new EventSource(buildUrl());
      eventSource = src;

      src.addEventListener("open", handleOpen);
      src.addEventListener("message", handleMessage);
      src.addEventListener("error", handleError);
    },

    disconnect(): void {
      if (eventSource === null) {
        return;
      }

      eventSource.removeEventListener("open", handleOpen);
      eventSource.removeEventListener("message", handleMessage);
      eventSource.removeEventListener("error", handleError);
      eventSource.close();
      eventSource = null;
      _connected = false;
      onDisconnect?.("manual");
    },

    get connected(): boolean {
      return _connected;
    },
  };
}
