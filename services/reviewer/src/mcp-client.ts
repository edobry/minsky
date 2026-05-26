/**
 * Shared Streamable-HTTP MCP client for the Minsky MCP server.
 *
 * Implements the MCP Streamable HTTP protocol's `initialize` → `tools/call`
 * handshake. The server (src/mcp/server.ts, lines 556-573) enforces that the
 * first request from any client must be `initialize`; subsequent requests must
 * include the captured `Mcp-Session-Id` header. Skipping the handshake causes
 * every `tools/call` to fail with `-32600 "Invalid Request: first request must
 * be initialize"` — the mt#1821 bug.
 *
 * This module is the single shared client for the reviewer service. Active
 * callers (as of mt#2121):
 * - server.ts — at-merge webhook handler (`runMergeStateSyncViaTaskId`)
 * - adoption-sweeper.ts — adoption signal ingestion (pending mt#2101 migration)
 *
 * Former callers migrated to direct domain imports (mt#2121):
 * - merge-state-sweeper.ts — uses @minsky/domain/session directly
 * - tier-routing.ts — uses ProvenanceService directly
 * - task-spec-fetch.ts — uses TaskServiceInterface directly
 * - pr-watch-scheduler.ts — uses @minsky/domain container directly
 * - asks-reconcile-scheduler.ts — uses @minsky/domain container directly
 *
 * Design constraints:
 * - Plain fetch only — no @modelcontextprotocol/sdk dependency.
 * - Bearer token MUST NOT appear in logs.
 * - Body is always drained on error paths to avoid connection leaks.
 * - Session cache scoped to (mcpUrl, mcpToken); reset via resetMcpClientSessions() for tests.
 * - On -32001 "Session not found" OR HTTP 404, the cache is invalidated and one retry runs.
 */

import { log } from "./logger";
import { safeTruncate } from "@minsky/shared/safe-truncate";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Minimal MCP config — extracted from the reviewer config or constructed directly. */
export interface McpClientConfig {
  mcpUrl: string;
  mcpToken: string;
}

/** Options for callMcp. */
export interface CallMcpOptions {
  /** Overall AbortController timeout in ms (covers initialize + tools/call + retry). Default 15000. */
  timeoutMs?: number;
  /**
   * Log-event prefix used in structured warnings.
   * E.g. "merge_state_sweeper.mcp" emits events like
   *   "merge_state_sweeper.mcp_http_error", "merge_state_sweeper.mcp_init_failed".
   * Defaults to "mcp_client.mcp".
   */
  logPrefix?: string;
  /**
   * Logger function. Defaults to `log.warn` (reviewer-local winston logger).
   * Used for transport/protocol-level warnings; tool-result content is never logged.
   */
  logger?: (event: Record<string, unknown>) => void;
}

/** Success outcome of callMcp. */
export interface CallMcpSuccess {
  ok: true;
  /** Concatenated value of all `type: "text"` content entries, or null if none. */
  contentText: string | null;
  /** Value of the first `type: "json"` content entry, or null if none. */
  contentJson: unknown;
  /** The full raw result envelope (for callers that need isError or other fields). */
  rawResult: McpToolResult | undefined;
}

/** Failure outcome of callMcp. */
export interface CallMcpFailure {
  ok: false;
  reason:
    | "config-missing"
    | "init-failed"
    | "http-error"
    | "fetch-error"
    | "rpc-error"
    | "tool-error"
    | "parse-error";
  httpStatus?: number;
  rpcError?: { code?: number; message: string };
  message: string;
}

export type CallMcpResult = CallMcpSuccess | CallMcpFailure;

// ---------------------------------------------------------------------------
// Internal protocol types
// ---------------------------------------------------------------------------

interface McpJsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

interface McpJsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}

type McpContentEntry =
  | { type: "text"; text?: string }
  | { type: "json"; json?: unknown }
  | { type: string };

interface McpToolResult {
  content?: Array<McpContentEntry>;
  isError?: boolean;
}

interface McpJsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string;
  result?: McpToolResult;
  error?: { code: number; message: string };
}

// ---------------------------------------------------------------------------
// Module-scope state: session cache + in-flight init memoization
// ---------------------------------------------------------------------------

