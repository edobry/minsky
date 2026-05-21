/**
 * Tool-list augmentation, `__proxy_restart_server` handler, and ping-based
 * readiness-probe helpers for the stdio proxy.
 *
 * The proxy intercepts JSON-RPC message types in three classes:
 *   1. `tools/list` RESPONSE (outbound, from child) — augmented with the
 *      `__proxy_restart_server` tool entry before forwarding to Claude Code.
 *   2. `tools/call` REQUEST (inbound, from Claude Code) where
 *      `params.name === "__proxy_restart_server"` — swallowed and handled
 *      locally by the proxy; the child never sees this call.
 *   3. Internal `ping` REQUEST (synthesized inbound, mt#2011) and its RESPONSE
 *      (outbound, from child). The proxy injects a `ping` after every child
 *      respawn to confirm the inner's protocol layer is operational, then
 *      emits an upstream `notifications/tools/list_changed` so Claude Code
 *      refreshes its tools cache. The response is swallowed; it never reaches
 *      upstream.
 *
 * All other messages pass through without parse.
 *
 * @see src/mcp/stdio-proxy/proxy.ts
 * @see docs/architecture/stdio-proxy.md
 */

/** The canonical name of the proxy-injected restart tool. */
export const PROXY_RESTART_TOOL_NAME = "__proxy_restart_server";

/**
 * Reserved JSON-RPC request-id prefix for the proxy's internal ping-based
 * readiness probe (mt#2011). After every inner-server (re)spawn the proxy
 * synthesizes a `ping` request with id `__proxy_ready_probe_<monotonic>` and
 * writes it to the child's stdin. The matching response is intercepted by the
 * outbound transform (swallowed; never forwarded upstream) and signals that
 * the inner's protocol layer is operational. Per MCP spec, `ping` is
 * transport-layer and does NOT require prior `initialize`, so the probe works
 * against a freshly-spawned child that has not seen a client handshake on
 * this respawn.
 */
export const PROXY_READY_PROBE_ID_PREFIX = "__proxy_ready_probe_";

/**
 * JSON-RPC method name for the tools-list-changed notification (mt#2011).
 * Per the MCP spec, this is a server-to-client notification telling the
 * client its cached tools/list is stale and SHOULD be re-fetched.
 */
export const TOOLS_LIST_CHANGED_NOTIFICATION_METHOD = "notifications/tools/list_changed";

/** JSON-RPC message shape (minimal; we only need the fields we inspect). */
export interface JsonRpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
}

/** MCP tool descriptor shape for `tools/list` results. */
export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

/** `tools/list` result shape. */
interface ToolsListResult {
  tools: McpTool[];
  [key: string]: unknown;
}

/**
 * The proxy-injected tool entry appended to every `tools/list` response.
 * Schema: no arguments — the restart has no parameters.
 */
export const PROXY_RESTART_TOOL_ENTRY: McpTool = {
  name: PROXY_RESTART_TOOL_NAME,
  description:
    "Restart the Minsky MCP daemon to pick up source changes. " +
    "Closes and respawns the inner server while keeping Claude Code's connection alive. " +
    "Injected by the minsky mcp proxy layer; not present when running minsky mcp start directly.",
  inputSchema: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
};

/**
 * Check whether a JSON-RPC message is a `tools/list` response from the child
 * that we should augment.
 *
 * A `tools/list` response:
 *   - Has `result` (not `error`).
 *   - The result has a `tools` array.
 *
 * NOTE: This predicate does NOT check for an existing `__proxy_restart_server`
 * entry. That check has been moved into `augmentToolsListResponse` so that
 * collision detection (and the associated stderr warning) is reachable when the
 * inner server exposes the same tool name. Previously the early-return here made
 * the collision warning in `augmentToolsListResponse` dead code (BLOCKING 3,
 * PR #1039 R1).
 */
function isToolsListResponse(
  msg: JsonRpcMessage
): msg is JsonRpcMessage & { result: ToolsListResult } {
  if (!msg.result || msg.error) return false;
  const result = msg.result as Record<string, unknown>;
  if (!Array.isArray(result["tools"])) return false;
  return true;
}

/**
 * Augment a `tools/list` response with the `__proxy_restart_server` tool.
 *
 * Returns the original object unchanged when:
 *   - The message is not a `tools/list` response (not a result, or no `tools` array).
 *   - The tools list already contains `__proxy_restart_server` — either because
 *     this function has already run on this message (idempotent fast-path), or
 *     because the inner server itself exposes a tool with that name. In the latter
 *     case a warning is written to stderr to alert the operator of the collision
 *     (the inner server's version takes precedence; the proxy does not append a
 *     duplicate). Reference-equality of the return value is used by the proxy
 *     transform as a fast-path to skip JSON.stringify.
 *
 * Returns a new object (spread) when the tool was not already present and was
 * successfully appended.
 */
