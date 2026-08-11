/**
 * Minimal JSON-RPC message shape shared across the `minsky mcp shim`
 * modules (mt#3812).
 *
 * Deliberately NOT imported from src/mcp/stdio-proxy/tools.ts: that file
 * pulls in the stdio-proxy's tool-list-augmentation and restart-probe
 * surface, none of which the shim needs. Keeping this a standalone,
 * zero-dependency file is part of the entry-point split this task's
 * BLOCKING section requires — every import the shim's dependency graph
 * touches is a candidate for silently reintroducing the bundle-load cost
 * the split exists to avoid.
 */

export interface JsonRpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** A JSON-RPC request has both a `method` and an `id`. */
export function isRequest(msg: JsonRpcMessage): boolean {
  return typeof msg.method === "string" && msg.id !== undefined && msg.id !== null;
}

/** A JSON-RPC notification has a `method` but no `id`. */
export function isNotification(msg: JsonRpcMessage): boolean {
  return typeof msg.method === "string" && (msg.id === undefined || msg.id === null);
}

/**
 * Build a JSON-RPC error response frame. Used when the shim cannot forward
 * a request's real response — an HTTP failure against the daemon that
 * survived the retry window (see client.ts) — so the failure reaches the
 * client as a normal JSON-RPC error instead of silently vanishing (the
 * named gap in the mt#3884 spike this task's BLOCKING section calls out).
 */
export function makeErrorResponse(
  id: JsonRpcMessage["id"],
  code: number,
  message: string
): JsonRpcMessage {
  return {
    jsonrpc: "2.0",
    id: id ?? null,
    error: { code, message },
  };
}