/** Key sessions by (url, token) so multiple tokens against the same URL stay isolated. */
function cacheKey(config: McpClientConfig): string {
  return `${config.mcpUrl}|;${config.mcpToken}`;
}

/** Cached MCP session ids: cacheKey → mcp-session-id header value. */
const sessionCache = new Map<string, string>();

/** In-flight initializes — coalesces parallel callers into one network init. */
const pendingInits = new Map<string, Promise<string>>();

/** Monotonically increasing JSON-RPC id; avoids hardcoded `id: 1`. */
let nextRequestId = 1;

/**
 * Clear all cached MCP sessions and in-flight initializes.
 *
 * Tests call this in `beforeEach` so module-scope state doesn't leak across
 * test cases (Bun caches imports, so the cache survives between tests).
 */
export function resetMcpClientSessions(): void {
  sessionCache.clear();
  pendingInits.clear();
}

// ---------------------------------------------------------------------------
// Default logger
// ---------------------------------------------------------------------------

function defaultLogger(event: Record<string, unknown>): void {
  const name = typeof event["event"] === "string" ? (event["event"] as string) : "mcp_client.event";
  log.warn(name, event);
}

// ---------------------------------------------------------------------------
// SSE / JSON body parsing
// ---------------------------------------------------------------------------

/**
 * Extract the LAST JSON object or array from a possibly SSE-formatted body.
 *
 * Plain JSON bodies are returned as-is. For SSE responses, the final
 * well-formed JSON payload is returned (earlier events may be progress/log
 * entries; the final event carries the tool result).
 */
function extractJsonFromBody(body: string): string | null {
  const trimmed = body.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return trimmed;
  }
  let last: string | null = null;
  for (const line of trimmed.split("\n")) {
    const stripped = line.trim();
    if (stripped.startsWith("data:")) {
      const payload = stripped.slice("data:".length).trim();
      if (payload.startsWith("{") || payload.startsWith("[")) {
        last = payload;
      }
    }
  }
  return last;
}

// ---------------------------------------------------------------------------
// Initialize handshake
// ---------------------------------------------------------------------------

/**
 * Protocol version we advertise. The MCP server upgrades/downgrades as needed;
 * any version the server supports works. "2025-03-26" is the Streamable HTTP
 * protocol revision the Minsky MCP server speaks.
 */
const CLIENT_PROTOCOL_VERSION = "2025-03-26";

/**
 * Perform the MCP initialize handshake against the server.
 *
 * Returns the captured `mcp-session-id` header value. The caller MUST send
 * this value as the `Mcp-Session-Id` header on every subsequent JSON-RPC
 * request belonging to this logical session.
 *
 * After initialize succeeds, this function also fires the
 * `notifications/initialized` JSON-RPC notification (best-effort; the server
 * may not require it, but the spec calls for it). Failures of the
 * notification are logged but do not fail the handshake.
 */
async function initializeSessionUncached(
  config: McpClientConfig,
  signal: AbortSignal,
  logPrefix: string,
  logger: (event: Record<string, unknown>) => void
): Promise<string> {
  const initBody: McpJsonRpcRequest = {
    jsonrpc: "2.0",
    id: nextRequestId++,
    method: "initialize",
    params: {
      protocolVersion: CLIENT_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "minsky-reviewer-service", version: "1.0.0" },
    },
  };

  let response: Response;
  try {
    response = await fetch(config.mcpUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${config.mcpToken}`,
      },
      body: JSON.stringify(initBody),
      signal,
    });
  } catch (fetchErr) {
    const msg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
    logger({ event: `${logPrefix}_init_fetch_error`, error: msg });
    throw new Error(`initialize fetch failed: ${msg}`);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "(unreadable)");
    logger({
      event: `${logPrefix}_init_http_error`,
      status: response.status,
      body: safeTruncate(body, 200, "head"),
    });
    throw new Error(`initialize HTTP ${response.status}`);
  }

  // Capture session id from response header (case-insensitive lookup).
  const sessionId = response.headers.get("mcp-session-id");
  if (!sessionId) {
    // Drain body before throwing.
    await response.text().catch(() => undefined);
    logger({ event: `${logPrefix}_init_no_session_id` });
    throw new Error("initialize response missing Mcp-Session-Id header");
  }

  // Drain the initialize result body (we don't currently consume its capabilities).
  await response.text().catch(() => undefined);

  // Best-effort: send notifications/initialized so the server can advance from
  // the post-initialize state. Failures are tolerated — the session is usable.
  const notif: McpJsonRpcNotification = {
    jsonrpc: "2.0",
    method: "notifications/initialized",
  };
  try {
    const notifResponse = await fetch(config.mcpUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${config.mcpToken}`,
        "Mcp-Session-Id": sessionId,
      },
      body: JSON.stringify(notif),
      signal,
    });
    // Drain body even on 2xx so the connection is returned to the pool.
    await notifResponse.text().catch(() => undefined);
    if (!notifResponse.ok) {
      logger({
        event: `${logPrefix}_init_notif_non_2xx`,
        status: notifResponse.status,
      });
    }
  } catch (notifErr) {
    const msg = notifErr instanceof Error ? notifErr.message : String(notifErr);
    logger({ event: `${logPrefix}_init_notif_failed`, error: msg });
    // Continue — session is established.
  }

  return sessionId;
}

