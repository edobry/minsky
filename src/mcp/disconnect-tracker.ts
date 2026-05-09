/**
 * MCP Server Disconnect/Reconnect Tracker
 *
 * Tracks disconnect, reconnect, and process-lifecycle events for MCP servers
 * (both local `minsky` and hosted `minsky-hosted`). Exposes a structured
 * cadence counter so operators can answer "how many MCP disconnects happened
 * in the last 24h?" without manually grepping logs.
 *
 * Design (mt#1682):
 * - In-memory ring buffer of events (capped at MAX_EVENTS to bound memory).
 * - Persists events as **append-only JSONL** to a file in the Minsky state
 *   directory. Each `recordX()` call appends a single JSON line via
 *   `fs.appendFileSync`, so an event is durably on disk before the function
 *   returns even if the process is killed microseconds later. The legacy
 *   single-JSON-array format from mt#1645 is still readable on load
 *   (backward-compatible migration).
 * - Exposed via `mcp__minsky__debug_systemInfo` under `mcpDisconnects`.
 *
 * Cause classification (mt#1682):
 *   The single `stdin_close` cause from mt#1645 conflated four different
 *   real-world classes. We now distinguish them so operators can pick the
 *   right intervention:
 *
 *   1. Harness-driven cycling (subagent / hook / probe connections). Tagged
 *      `stdin_close`. Filtered from escalation when uptimeMs < 5s.
 *   2. Server-initiated `staleness_exit` (mt#1315 mechanism). Tagged
 *      `staleness_exit`. Excluded from escalation by cause.
 *   3. Genuine long-lived-session closure by the harness. Tagged `stdin_close`,
 *      uptimeMs >= 5s. Counts toward escalation — this is the user-visible
 *      reliability concern.
 *   4. Signal-driven shutdowns. Tagged `signal_sigterm` / `signal_sigint` /
 *      `signal_sighup`. Excluded from escalation by cause.
 *
 * Recurrence-threshold escalation rule:
 *   > 1 escalation-eligible disconnect per active session  → file a structural-fix task
 *   > 3 escalation-eligible disconnects per active day     → file a structural-fix task
 *
 *   "Escalation-eligible" excludes server-initiated causes (class 2 and 4) and
 *   short-lived probe connections (class 1, uptimeMs < 5s). Class 3 is the
 *   only class that contributes.
 *
 * @see mt#1645 — measurement layer (parent task)
 * @see mt#1682 — cause classification + append-only log (this task)
 */

import fs from "fs";
import path from "path";
import os from "os";
import { log } from "../utils/logger";

/**
 * The kind of event recorded.
 * - `process_start`: lifecycle marker emitted in the constructor of the MCP server.
 * - `disconnect`: MCP server transport closed (client-side, server-initiated, or signal).
 * - `reconnect`: MCP server successfully started/connected after a prior disconnect.
 * - `transport_error`: Transport-layer error (stderr/signal/stdio error).
 */
export type McpEventKind = "process_start" | "disconnect" | "reconnect" | "transport_error";

/**
 * What caused the event (best-effort attribution from available signals).
 *
 * Harness-side (i.e. Claude Code closed the pipe):
 * - `stdin_close`: stdio transport — stdin pipe closed without a server-initiated cause.
 * - `idle_timeout`: HTTP session reaped by the idle-timeout reaper.
 *
 * Server-initiated (the server caused its own teardown — these are excluded
 * from escalation since they reflect by-design behavior):
 * - `staleness_exit`: mt#1315 staleness detector triggered `process.exit(0)`.
 * - `signal_sigterm` / `signal_sigint` / `signal_sighup`: process received the named signal.
 * - `server_close`: `server.close()` was called directly (normal shutdown).
 *
 * Other:
 * - `transport_error`: error on the underlying transport stream.
 * - `process_start`: synthetic cause for `process_start` events (no actual disconnect).
 * - `signal`: legacy signal cause (kept for backward compatibility with logs from mt#1645).
 * - `unknown`: no cause information was available.
 */
export type McpDisconnectCause =
  | "stdin_close"
  | "signal"
  | "signal_sigterm"
  | "signal_sigint"
  | "signal_sighup"
  | "transport_error"
  | "idle_timeout"
  | "server_close"
  | "staleness_exit"
  | "process_start"
  | "unknown";

/**
 * A single recorded event. Used for `disconnect`, `reconnect`,
 * `transport_error`, and `process_start` kinds.
 */
