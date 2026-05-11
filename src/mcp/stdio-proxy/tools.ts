/**
 * Tool-list augmentation and `__proxy_restart_server` handler for the stdio proxy.
 *
 * The proxy intercepts two JSON-RPC message types:
 *   1. `tools/list` RESPONSE (outbound, from child) — augmented with the
 *      `__proxy_restart_server` tool entry before forwarding to Claude Code.
 *   2. `tools/call` REQUEST (inbound, from Claude Code) where
 *      `params.name === "__proxy_restart_server"` — swallowed and handled
 *      locally by the proxy; the child never sees this call.
 *
 * All other messages pass through without parse.
 *
 * @see src/mcp/stdio-proxy/proxy.ts
 * @see docs/architecture/stdio-proxy.md
 */

/** The canonical name of the proxy-injected restart tool. */
export const PROXY_RESTART_TOOL_NAME = "__proxy_restart_server";

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
 *   - The result does NOT already contain `__proxy_restart_server` (idempotent).
 */
function isToolsListResponse(
  msg: JsonRpcMessage
): msg is JsonRpcMessage & { result: ToolsListResult } {
  if (!msg.result || msg.error) return false;
  const result = msg.result as Record<string, unknown>;
  if (!Array.isArray(result["tools"])) return false;
  // Already augmented (shouldn't happen, but be idempotent).
  const tools = result["tools"] as McpTool[];
  if (tools.some((t) => t.name === PROXY_RESTART_TOOL_NAME)) return false;
  return true;
}

/**
 * Augment a `tools/list` response with the `__proxy_restart_server` tool.
 *
 * Returns the same object (mutated) if the message is a tools/list response,
 * or the original unmodified object if not (reference equality check enables
 * fast-path in the proxy transform).
 *
 * Also emits a one-time warning if the inner server happens to already expose
 * a tool with the same name — this indicates a namespace collision.
 */
export function augmentToolsListResponse(msg: JsonRpcMessage): JsonRpcMessage {
  if (!isToolsListResponse(msg)) return msg;

  const result = msg.result as ToolsListResult;
  const tools = result.tools;

  // Collision check: warn if inner server happens to expose same name.
  const collision = tools.find((t) => t.name === PROXY_RESTART_TOOL_NAME);
  if (collision) {
    // Log via stderr to avoid polluting stdout.
    process.stderr.write(
      `[proxy] WARNING: inner server exposes a tool named "${PROXY_RESTART_TOOL_NAME}" ` +
        "which collides with the proxy-injected tool. The inner server's version will be shadowed.\n"
    );
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