/**
 * Get or create an MCP session id for (config.mcpUrl, config.mcpToken).
 *
 * Coalesces parallel callers via `pendingInits` so only one network
 * initialize fires per unique config tuple at a time.
 */
async function getOrCreateSession(
  config: McpClientConfig,
  signal: AbortSignal,
  logPrefix: string,
  logger: (event: Record<string, unknown>) => void
): Promise<string> {
  const key = cacheKey(config);

  const cached = sessionCache.get(key);
  if (cached) return cached;

  const inFlight = pendingInits.get(key);
  if (inFlight) return inFlight;

  const promise = initializeSessionUncached(config, signal, logPrefix, logger)
    .then((sessionId) => {
      sessionCache.set(key, sessionId);
      pendingInits.delete(key);
      return sessionId;
    })
    .catch((err) => {
      pendingInits.delete(key);
      throw err;
    });

  pendingInits.set(key, promise);
  return promise;
}

/** Invalidate the cached session for a config (e.g., on -32001 / 404). */
function invalidateSession(config: McpClientConfig): void {
  sessionCache.delete(cacheKey(config));
}

// ---------------------------------------------------------------------------
// tools/call dispatch
// ---------------------------------------------------------------------------

/**
 * Determine whether a failure indicates the session is gone server-side and
 * we should re-initialize and retry once.
 *
 * Conditions per MCP Streamable HTTP spec:
 * - JSON-RPC error code -32001 with message "Session not found"
 * - HTTP 404 (server discards unknown sessions with this status)
 */
function isSessionExpired(result: CallMcpResult): boolean {
  if (result.ok) return false;
  if (result.reason === "rpc-error" && result.rpcError?.code === -32001) return true;
  if (result.reason === "http-error" && result.httpStatus === 404) return true;
  return false;
}

/**
 * POST a single tools/call with a known session id and parse the response.
 *
 * No retry, no init — this is the inner step `callMcp` orchestrates with
 * the init handshake and session-expiry retry around it.
 */