export interface McpDisconnectEvent {
  /** ISO-8601 timestamp of the event. */
  timestamp: string;
  /**
   * Server identifier.
   * `Minsky MCP Server` = local stdio server (the one running this code)
   * `minsky-hosted`     = HTTP-transport hosted deployment
   */
  serverName: string;
  /** Event kind. */
  kind: McpEventKind;
  /** Best-effort cause. */
  cause: McpDisconnectCause;
  /** Optional error message from the underlying transport, when available. */
  error?: string;
  /**
   * Process ID at event time. Always present on `process_start`; optional on
   * other events. Lets log readers correlate disconnect events back to the
   * specific server process that produced them.
   */
  pid?: number;
  /**
   * Process uptime in milliseconds at the time of the event (now - process
   * start). Always present on `disconnect` / `transport_error`. Used by the
   * escalation filter to distinguish short-lived harness probes (uptimeMs < 5s,
   * class 1) from genuine long-lived-session closures (class 3).
   */
  uptimeMs?: number;
}

/**
 * Structured cadence summary returned by `debug.systemInfo`.
 */
export interface McpDisconnectSummary {
  /** Total disconnect events in the last 24 hours. */
  count24h: number;
  /** Total reconnect events in the last 24 hours. */
  reconnects24h: number;
  /** Breakdown by server name (all events combined). */
  byServer: Record<string, number>;
  /** Breakdown by event kind. */
  byKind: Record<McpEventKind, number>;
  /** Breakdown by cause (all events combined). Lets operators see the cause distribution at a glance. */
  byCause: Record<string, number>;
  /** The most recent event, or null if no events recorded. */
  last: McpDisconnectEvent | null;
  /**
   * Escalation signal.
   *
   * `none`       = below both thresholds
   * `session`    = > 1 escalation-eligible disconnect this session
   * `daily`      = > 3 escalation-eligible disconnects in last 24h
   *
   * Escalation-eligible = `disconnect` events whose cause is NOT in
   * `SERVER_INITIATED_CAUSES` AND whose `uptimeMs` is >= `SHORT_LIVED_THRESHOLD_MS`
   * (or absent — legacy events without uptimeMs from mt#1645 are counted to
   * stay conservative on backward compat).
   *
   * When set to `session` or `daily`, a structural-fix task should be filed.
   */
  escalation: "none" | "session" | "daily";
}

/** Maximum events to keep in the ring buffer (memory bound). */
const MAX_EVENTS = 500;

/** Session-lifetime escalation-eligible disconnect threshold. */
const ESCALATION_THRESHOLD_SESSION = 1;

/** 24-hour escalation-eligible disconnect threshold. */
const ESCALATION_THRESHOLD_24H = 3;

/**
 * Process-uptime threshold below which a disconnect is treated as a short-lived
 * harness probe (class 1) and excluded from escalation. 5 seconds is well above
 * the 1.8–2.1s typical handshake time observed in Claude Code's MCP logs.
 */
const SHORT_LIVED_THRESHOLD_MS = 5000;

/**
 * Causes whose disconnect events are server-initiated by design and excluded
 * from the escalation count regardless of uptime.
 */
const SERVER_INITIATED_CAUSES: ReadonlySet<McpDisconnectCause> = new Set<McpDisconnectCause>([
  "staleness_exit",
  "signal",
  "signal_sigterm",
  "signal_sigint",
  "signal_sighup",
  "server_close",
  "idle_timeout",
]);

/** Directory where the persistent event log is written. */
function getStateDir(): string {
  const envDir = process.env.MINSKY_STATE_DIR;
  if (envDir) return envDir;
  return path.join(os.homedir(), ".local", "state", "minsky");
}

/**
 * Path to the persistent disconnect event log. The filename is kept as
 * `mcp-disconnect-log.json` for backward compat with mt#1645, but the contents
 * are now JSONL (one JSON object per line, no enclosing array). `loadFromDisk`
 * accepts both formats.
 */
function getLogPath(): string {
  return path.join(getStateDir(), "mcp-disconnect-log.json");
}

/**
 * Validate that an unknown value parses as a structurally-valid event.
 * Used by `loadFromDisk` to skip malformed entries from either log format.
 */
function isValidEvent(item: unknown): item is McpDisconnectEvent {
  if (!item || typeof item !== "object") return false;
  const r = item as Record<string, unknown>;
  return (
    typeof r.timestamp === "string" &&
    typeof r.serverName === "string" &&
    typeof r.kind === "string" &&
    typeof r.cause === "string"
  );
}

/**
 * DisconnectTracker — singleton in-memory counter with append-only file
 * persistence.
 *
 * Instantiated once per MCP server process. `DisconnectTracker.getInstance()`
 * returns the shared instance. Tests can call `DisconnectTracker.resetForTest()`
 * to get a clean state.
 *
 * File I/O is best-effort: a write failure logs a warning but never throws —
 * the in-memory counter continues to work regardless.
 */
