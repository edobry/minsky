/**
 * HTTP forwarding client for `minsky mcp shim` (mt#3812).
 *
 * Owns three protocol edges the mt#3884 Rust spike deliberately left
 * unfinished (per this task's spec BLOCKING section):
 *
 *  1. **Cold-start retry-with-backoff.** mt#3811 measured that a tool call
 *     landing while the daemon is down (nothing listening) surfaces a hard
 *     failure into the model's turn with no client-side retry — cold start
 *     is ~5.1s median, and that window is real on every daemon restart.
 *     `send()` retries connection failures across a bounded window so a
 *     restart never surfaces an error to the model (the spec's added
 *     acceptance test).
 *  2. **Transparent session re-establishment.** A daemon restart mints a
 *     fresh `Mcp-Session-Id`; the shim's cached id then gets a 404
 *     "Session not found" from the new process. `send()` replays the
 *     client's own cached `initialize` (and `notifications/initialized`)
 *     against the daemon to mint a new session, then resends the original
 *     message — all inside the same bounded window, invisible to the
 *     client.
 *  3. **No silent drops on HTTP failure.** A failure that survives the
 *     retry window throws `DaemonRequestError` instead of vanishing; the
 *     caller (main.ts) turns that into a JSON-RPC error response frame.
 *
 * @see docs/architecture/adr-038-local-shared-mcp-daemon-architecture.md §Question 1, §Question 4
 * @see docs/mcp-http-daemon-spike-findings.md §N-scale (mt#3811)
 */

import { parseSseEventData } from "./sse";
import { safeTruncate } from "@minsky/shared/safe-truncate";
import type { JsonRpcMessage } from "./protocol";

/**
 * Total wall-clock budget for one logical send() call, including any
 * session re-establishment round trip. mt#3811 measured cold start at
 * ~5.1s median; this gives roughly 3x margin so a slow restart doesn't
 * surface a client-visible failure.
 */
export const RETRY_WINDOW_MS = 15_000;

/** Delay between connection-refused retries. */
export const RETRY_INTERVAL_MS = 250;

/**
 * Hard bound on a single in-flight POST to the daemon (mt#4450).
 *
 * Distinct from `RETRY_WINDOW_MS` above, which bounds how long `send()` keeps
 * RETRYING a refused connection and does nothing about a request that has
 * already been accepted and never answers. Before this, such a request rode
 * whatever default the runtime happened to apply — a value we neither chose,
 * documented, nor could reason about, and which surfaced to the agent as the
 * bare string "The operation timed out."
 *
 * Sized ABOVE the longest legitimate call rather than tight: `session_commit`
 * runs the gated suite in pre-push and has been measured at 150-315s (mem#1120),
 * and the harness already backgrounds anything past 120s, so a tight bound here
 * would kill working calls. Ten minutes is comfortably clear of that band while
 * still turning an indefinite hang into a bounded, attributable failure.
 *
 * This is a backstop, NOT the fix for the mt#4450 deadlock — that is the
 * capability narrowing in `capabilities.ts`. A backstop that fires is still a
 * defect worth chasing; it just fails in a way that names itself.
 */
export const REQUEST_TIMEOUT_MS = 600_000;