export function augmentToolsListResponse(msg: JsonRpcMessage): JsonRpcMessage {
  if (!isToolsListResponse(msg)) return msg;

  const result = msg.result as ToolsListResult;
  const tools = result.tools;

  // Idempotency + collision check: if __proxy_restart_server is already in the
  // list, do NOT append again. Two sub-cases:
  //
  //   a) Already-augmented message: this function ran on a prior pass. Silent
  //      no-op — return the same reference so the proxy transform fast-paths.
  //   b) Collision: the inner server exposes a tool with the same name. Emit a
  //      warning to stderr so the operator is informed. The inner server's
  //      version is preserved; we do not append a duplicate.
  //
  // Prior to this fix (BLOCKING 3, PR #1039 R1), the collision check lived in
  // isToolsListResponse() as an early-return false, making this block
  // unreachable when the inner server had a colliding tool. The warning was
  // present in the source but could never fire.
  const existingEntry = tools.find((t) => t.name === PROXY_RESTART_TOOL_NAME);
  if (existingEntry) {
    // Determine which sub-case we are in: if the entry matches our canonical
    // descriptor it is the already-augmented case; otherwise it is a collision.
    if (existingEntry !== PROXY_RESTART_TOOL_ENTRY) {
      // Collision: inner server exposes a tool with the same name.
      // Log via stderr to avoid polluting the MCP stdio stdout channel.
      process.stderr.write(
        `[proxy] WARNING: inner server exposes a tool named "${PROXY_RESTART_TOOL_NAME}" ` +
          "which collides with the proxy-injected tool. The inner server's version will be preserved; " +
          "the proxy-injected version is suppressed.\n"
      );
    }
    return msg;
  }

  // Return a new object to preserve immutability of the original parse.
  return {
    ...msg,
    result: {
      ...result,
      tools: [...tools, PROXY_RESTART_TOOL_ENTRY],
    },
  };
}

/**
 * Check whether an inbound JSON-RPC message is a `tools/call` request for
 * `__proxy_restart_server`.
 */
export function isProxyRestartRequest(msg: JsonRpcMessage): boolean {
  if (msg.method !== "tools/call") return false;
  if (!msg.params || typeof msg.params !== "object") return false;
  return msg.params["name"] === PROXY_RESTART_TOOL_NAME;
}

/**
 * Build a JSON-RPC `tools/call` success response to send back to Claude Code
 * after handling `__proxy_restart_server` locally.
 *
 * Uses the request's `id` so the SDK can correlate request ↔ response.
 */
export function makeToolCallResponse(request: JsonRpcMessage, text: string): JsonRpcMessage {
  return {
    jsonrpc: "2.0",
    id: request.id ?? null,
    result: {
      content: [
        {
          type: "text",
          text,
        },
      ],
    },
  };
}

/**
 * Build the JSON-RPC `ping` request the proxy sends to probe inner readiness
 * after a respawn (mt#2011). The `id` carries the reserved
 * `__proxy_ready_probe_` prefix so the outbound transform can recognise the
 * matching response and (a) swallow it, and (b) trigger the upstream
 * `notifications/tools/list_changed` emission.
 *
 * Per MCP spec, `ping` is a transport-layer liveness method handled by the
 * SDK base `Protocol` class; it does NOT require prior `initialize`.
 */
export function buildReadyProbeRequest(id: string): JsonRpcMessage {
  return {
    jsonrpc: "2.0",
    id,
    method: "ping",
  };
}

/**
 * Test whether a JSON-RPC message is a response to the proxy's readiness
 * probe (mt#2011). Matches by the reserved `__proxy_ready_probe_` id prefix.
 * The caller is responsible for additionally confirming the message id
 * matches the SPECIFIC probe currently outstanding so that stale responses
 * from prior respawns do not accidentally resolve the current probe.
 */
export function isReadyProbeResponse(msg: JsonRpcMessage): boolean {
  if (typeof msg.id !== "string") return false;
  return msg.id.startsWith(PROXY_READY_PROBE_ID_PREFIX);
}

/**
 * Build the upstream `notifications/tools/list_changed` JSON-RPC notification
 * frame (mt#2011). A notification has no `id` field per JSON-RPC 2.0; the
 * absence of `id` is what distinguishes a notification from a request.
 */
export function buildToolsListChangedNotification(): JsonRpcMessage {
  return {
    jsonrpc: "2.0",
    method: TOOLS_LIST_CHANGED_NOTIFICATION_METHOD,
  };
}
