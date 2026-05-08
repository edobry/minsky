/**
 * MCP Server Disconnect/Reconnect Tracker
 *
 * Tracks disconnect and reconnect events for MCP servers (both local `minsky`
 * and hosted `minsky-hosted`). Exposes a structured cadence counter so operators
 * can answer "how many MCP disconnects happened in the last 24h?" without
 * manually grepping logs.
 *
 * Design:
 * - In-memory ring buffer of events (capped at MAX_EVENTS to bound memory).
 * - Persists events to a JSON file in the Minsky state directory so the count
 *   survives across reconnects within the same operator session.
 * - Exposed via `mcp__minsky__debug_systemInfo` under `mcpDisconnects`.
 *
 * Recurrence-threshold escalation rule (mt#1645):
 *   > 1 disconnect per active session  → file a structural-fix task
 *   > 3 disconnects per active day     → file a structural-fix task
 *
 * Calibrate after week-1 observation. These thresholds are starting points;
 * empirical data from the 2026-05-07 session (3 disconnects in ~70 minutes)
 * already exceeds the "1 per active session" baseline, suggesting the
 * structural-fix task (auto-reconnect / keepalive) is already justified.
 *
 * @see mt#1645 — measurement task
 */

import fs from "fs";
import path from "path";
import os from "os";
import { log } from "../utils/logger";

/**
 * The kind of disconnect event.
 * - `disconnect`: MCP server transport closed (client side or network).
 * - `reconnect`: MCP server successfully started/connected after a prior disconnect.
 * - `transport_error`: Transport-layer error (stderr/signal/stdio error).
 */
export type McpEventKind = "disconnect" | "reconnect" | "transport_error";

/**
 * What caused the event (best-effort attribution from available signals).
 * - `stdin_close`: stdio transport — stdin pipe closed (Claude Code closed the connection).
 * - `signal`: process received SIGTERM / SIGINT / SIGHUP.
 * - `transport_error`: error on the underlying transport stream.
 * - `idle_timeout`: HTTP session reaped by the idle-timeout reaper.
 * - `server_close`: server.close() was called directly (normal shutdown).
 * - `unknown`: no cause information was available.
 */
export type McpDisconnectCause =
  | "stdin_close"
  | "signal"
  | "transport_error"
  | "idle_timeout"
  | "server_close"
  | "unknown";

/**
 * A single recorded disconnect/reconnect event.
 */
export interface McpDisconnectEvent {
  /** ISO-8601 timestamp of the event. */
  timestamp: string;
  /**
   * Server identifier.
   * `minsky`        = local stdio server (the one running this code)
   * `minsky-hosted` = HTTP-transport hosted deployment
   */
  serverName: string;
  /** Event kind. */
  kind: McpEventKind;
  /** Best-effort cause. */
  cause: McpDisconnectCause;
  /** Optional error message from the underlying transport, when available. */
  error?: string;
}

/**
 * Structured cadence summary returned by `debug.systemInfo`.
 */
export interface McpDisconnectSummary {
  /** Total disconnect events in the last 24 hours. */
  count24h: number;
  /** Total reconnect events in the last 24 hours. */
  reconnects24h: number;
  /** Breakdown by server name (disconnect + reconnect combined). */
  byServer: Record<string, number>;
  /** Breakdown by event kind. */
  byKind: Record<McpEventKind, number>;
  /** The most recent event, or null if no events recorded. */
  last: McpDisconnectEvent | null;
  /**
   * Escalation signal.
   *
   * `none`       = below both thresholds
   * `session`    = > 1 disconnect this session (per active session threshold)
   * `daily`      = > 3 disconnects today (per active day threshold)
   *
   * When set to `session` or `daily`, a structural-fix task should be filed.
   * Calibrate thresholds after week-1 observation per mt#1645.
   */
  escalation: "none" | "session" | "daily";
}

/** Maximum events to keep in the ring buffer (memory bound). */
const MAX_EVENTS = 500;

/** Session-lifetime disconnect threshold before escalating. */
const ESCALATION_THRESHOLD_SESSION = 1;

/** 24-hour disconnect threshold before escalating. */
const ESCALATION_THRESHOLD_24H = 3;

/** Directory where the persistent event log is written. */
function getStateDir(): string {
  // Prefer MINSKY_STATE_DIR env var; fall back to ~/.local/state/minsky
  const envDir = process.env.MINSKY_STATE_DIR;
  if (envDir) return envDir;
  return path.join(os.homedir(), ".local", "state", "minsky");
}

/** Path to the persistent disconnect event log. */
function getLogPath(): string {
  return path.join(getStateDir(), "mcp-disconnect-log.json");
}