export class ConnectionRefusedError extends Error {}
export class SessionNotFoundError extends Error {}
export class DaemonRequestError extends Error {}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Whether a `fetch()` throw is OUR request timeout firing (mt#4450).
 *
 * `AbortSignal.timeout()` rejects with a `DOMException` named `TimeoutError`.
 * Matched by `name`, not by `instanceof DOMException` — that constructor is not
 * uniformly available across the runtimes this file is exercised in, and the
 * name is the part the platform actually specifies. `AbortError` is accepted
 * too: it is what an abort surfaces as in runtimes that predate the distinct
 * timeout name, and the shim passes no other signal, so an abort here can only
 * be this one.
 */
function isRequestTimeout(err: unknown): boolean {
  const name = (err as { name?: unknown } | null)?.name;
  return name === "TimeoutError" || name === "AbortError";
}

export interface DaemonClientOptions {
  /** Daemon MCP endpoint, e.g. http://127.0.0.1:48765/mcp. */
  url: string;
  /** Static bearer token, or null when running against an unauthenticated dev daemon. */
  authToken: string | null;
  /** Injected for tests. Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Injected for tests. Defaults to a real setTimeout-based sleep. */
  sleep?: (ms: number) => Promise<void>;
  /** Injected for tests. Defaults to writing to stderr. */
  onLog?: (line: string) => void;
  /** Injected for tests. Defaults to RETRY_WINDOW_MS. */
  retryWindowMs?: number;
  /** Injected for tests. Defaults to RETRY_INTERVAL_MS. */
  retryIntervalMs?: number;
  /** Injected for tests. Defaults to REQUEST_TIMEOUT_MS. */
  requestTimeoutMs?: number;
  /**
   * Classifies a network-level `fetch()` throw as connection-refused-class
   * (retryable within the cold-start window) or not. Defaults to
   * `DEFAULT_IS_CONNECTION_REFUSED`, which treats EVERY network-level throw
   * as connection-refused-class — see that function's docstring for why.
   * Override to narrow the retry to specific error shapes (e.g. only
   * `ECONNREFUSED`) if a deployment's failure modes warrant distinguishing
   * "daemon not listening yet" from other network errors.
   */
  isConnectionRefused?: (err: unknown) => boolean;
}

/**
 * Default connection-refused classifier: treats ANY network-level `fetch()`
 * throw (connection refused, DNS failure, connection reset) as
 * connection-refused-class for retry purposes. From the shim's perspective
 * during a daemon restart, "nothing is listening yet" and "the listener just
 * reset the connection mid-handshake" call for the same response — keep
 * retrying inside the window rather than trying to distinguish error shapes
 * that vary across Bun/undici versions and platforms. Exposed as a named,
 * overridable default (`DaemonClientOptions.isConnectionRefused`) rather than
 * inlined so a caller with a narrower failure model can opt into stricter
 * classification without forking this file.
 */
export function DEFAULT_IS_CONNECTION_REFUSED(_err: unknown): boolean {
  return true;
}

/**
 * Per-conversation client to the shared MCP HTTP daemon. One instance per
 * shim process — the `Mcp-Session-Id` and negotiated protocol version it
 * tracks are conversation-scoped state.
 */
export class DaemonClient {
  private mcpSessionId: string | null = null;
  private protocolVersion: string | null = null;
  private lastInitializeRequest: JsonRpcMessage | null = null;
  private lastInitializedNotification: JsonRpcMessage | null = null;

  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log: (line: string) => void;
  private readonly retryWindowMs: number;
  private readonly retryIntervalMs: number;
  private readonly requestTimeoutMs: number;
  private readonly isConnectionRefused: (err: unknown) => boolean;

  constructor(private readonly opts: DaemonClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.log = opts.onLog ?? ((line) => process.stderr.write(`${line}\n`));
    this.retryWindowMs = opts.retryWindowMs ?? RETRY_WINDOW_MS;
    this.retryIntervalMs = opts.retryIntervalMs ?? RETRY_INTERVAL_MS;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
    this.isConnectionRefused = opts.isConnectionRefused ?? DEFAULT_IS_CONNECTION_REFUSED;
  }

  /** Currently-tracked Mcp-Session-Id, or null before the first initialize. */
  get sessionId(): string | null {
    return this.mcpSessionId;
  }

  /**
   * Record an inbound (client → shim) frame the shim may need to replay
   * against the daemon after a session loss. Call this for EVERY inbound
   * frame before forwarding it — it never mutates the message.
   */
  observeInbound(msg: JsonRpcMessage): void {
    if (msg.method === "initialize") {
      this.lastInitializeRequest = msg;
      const params = msg.params as Record<string, unknown> | undefined;
      if (params && typeof params["protocolVersion"] === "string") {
        this.protocolVersion = params["protocolVersion"] as string;
      }
    } else if (msg.method === "notifications/initialized") {
      this.lastInitializedNotification = msg;
    }
  }

  /**
   * Send one JSON-RPC message to the daemon; returns every JSON-RPC
   * message the daemon's response carried (usually one — a Streamable-HTTP
   * POST response MAY interleave notifications ahead of the final result).
   *
   * Throws `DaemonRequestError` if the retry/re-init window is exhausted
   * without a successful response — the caller is responsible for turning
   * that into a client-visible error frame rather than dropping the
   * message.
   */
  async send(msg: JsonRpcMessage): Promise<JsonRpcMessage[]> {
    const deadline = Date.now() + this.retryWindowMs;
    return this.sendWithRetry(msg, deadline, /* allowReinit */ true);
  }

  /** Best-effort DELETE of the current session, for graceful shim shutdown. */
  async closeSession(): Promise<void> {
    if (!this.mcpSessionId) return;
    const headers: Record<string, string> = { "mcp-session-id": this.mcpSessionId };
    if (this.opts.authToken) headers["authorization"] = `Bearer ${this.opts.authToken}`;
    try {
      await this.fetchImpl(this.opts.url, { method: "DELETE", headers });
    } catch (err) {
      // Best-effort only — the daemon's idle reaper is the backstop per the
      // mt#3812 spec's Scope section. Never let a failed DELETE block shutdown.
      this.log(`[shim] session close request failed (non-fatal): ${errorMessage(err)}`);
    }
  }

  private async sendWithRetry(
    msg: JsonRpcMessage,
    deadline: number,
    allowReinit: boolean
  ): Promise<JsonRpcMessage[]> {
    for (;;) {
      try {
        return await this.postOnce(msg);
      } catch (err) {
        if (err instanceof ConnectionRefusedError) {
          if (Date.now() >= deadline) {
            throw new DaemonRequestError(
              `daemon unreachable after ${this.retryWindowMs}ms retry window: ${err.message}`
            );
          }
          this.log(`[shim] daemon unreachable, retrying: ${err.message}`);
          await this.sleep(this.retryIntervalMs);
          continue;
        }

        if (err instanceof SessionNotFoundError && allowReinit && msg.method !== "initialize") {
          this.log("[shim] daemon session lost (likely restart); re-initializing");
          const reinitOk = await this.reinitialize(deadline);
          if (!reinitOk) {
            throw new DaemonRequestError(
              `daemon session lost and re-initialize failed: ${err.message}`
            );
          }
          this.log("[shim] re-initialize succeeded; retrying original request");
          continue;
        }

        throw err;
      }
    }
  }

  /**
   * Replay the cached client initialize (+ initialized notification, if
   * observed) against the daemon to mint a fresh Mcp-Session-Id after a
   * restart invalidated the old one. Returns false if there is no cached
   * initialize to replay, or the replay itself fails within the deadline —
   * the caller treats either as a fatal DaemonRequestError.
   */
  private async reinitialize(deadline: number): Promise<boolean> {
    if (!this.lastInitializeRequest) return false;

    // Force a session-less POST: sending the stale id would just get
    // another 404 from the new daemon process.
    this.mcpSessionId = null;

    // Use a synthetic id so the daemon's response can never collide with a
    // client-visible request id — this response is discarded, never
    // forwarded upstream.
    const replay: JsonRpcMessage = {
      ...this.lastInitializeRequest,
      id: `__shim_reinit_${Date.now()}`,
    };

    try {
      await this.sendWithRetry(replay, deadline, /* allowReinit */ false);
    } catch {
      return false;
    }

    if (this.lastInitializedNotification) {
      try {
        await this.postOnce(this.lastInitializedNotification);
      } catch (err) {
        // Best-effort: some servers don't require it before accepting the
        // next request. Log and proceed — if the daemon DOES require it,
        // the retried original request will surface its own error.
        this.log(
          `[shim] replaying notifications/initialized failed (non-fatal): ${errorMessage(err)}`
        );
      }
    }

    return this.mcpSessionId !== null;
  }

  private async postOnce(msg: JsonRpcMessage): Promise<JsonRpcMessage[]> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    };
    if (this.opts.authToken) headers["authorization"] = `Bearer ${this.opts.authToken}`;
    if (this.mcpSessionId) headers["mcp-session-id"] = this.mcpSessionId;
    if (this.protocolVersion) headers["mcp-protocol-version"] = this.protocolVersion;

    let response: Response;
    try {
      response = await this.fetchImpl(this.opts.url, {
        method: "POST",
        headers,
        body: JSON.stringify(msg),
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
    } catch (err) {
      // fetch() throws for any network-level failure (connection refused,
      // DNS failure, reset). `this.isConnectionRefused` decides whether this
      // throw is retryable within the cold-start window — see
      // DEFAULT_IS_CONNECTION_REFUSED's docstring for the default's
      // rationale, and DaemonClientOptions.isConnectionRefused for how to
      // narrow it.
      // mt#4450: our own timeout is checked BEFORE the connection-refused
      // classifier, and the order matters. `DEFAULT_IS_CONNECTION_REFUSED`
      // returns true for every network-level throw, so without this branch a
      // timeout would be classified retryable and re-thrown as
      // `ConnectionRefusedError` — which `sendWithRetry` then reports as
      // "daemon unreachable after 15000ms retry window" for a request the
      // daemon accepted and held for ten minutes. Two opposite conditions
      // under one message is exactly the diagnosis cost this task was filed
      // over, so the timeout keeps its own error and says what it means.
      if (isRequestTimeout(err)) {
        throw new DaemonRequestError(
          `daemon did not respond within ${this.requestTimeoutMs}ms (request was accepted, ` +
            `then never answered — not a connection failure)`
        );
      }
      if (!this.isConnectionRefused(err)) {
        throw new DaemonRequestError(`daemon request failed: ${errorMessage(err)}`);
      }
      throw new ConnectionRefusedError(errorMessage(err));
    }

    const sid = response.headers.get("mcp-session-id");
    if (sid) this.mcpSessionId = sid;

    if (response.status === 404) {
      const bodyText = await response.text().catch(() => "");
      // Disambiguate "session not found" (retryable via re-init) from a
      // genuinely wrong URL (not retryable — would loop forever) by body
      // shape: the server's JSON-RPC -32001 error code, per src/mcp/server.ts.
      if (bodyText.includes("-32001") || bodyText.toLowerCase().includes("session not found")) {
        throw new SessionNotFoundError(bodyText || "404 session not found");
      }
      throw new DaemonRequestError(`daemon returned 404: ${safeTruncate(bodyText, 200, "head")}`);
    }

    if (!response.ok) {
      const bodyText = await response.text().catch(() => "");
      throw new DaemonRequestError(
        `daemon returned HTTP ${response.status}: ${safeTruncate(bodyText, 200, "head")}`
      );
    }

    const contentType = response.headers.get("content-type") ?? "";
    const bodyText = await response.text();
    if (!bodyText.trim()) return [];

    if (contentType.includes("text/event-stream")) {
      const dataBuffers = parseSseEventData(bodyText);
      return dataBuffers.map((buf) => JSON.parse(buf) as JsonRpcMessage);
    }

    const parsed = JSON.parse(bodyText) as JsonRpcMessage | JsonRpcMessage[];
    return Array.isArray(parsed) ? parsed : [parsed];
  }
}