export class DisconnectTracker {
  private static _instance: DisconnectTracker | null = null;

  private events: McpDisconnectEvent[] = [];
  private sessionDisconnects = 0;
  private eligibleSessionDisconnects = 0;
  private serverName: string;
  private persistPath: string;
  private processStartTime: number;
  private processPid: number;
  /**
   * Set to true when a server-initiated disconnect cause has been recorded
   * (staleness_exit, signal_*, server_close). The SDK's `Server.onclose`
   * fires during stdio teardown after these events; the wireDisconnectHooks
   * chained handler checks this flag and suppresses the duplicate
   * `stdin_close` record so the cause isn't conflated. Stays true for the
   * life of the process — once shutdown has begun, no further disconnect
   * events are meaningful from this server. mt#1682.
   */
  private cleanShutdownInitiated = false;

  constructor(serverName: string, persistPath?: string) {
    this.serverName = serverName;
    this.persistPath = persistPath ?? getLogPath();
    this.processStartTime = Date.now();
    this.processPid = typeof process !== "undefined" ? process.pid : 0;
    this.loadFromDisk();
  }

  /**
   * Return the process-lifetime singleton, creating it with the given serverName
   * on the first call. Subsequent calls ignore `serverName` and return the same
   * instance.
   */
  static getInstance(serverName: string): DisconnectTracker {
    if (!DisconnectTracker._instance) {
      DisconnectTracker._instance = new DisconnectTracker(serverName);
    }
    return DisconnectTracker._instance;
  }

  /**
   * Reset the singleton for tests — creates a fresh instance backed by an
   * in-memory store (no file I/O) when `persistPath` is explicitly empty.
   */
  static resetForTest(serverName = "test-server", persistPath?: string): DisconnectTracker {
    DisconnectTracker._instance = new DisconnectTracker(serverName, persistPath ?? "");
    return DisconnectTracker._instance;
  }

  /**
   * Override the session disconnect count for test purposes.
   * Allows tests to isolate the daily-threshold check without triggering the
   * session-threshold check, without resorting to `as unknown` type assertions.
   * Only call from test code.
   */
  setSessionDisconnectCountForTest(total: number, eligible?: number): void {
    this.sessionDisconnects = total;
    this.eligibleSessionDisconnects = eligible ?? total;
  }

  /**
   * Override the recorded process start time for test purposes. Lets uptime-
   * filtering tests record disconnects with arbitrary `uptimeMs` values
   * without sleeping. Only call from test code.
   */
  setProcessStartTimeForTest(timestamp: number): void {
    this.processStartTime = timestamp;
  }

  /**
   * Record the start of this MCP server process. Called from the
   * `MinskyMCPServer` constructor before any tool can be invoked. The
   * `process_start` lifecycle marker lets log readers count actual server
   * processes (including those that lived <1s and never recorded a disconnect)
   * and correlate disconnect events back to the specific process that
   * produced them.
   */
  recordProcessStart(): McpDisconnectEvent {
    const event: McpDisconnectEvent = {
      timestamp: new Date(this.processStartTime).toISOString(),
      serverName: this.serverName,
      kind: "process_start",
      cause: "process_start",
      pid: this.processPid,
    };
    this.push(event);
    log.info("mcp_process_start", {
      serverName: event.serverName,
      pid: event.pid,
    });
    this.appendEvent(event);
    return event;
  }

  /**
   * Record a disconnect event. Emits a structured log line and durably
   * appends to disk before returning.
   */
  recordDisconnect(cause: McpDisconnectCause, errorMessage?: string): McpDisconnectEvent {
    const uptimeMs = Date.now() - this.processStartTime;
    const event: McpDisconnectEvent = {
      timestamp: new Date().toISOString(),
      serverName: this.serverName,
      kind: "disconnect",
      cause,
      uptimeMs,
      ...(errorMessage ? { error: errorMessage } : {}),
    };
    this.push(event);
    this.sessionDisconnects++;
    if (this.isEscalationEligible(event)) {
      this.eligibleSessionDisconnects++;
    }
    if (cause !== "stdin_close" && cause !== "transport_error" && cause !== "unknown") {
      // Server-initiated cause was just recorded — suppress any subsequent
      // SDK-driven `stdin_close` event from the stdio teardown that follows.
      this.cleanShutdownInitiated = true;
    }
    log.warn("mcp_disconnect", {
      serverName: event.serverName,
      kind: event.kind,
      cause: event.cause,
      uptimeMs: event.uptimeMs,
      ...(event.error ? { error: event.error } : {}),
    });
    this.appendEvent(event);
    return event;
  }