/**
 * DisconnectTracker — singleton in-memory counter with optional file persistence.
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
  private serverName: string;
  private persistPath: string;

  constructor(serverName: string, persistPath?: string) {
    this.serverName = serverName;
    this.persistPath = persistPath ?? getLogPath();
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
   * in-memory store (no file I/O).
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
  setSessionDisconnectCountForTest(count: number): void {
    this.sessionDisconnects = count;
  }

  /**
   * Record a disconnect event. Emits a structured log line and persists to disk.
   */
  recordDisconnect(cause: McpDisconnectCause, errorMessage?: string): McpDisconnectEvent {
    const event: McpDisconnectEvent = {
      timestamp: new Date().toISOString(),
      serverName: this.serverName,
      kind: "disconnect",
      cause,
      ...(errorMessage ? { error: errorMessage } : {}),
    };
    this.push(event);
    this.sessionDisconnects++;
    log.warn("mcp_disconnect", {
      serverName: event.serverName,
      kind: event.kind,
      cause: event.cause,
      ...(event.error ? { error: event.error } : {}),
    });
    this.persist();
    return event;
  }

  /**
   * Record a reconnect event. Emits a structured log line and persists to disk.
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
    this.persist();
    return event;
  }

  /**
   * Record a transport error event.
   */
  recordTransportError(errorMessage: string): McpDisconnectEvent {
    const event: McpDisconnectEvent = {
      timestamp: new Date().toISOString(),
      serverName: this.serverName,
      kind: "transport_error",
      cause: "transport_error",
      error: errorMessage,
    };
    this.push(event);
    log.error("mcp_transport_error", {
      serverName: event.serverName,
      kind: event.kind,
      error: event.error,
    });
    this.persist();
    return event;
  }

  /**
   * Compute a structured summary for `debug.systemInfo`.
   *
   * Includes the escalation signal based on session and daily thresholds.
   * Thresholds:
   *   > 1 disconnect per active session → `session`
   *   > 3 disconnects in last 24h       → `daily`
   *
   * Calibrate after week-1 observation (mt#1645).
   */
  getSummary(): McpDisconnectSummary {
    const now = Date.now();
    const cutoff24h = now - 24 * 60 * 60 * 1000;

    const recent = this.events.filter((e) => new Date(e.timestamp).getTime() >= cutoff24h);

    const count24h = recent.filter((e) => e.kind === "disconnect").length;
    const reconnects24h = recent.filter((e) => e.kind === "reconnect").length;

    const byServer: Record<string, number> = {};
    const byKind: Record<McpEventKind, number> = {
      disconnect: 0,
      reconnect: 0,
      transport_error: 0,
    };

    for (const e of recent) {
      byServer[e.serverName] = (byServer[e.serverName] ?? 0) + 1;
      byKind[e.kind] = (byKind[e.kind] ?? 0) + 1;
    }

    const last = this.events.length > 0 ? this.events[this.events.length - 1] : null;

    let escalation: McpDisconnectSummary["escalation"] = "none";
    if (count24h > ESCALATION_THRESHOLD_24H) {
      escalation = "daily";
    } else if (this.sessionDisconnects > ESCALATION_THRESHOLD_SESSION) {
      escalation = "session";
    }

    return {
      count24h,
      reconnects24h,
      byServer,
      byKind,
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

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private push(event: McpDisconnectEvent): void {
    this.events.push(event);
    // Trim to cap (remove oldest entries first)
    if (this.events.length > MAX_EVENTS) {
      this.events = this.events.slice(this.events.length - MAX_EVENTS);
    }
  }

  private persist(): void {
    if (!this.persistPath) return; // In-memory-only mode (tests)
    try {
      const dir = path.dirname(this.persistPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.persistPath, JSON.stringify(this.events, null, 2), "utf-8");
    } catch (err) {
      log.warn("mcp_disconnect_tracker: failed to persist event log", {
        path: this.persistPath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private loadFromDisk(): void {
    if (!this.persistPath) return; // In-memory-only mode (tests)
    try {
      if (!fs.existsSync(this.persistPath)) return;
      const raw = fs.readFileSync(this.persistPath, { encoding: "utf-8" });
      const parsed: unknown = JSON.parse(raw as string);
      if (!Array.isArray(parsed)) return;
      // Accept only structurally-valid events; skip malformed entries
      const valid: McpDisconnectEvent[] = [];
      for (const item of parsed) {
        if (
          item &&
          typeof item === "object" &&
          typeof (item as Record<string, unknown>).timestamp === "string" &&
          typeof (item as Record<string, unknown>).serverName === "string" &&
          typeof (item as Record<string, unknown>).kind === "string" &&
          typeof (item as Record<string, unknown>).cause === "string"
        ) {
          valid.push(item as McpDisconnectEvent);
        }
      }
      // Apply cap after load
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
}
