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
 * The largest `timeoutSeconds` any MCP tool's schema accepts (mt#4455).
 *
 * `session_pr_wait-for-review` and `session_pr_drive` both declare
 * `z.number().int().min(1).max(1800)` in
 * `src/adapters/shared/commands/session/session-parameters.ts`. That ceiling —
 * not any observed typical — is what `REQUEST_TIMEOUT_MS` below must clear,
 * because it is the longest a CALLER is permitted to ask the daemon to work.
 *
 * `client.test.ts` probes the real schema behaviorally rather than trusting
 * this copy, so raising the schema's `.max()` without raising the bound below
 * fails loudly instead of silently clipping legitimate waits.
 */
export const MAX_TOOL_WAIT_SECONDS = 1800;

/**
 * Margin between the longest legitimate server-side wait and the transport
 * bound: enough for the request/response round trip, the daemon's own final
 * authoritative re-check (`FINAL_CHECK_DEADLINE_MS`, 10s), and scheduling
 * slack, without being so wide that the bound stops meaning anything.
 */
export const REQUEST_TIMEOUT_MARGIN_SECONDS = 120;

/**
 * Hard bound on a single in-flight POST to the daemon (mt#4450, resized mt#4455).
 *
 * Distinct from `RETRY_WINDOW_MS` above, which bounds how long `send()` keeps
 * RETRYING a refused connection and does nothing about a request that has
 * already been accepted and never answers. Before mt#4450 such a request rode
 * whatever default the runtime happened to apply — a value we neither chose,
 * documented, nor could reason about, and which surfaced to the agent as the
 * bare string "The operation timed out."
 *
 * ## Why it is derived rather than picked
 *
 * mt#4450 set this to a flat 600_000 (ten minutes), sized against mem#1120's
 * measured 150-315s band for `session_commit`. That number was real and the
 * reference class was wrong: `session_commit` is a long-RUNNING call, and what
 * this bound must not clip is a long-WAITING call whose budget the CALLER
 * chooses. `session_pr_wait-for-review` accepts up to 1800s, so a 600s bound
 * killed a legitimate 30-minute review wait at ten minutes — and reported it as
 * a transport failure, which reads exactly like reviewer silence and is the
 * documented lead-in to the bypass-merge ladder.
 *
 * Worse, `AbortSignal.timeout()` is an ABSOLUTE deadline. `onProgress`
 * (mt#2677) exists so a long wait emits transport activity instead of silence —
 * measured: a 300ms `AbortSignal.timeout()` fires at ~301ms with continuous
 * activity in the window — so an absolute bound does not merely under-budget
 * the inner layer, it defeats a keepalive the system already had.
 *
 * So the value is a stated function of the inner budget's declared ceiling
 * rather than an independent guess. This is `decision-defaults §Thresholds`'s
 * ceiling case: when a threshold bounds work whose own budget is
 * caller-specified, the binding constraint is that budget's declared MAXIMUM.
 *
 * ## Known residue
 *
 * `session_pr_checks` and `deployment_wait-for-latest` declare no `.max()` on
 * `timeoutSeconds`, so a caller can still request a budget above this bound.
 * Accepted knowingly: the durable fix is deriving the bound per-request from
 * the caller's own `timeoutSeconds`, which would make the shim read into tool
 * ARGUMENTS and couple a deliberately transport-only component to the
 * application schema (ADR-038's thin-shim posture argues against it). Revisit
 * if a caller is observed clipped here.
 *
 * This is a backstop, NOT the fix for the mt#4450 deadlock — that is the
 * capability narrowing in `capabilities.ts`. A backstop that fires is still a
 * defect worth chasing; it just fails in a way that names itself.
 */
export const REQUEST_TIMEOUT_MS = (MAX_TOOL_WAIT_SECONDS + REQUEST_TIMEOUT_MARGIN_SECONDS) * 1000;