  /**
   * Whether a clean (server-initiated) shutdown has already been recorded.
   * The SDK-driven `wireDisconnectHooks` onclose handler checks this before
   * recording its own event so the same teardown isn't double-counted.
   */
  isCleanShutdownInitiated(): boolean {
    return this.cleanShutdownInitiated;
  }

  /**
   * Record a reconnect event. Emits a structured log line and durably
   * appends to disk before returning.
   */
  recordReconnect(cause?: McpDisconnectCause): McpDisconnectEvent {
    const event: McpDisconnectEvent = {
      timestamp: new Date().toISOString(),
      serverName: this.serverName,
      kind: "reconnect",
      cause: cause ?? "unknown",
    };
    this.push(event);
    log.info("mcp_reconnect", {
      serverName: event.serverName,
      kind: event.kind,
    });
    this.appendEvent(event);
    return event;
  }

  /**
   * Record a transport error event. Includes process uptime so callers can
   * distinguish errors during handshake from errors against long-lived
   * sessions.
   */
  recordTransportError(errorMessage: string): McpDisconnectEvent {
    const uptimeMs = Date.now() - this.processStartTime;
    const event: McpDisconnectEvent = {
      timestamp: new Date().toISOString(),
      serverName: this.serverName,
      kind: "transport_error",
      cause: "transport_error",
      error: errorMessage,
      uptimeMs,
    };
    this.push(event);
    log.error("mcp_transport_error", {
      serverName: event.serverName,
      kind: event.kind,
      error: event.error,
      uptimeMs,
    });
    this.appendEvent(event);
    return event;
  }

  /**
   * Compute a structured summary for `debug.systemInfo`.
   *
   * Includes the escalation signal based on session and daily thresholds.
   * The escalation count excludes server-initiated causes (staleness_exit,
   * signal_*, server_close, idle_timeout) and short-lived harness probes
   * (uptimeMs < SHORT_LIVED_THRESHOLD_MS).
   */
  getSummary(): McpDisconnectSummary {
    const now = Date.now();
    const cutoff24h = now - 24 * 60 * 60 * 1000;

    const recent = this.events.filter((e) => new Date(e.timestamp).getTime() >= cutoff24h);

    const count24h = recent.filter((e) => e.kind === "disconnect").length;
    const reconnects24h = recent.filter((e) => e.kind === "reconnect").length;

    const byServer: Record<string, number> = {};
    const byKind: Record<McpEventKind, number> = {
      process_start: 0,
      disconnect: 0,
      reconnect: 0,
      transport_error: 0,
    };
    const byCause: Record<string, number> = {};

    for (const e of recent) {
      byServer[e.serverName] = (byServer[e.serverName] ?? 0) + 1;
      byKind[e.kind] = (byKind[e.kind] ?? 0) + 1;
      byCause[e.cause] = (byCause[e.cause] ?? 0) + 1;
    }

    const last = this.events.length > 0 ? this.events[this.events.length - 1] : null;

    const eligibleCount24h = recent.filter((e) => this.isEscalationEligible(e)).length;

    let escalation: McpDisconnectSummary["escalation"] = "none";
    if (eligibleCount24h > ESCALATION_THRESHOLD_24H) {
      escalation = "daily";
    } else if (this.eligibleSessionDisconnects > ESCALATION_THRESHOLD_SESSION) {
      escalation = "session";
    }

    return {
      count24h,
      reconnects24h,
      byServer,
      byKind,
      byCause,
      last: last ?? null,
      escalation,
    };
  }

  /**
   * Return all recorded events (newest-last). For use by tests and diagnostics.
   */
  getEvents(): readonly McpDisconnectEvent[] {
    return this.events;
  }

  /** Number of disconnect events recorded in this server session (since startup). */
  getSessionDisconnectCount(): number {
    return this.sessionDisconnects;
  }

  /** Number of escalation-eligible disconnect events recorded in this server session. */
  getEligibleSessionDisconnectCount(): number {
    return this.eligibleSessionDisconnects;
  }