async function postToolsCall(
  toolName: string,
  args: Record<string, unknown>,
  config: McpClientConfig,
  sessionId: string,
  signal: AbortSignal,
  logPrefix: string,
  logger: (event: Record<string, unknown>) => void
): Promise<CallMcpResult> {
  const body: McpJsonRpcRequest = {
    jsonrpc: "2.0",
    id: nextRequestId++,
    method: "tools/call",
    params: { name: toolName, arguments: args },
  };

  let response: Response;
  try {
    response = await fetch(config.mcpUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${config.mcpToken}`,
        "Mcp-Session-Id": sessionId,
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (fetchErr) {
    const msg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
    logger({ event: `${logPrefix}_fetch_error`, tool: toolName, error: msg });
    return { ok: false, reason: "fetch-error", message: msg };
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "(unreadable)");
    logger({
      event: `${logPrefix}_http_error`,
      tool: toolName,
      status: response.status,
      body: safeTruncate(text, 200, "head"),
    });
    return {
      ok: false,
      reason: "http-error",
      httpStatus: response.status,
      message: `HTTP ${response.status}`,
    };
  }

  let raw: string;
  try {
    raw = await response.text();
  } catch (readErr) {
    const msg = readErr instanceof Error ? readErr.message : String(readErr);
    logger({ event: `${logPrefix}_body_read_error`, tool: toolName, error: msg });
    return { ok: false, reason: "parse-error", message: `body read failed: ${msg}` };
  }

  const jsonText = extractJsonFromBody(raw);
  if (!jsonText) {
    logger({ event: `${logPrefix}_parse_error`, tool: toolName, reason: "no_json_payload" });
    return { ok: false, reason: "parse-error", message: "unparseable response body" };
  }

  let parsed: McpJsonRpcResponse;
  try {
    parsed = JSON.parse(jsonText) as McpJsonRpcResponse;
  } catch {
    logger({ event: `${logPrefix}_parse_error`, tool: toolName, reason: "json_parse_failure" });
    return { ok: false, reason: "parse-error", message: "JSON parse error" };
  }

  if (parsed.error) {
    logger({
      event: `${logPrefix}_rpc_error`,
      tool: toolName,
      code: parsed.error.code,
      error: parsed.error.message,
    });
    return {
      ok: false,
      reason: "rpc-error",
      rpcError: { code: parsed.error.code, message: parsed.error.message },
      message: `MCP error ${parsed.error.code}: ${parsed.error.message}`,
    };
  }

  if (parsed.result?.isError === true) {
    logger({ event: `${logPrefix}_tool_error`, tool: toolName });
    return {
      ok: false,
      reason: "tool-error",
      message: "tool-level error in result",
    };
  }

  const content = parsed.result?.content ?? [];
  const jsonEntry = content.find(
    (b): b is { type: "json"; json: unknown } =>
      b?.type === "json" && "json" in (b as { json?: unknown })
  );
  const textChunks = content
    .filter(
      (b): b is { type: "text"; text: string } =>
        b?.type === "text" && typeof (b as { text?: unknown }).text === "string"
    )
    .map((b) => b.text);

  return {
    ok: true,
    contentText: textChunks.length > 0 ? textChunks.join("") : null,
    contentJson: jsonEntry ? jsonEntry.json : null,
    rawResult: parsed.result,
  };
}

// ---------------------------------------------------------------------------
// Public callMcp entrypoint
// ---------------------------------------------------------------------------

/**
 * Call an MCP tool on the configured Minsky MCP server.
 *
 * Performs the initialize handshake on first use (per config tuple), reuses
 * the cached session id on subsequent calls, and re-initializes once on
 * session-expiry signals (`-32001 "Session not found"` or HTTP 404).
 *
 * Failures are returned as `{ ok: false, reason, ... }` envelopes — this
 * function never throws. Callers MAY check `result.reason` to surface
 * specific error classes (e.g. `http-error` vs `rpc-error`).
 */
export async function callMcp(
  toolName: string,
  args: Record<string, unknown>,
  config: McpClientConfig,
  options: CallMcpOptions = {}
): Promise<CallMcpResult> {
  if (!config.mcpUrl || !config.mcpToken) {
    return {
      ok: false,
      reason: "config-missing",
      message: "mcpUrl or mcpToken missing",
    };
  }

  const timeoutMs = options.timeoutMs ?? 15_000;
  const logPrefix = options.logPrefix ?? "mcp_client.mcp";
  const logger = options.logger ?? defaultLogger;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    // Phase 1: get/create session.
    let sessionId: string;
    try {
      sessionId = await getOrCreateSession(config, controller.signal, logPrefix, logger);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, reason: "init-failed", message: msg };
    }

    // Phase 2: tools/call.
    const result = await postToolsCall(
      toolName,
      args,
      config,
      sessionId,
      controller.signal,
      logPrefix,
      logger
    );

    if (!isSessionExpired(result)) {
      return result;
    }

    // Phase 3: session expired — invalidate, re-init, retry once.
    logger({
      event: `${logPrefix}_session_expired_retrying`,
      tool: toolName,
      previous_session_id_prefix: sessionId.slice(0, 8),
    });
    invalidateSession(config);

    let retrySessionId: string;
    try {
      retrySessionId = await getOrCreateSession(config, controller.signal, logPrefix, logger);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, reason: "init-failed", message: `re-init failed: ${msg}` };
    }

    return await postToolsCall(
      toolName,
      args,
      config,
      retrySessionId,
      controller.signal,
      logPrefix,
      logger
    );
  } finally {
    clearTimeout(timeoutId);
  }
}