export class ConnectionRefusedError extends Error {}
export class SessionNotFoundError extends Error {}
/**
 * What went wrong, as a value rather than a prose message (mt#4466).
 *
 * Every failure below already carried a distinguishing MESSAGE; what it lacked
 * was anything a caller could branch on, so `main.ts` prefixed all of them with
 * the same `daemon request failed:` and the top-level string an agent reads was
 * identical for opposite conditions. During mem#1120 R2 that made a pool wedge
 * read as a broken transport, and two `/mcp` reconnects were spent on the wrong
 * process before the topology was understood.
 *
 * - `unreachable` — nothing answered, through the whole retry window. The daemon
 *   is down, was never started, or is restarting more slowly than the window.
 * - `connection-lost` — it ACCEPTED the request and the connection died before
 *   the response was complete. See below; this is the common one locally.
 * - `timeout` — the daemon ACCEPTED the request and never answered it. The
 *   opposite finding: the transport is fine and the daemon is stuck or slow.
 * - `http-error` — it answered, with a failure status.
 * - `session-lost` — its session went away and re-initialization failed.
 * - `unknown` — anything else, including a shim-internal fault.
 *
 * `connection-lost` exists because the ONE thing an agent most often hits was
 * the one thing this taxonomy could not express (mt#4828). The daemon exits by
 * design whenever the repo's HEAD moves (`staleness_exit`, mt#1315), and under
 * active merging it does so every few minutes. A call that is open at that
 * moment has its socket torn down mid-response — and until mt#4828 that landed
 * on `unknown`, whose rendering is the bare `daemon request failed`, because
 * the body read in `postOnce` sat outside every `catch` (so it was never
 * wrapped in a `DaemonRequestError` at all). The caller saw a message naming
 * no cause for what is the single most predictable failure in the system.
 *
 * It is deliberately NOT called `restarted`. From the shim, a by-design
 * staleness exit, a crash, an OOM kill and a `SIGTERM` are indistinguishable —
 * all four sever an accepted request the same way, and the shim holds no
 * evidence separating them. The name states what was OBSERVED (the connection
 * died mid-response), and the rendering names the by-design restart as the
 * LIKELY cause without asserting it. Bounding the claim to the channel actually
 * checked is `claim-confidence.mdc`; the daemon-side cause is the disconnect
 * log's job, not the shim's.
 */
export type DaemonFailureKind =
  | "unreachable"
  | "connection-lost"
  | "timeout"
  | "http-error"
  | "session-lost"
  | "unknown";