  /** Wall-clock timestamp (ms) when this tracker — and thus the server process — started. */
  getProcessStartTime(): number {
    return this.processStartTime;
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private isEscalationEligible(event: McpDisconnectEvent): boolean {
    if (event.kind !== "disconnect") return false;
    if (SERVER_INITIATED_CAUSES.has(event.cause)) return false;
    // Legacy events without uptimeMs (from mt#1645 logs) are counted as
    // eligible — we have no way to know whether they were short-lived.
    if (event.uptimeMs !== undefined && event.uptimeMs < SHORT_LIVED_THRESHOLD_MS) return false;
    return true;
  }

  private push(event: McpDisconnectEvent): void {
    this.events.push(event);
    if (this.events.length > MAX_EVENTS) {
      this.events = this.events.slice(this.events.length - MAX_EVENTS);
    }
  }

  /**
   * Durably append a single event as one JSON line to the persist file.
   * Uses `appendFileSync` (O_APPEND semantics) so the write is atomic at the
   * line boundary and complete before the call returns — even if the process
   * exits microseconds later.
   */
  private appendEvent(event: McpDisconnectEvent): void {
    if (!this.persistPath) return; // In-memory-only mode (tests)
    try {
      const dir = path.dirname(this.persistPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const line = `${JSON.stringify(event)}\n`;
      fs.appendFileSync(this.persistPath, line, "utf-8");
    } catch (err) {
      log.warn("mcp_disconnect_tracker: failed to append event log", {
        path: this.persistPath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Load past events from disk. Accepts both the new JSONL format (one event
   * per line, no enclosing array) and the legacy single-array JSON format
   * from mt#1645. Legacy logs are loaded as-is; subsequent appends from this
   * process write JSONL after the legacy bytes, producing a hybrid file that
   * remains parseable on next startup (the legacy `[ ... ]` block is followed
   * by additional `{...}\n` lines, both of which the parser handles).
   *
   * Hybrid-file note: the parser detects the leading `[` as the legacy
   * marker, parses it via `JSON.parse` up to the matching `]`, then resumes
   * line-by-line parsing for any trailing JSONL content.
   */
  private loadFromDisk(): void {
    if (!this.persistPath) return; // In-memory-only mode (tests)
    try {
      if (!fs.existsSync(this.persistPath)) return;
      const raw = fs.readFileSync(this.persistPath, { encoding: "utf-8" }) as string;
      const trimmed = raw.trim();
      if (!trimmed) return;

      const valid: McpDisconnectEvent[] = [];
      let cursor = 0;

      // Legacy single-array format detection (mt#1645). The original `persist`
      // wrote `JSON.stringify(events, null, 2)` so the file started with `[`.
      // Parse the array, then advance the cursor past it for any trailing
      // JSONL content appended by post-mt#1682 writers.
      if (trimmed.startsWith("[")) {
        const arrayStart = raw.indexOf("[");
        const arrayEnd = this.findMatchingBracket(raw, arrayStart);
        if (arrayEnd >= 0) {
          const arraySlice = raw.slice(arrayStart, arrayEnd + 1);
          try {
            const parsed: unknown = JSON.parse(arraySlice);
            if (Array.isArray(parsed)) {
              for (const item of parsed) {
                if (isValidEvent(item)) valid.push(item);
              }
            }
          } catch {
            // Fall through — corrupted legacy block won't block JSONL load
          }
          cursor = arrayEnd + 1;
        }
      }

      // JSONL parse: split remaining content on newlines, parse each non-blank line.
      const remaining = raw.slice(cursor);
      const lines = remaining.split("\n");
      for (const line of lines) {
        const trimmedLine = line.trim();
        if (!trimmedLine) continue;
        if (trimmedLine.startsWith("[") || trimmedLine.startsWith("]")) continue; // legacy bracket residue
        try {
          const parsed: unknown = JSON.parse(trimmedLine);
          if (isValidEvent(parsed)) valid.push(parsed);
        } catch {
          // skip malformed line
        }
      }

      this.events = valid.slice(-MAX_EVENTS);
      log.debug("mcp_disconnect_tracker: loaded events from disk", {
        count: this.events.length,
        path: this.persistPath,
      });
    } catch (err) {
      log.debug("mcp_disconnect_tracker: failed to load event log from disk (non-fatal)", {
        path: this.persistPath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Find the index of the closing `]` that matches the opening `[` at `start`.
   * Walks the string tracking string literals so brackets inside JSON strings
   * don't confuse the matcher. Returns -1 if no match is found.
   *
   * Used only for the legacy-format path; JSONL doesn't need this.
   */
  private findMatchingBracket(s: string, start: number): number {
    if (s[start] !== "[") return -1;
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = start; i < s.length; i++) {
      const c = s[i];
      if (escape) {
        escape = false;
        continue;
      }
      if (c === "\\" && inString) {
        escape = true;
        continue;
      }
      if (c === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (c === "[") depth++;
      else if (c === "]") {
        depth--;
        if (depth === 0) return i;
      }
    }
    return -1;
  }
}