export class DaemonRequestError extends Error {
  readonly kind: DaemonFailureKind;
  constructor(message: string, kind: DaemonFailureKind = "unknown") {
    super(message);
    this.kind = kind;
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Render a shim failure so its TOP-LEVEL text names the condition (mt#4466).
 *
 * `main.ts` used to prefix every failure with `daemon request failed:`, so the
 * first line an agent read was identical whether nothing was listening or the
 * daemon had accepted the request and gone quiet — two conditions whose remedies
 * are opposites. The detail already differed; nothing surfaced it, and a reader
 * scanning a tool error sees the prefix.
 *
 * Each kind also carries the NEXT ACTION, because the reader is an agent mid-task
 * whose other MCP calls are probably failing too — and because "there is no
 * command for this" was true until this same task added one.
 */
export function daemonFailureKindOf(err: unknown): DaemonFailureKind {
  return err instanceof DaemonRequestError ? err.kind : "unknown";
}

export function describeDaemonFailure(err: unknown): { summary: string; detail: string } {
  const detail = errorMessage(err);
  const kind: DaemonFailureKind = daemonFailureKindOf(err);
  switch (kind) {
    case "unreachable":
      return {
        summary:
          "daemon unreachable (nothing answered through the retry window) — it is down, was " +
          "never started, or restarted more slowly than the window; run `minsky mcp status` " +
          "via the CLI, which does not go through this transport. To start one, use a " +
          "harness-backgrounded `exec minsky mcp start --local-daemon` — a detached " +
          "`nohup ... &` self-exits within seconds once its parent shell dies (mt#3764)",
        detail,
      };
    case "connection-lost":
      return {
        summary:
          "daemon connection lost mid-response — the request WAS accepted and may have taken " +
          "effect, so VERIFY STATE before re-issuing (re-running a write could apply it " +
          "twice). Most often the by-design staleness restart, which fires whenever the " +
          "repo's HEAD moves; the daemon is usually already back, so the retry normally " +
          "succeeds. `minsky mcp status` via the CLI confirms it is serving again",
        detail,
      };
    case "timeout":
      return {
        summary:
          "daemon reachable but did not answer (the request was accepted, then went quiet) — " +
          "this is NOT a transport failure; the daemon is stuck or its connection pool is " +
          "exhausted. Run `minsky mcp status` via the CLI to see live pool reachability",
        detail,
      };
    case "http-error":
      return { summary: "daemon answered with an error response", detail };
    case "session-lost":
      return {
        summary:
          "daemon session lost and could not be re-established (the daemon likely restarted)",
        detail,
      };
    default:
      return { summary: "daemon request failed", detail };
  }
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
   * Record a frame the shim may need to REPLAY against the daemon after a
   * session loss. It never mutates the message.
   *
   * **Pass the frame exactly as it will be SENT, not as it arrived** (mt#4450).
   * Whatever is stored here is what `reinitialize()` re-sends verbatim, so this
   * is not a diagnostic record of client input — it is the recovery copy, and
   * it has to be byte-identical to what the daemon negotiated the first time.
   * `handleLine` transforms `initialize` before sending (`capabilities.ts`
   * removes capabilities this transport cannot service), so observing the raw
   * inbound frame instead would re-advertise a capability the connection cannot
   * honor on the first reconnect, silently undoing that fix at the moment
   * nobody is watching.
   *
   * This docstring previously said "call this for EVERY inbound frame before
   * forwarding it." That was accurate while the shim forwarded everything
   * untouched; it is the sentence a reader would have followed straight into
   * the bug, which is why it is corrected here rather than merely amended at
   * the call site.
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
              `daemon unreachable after ${this.retryWindowMs}ms retry window: ${err.message}`,
              "unreachable"
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
              `daemon session lost and re-initialize failed: ${err.message}`,
              "session-lost"
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
            `then never answered — not a connection failure)`,
          "timeout"
        );
      }
      if (!this.isConnectionRefused(err)) {
        throw new DaemonRequestError(`daemon request failed: ${errorMessage(err)}`, "unknown");
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
      throw new DaemonRequestError(
        `daemon returned 404: ${safeTruncate(bodyText, 200, "head")}`,
        "http-error"
      );
    }

    if (!response.ok) {
      const bodyText = await response.text().catch(() => "");
      throw new DaemonRequestError(
        `daemon returned HTTP ${response.status}: ${safeTruncate(bodyText, 200, "head")}`,
        "http-error"
      );
    }

    const contentType = response.headers.get("content-type") ?? "";

    // mt#4828: the body read is a SECOND severance point, and until this guard
    // it was the unhandled one. `fetch()` resolves as soon as the response
    // HEADERS arrive, so a daemon that dies while streaming the body throws
    // HERE, not at the `fetch()` above — outside that call's `try`, and so
    // outside every classifier this file has. The raw `Error` then fell
    // through `sendWithRetry`'s final `throw err` and reached
    // `describeDaemonFailure` as a non-`DaemonRequestError`, rendering as the
    // bare `daemon request failed: The socket connection was closed
    // unexpectedly` — a message naming no cause, for the most frequent local
    // failure there is.
    //
    // Both severance points are now classified, and they are NOT the same
    // finding, which is why they get different kinds: dying BEFORE headers
    // means the daemon may never have received the call (`unreachable`, after
    // the retry window); dying AFTER them means it certainly did
    // (`connection-lost`). That difference is the whole basis of the retry
    // decision below.
    let bodyText: string;
    try {
      bodyText = await response.text();
    } catch (err) {
      // NOT retried, deliberately — this is the one place where retrying would
      // be unsafe rather than merely wasteful. A pre-headers failure is safe to
      // replay because the daemon never received the request; here it did, and
      // it may have executed the tool completely before the socket died. The
      // response is unrecoverable either way, so a replay cannot confirm what
      // happened — it can only run the side effect a second time.
      //
      // The shim cannot narrow this by asking whether THIS tool is idempotent:
      // that requires reading tool names and arguments, which is exactly the
      // coupling to application schema that ADR-038's thin-shim posture rules
      // out (the same reasoning already recorded above `REQUEST_TIMEOUT_MS`).
      // So the honest move is to surface the ambiguity to the caller, who does
      // know what it asked for, rather than resolve it here by guessing. The
      // rendering in `describeDaemonFailure` tells them to verify state before
      // re-issuing.
      throw new DaemonRequestError(
        `daemon connection lost while reading the response (the request was ` +
          `accepted and may have taken effect): ${errorMessage(err)}`,
        "connection-lost"
      );
    }
    if (!bodyText.trim()) return [];

    if (contentType.includes("text/event-stream")) {
      const dataBuffers = parseSseEventData(bodyText);
      return dataBuffers.map((buf) => JSON.parse(buf) as JsonRpcMessage);
    }

    const parsed = JSON.parse(bodyText) as JsonRpcMessage | JsonRpcMessage[];
    return Array.isArray(parsed) ? parsed : [parsed];
  }
}
