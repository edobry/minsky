/**
 * Thin Streamable-HTTP MCP client for the Minsky MCP server.
 *
 * Calls provenance_get (provenance.get) against the hosted Minsky MCP endpoint
 * to look up authorship tier for a given artifact.
 *
 * Design constraints:
 * - Plain fetch only — no @modelcontextprotocol/sdk dependency.
 * - 10 s timeout per call.
 * - Bearer token MUST NOT appear in logs.
 * - Body is always drained on error paths to avoid connection leaks.
 */

import type { ReviewerConfig } from "./config";

/** Shape of a provenance record returned by the MCP tool. */
export interface ProvenanceResult {
  authorshipTier: number | null;
  artifactId: string;
  artifactType: string;
  [key: string]: unknown;
}

/** Outcome of calling `tasks.spec.get` on the hosted MCP. */
export type TasksSpecGetResult =
  | { kind: "found"; content: string }
  | { kind: "disabled" } // MCP config missing — caller should classify as disabled
  | { kind: "not-found" } // MCP reachable but no spec for the given taskId
  | { kind: "error"; message: string }; // transport / tool error

/** MCP JSON-RPC 2.0 request body. */
interface McpCallToolRequest {
  jsonrpc: "2.0";
  id: number;
  method: "tools/call";
  params: {
    name: string;
    arguments: Record<string, unknown>;
  };
}

/** A single content entry in an MCP tool response. */
type McpContentEntry =
  | { type: "text"; text?: string }
  | { type: "json"; json?: unknown }
  | { type: string };

/** MCP JSON-RPC 2.0 response shape (success). */
interface McpCallToolResponse {
  jsonrpc: "2.0";
  id: number;
  result?: {
    content?: Array<McpContentEntry>;
    isError?: boolean;
  };
  error?: { code: number; message: string };
}

const CALL_TIMEOUT_MS = 10_000;

/** Monotonically increasing request id — avoids hardcoded `id: 1`. */
let nextRequestId = 1;

/**
 * Call the provenance.get MCP tool on the hosted Minsky server.
 *
 * Returns the provenance record on success, or null if:
 * - The record does not exist (tool returns null).
 * - The MCP server is unreachable or returns an error.
 * - The response body cannot be parsed.
 *
 * Errors are logged but never re-thrown — callers should fall back gracefully.
 */
export async function callProvenanceGet(
  artifactId: string,
  artifactType: string,
  config: ReviewerConfig
): Promise<ProvenanceResult | null> {
  const { mcpUrl, mcpToken } = config;

  if (!mcpUrl || !mcpToken) {
    // Missing config — caller is expected to have logged a warning at startup;
    // just return null here so the fallback chain takes over.
    return null;
  }

  const body: McpCallToolRequest = {
    jsonrpc: "2.0",
    id: nextRequestId++,
    method: "tools/call",
    params: {
      name: "provenance.get",
      arguments: { artifactId, artifactType },
    },
  };

  // Keep the AbortController alive through the entire response body read,
  // not just the fetch() call. This prevents SSE connections from hanging
  // indefinitely on response.text().
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);

  try {
    let response: Response;
    try {
      response = await fetch(mcpUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          // Token deliberately not logged — see module docstring.
          Authorization: `Bearer ${mcpToken}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (fetchErr) {
      const msg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
      console.error(`[mcp-client] fetch failed for provenance.get(${artifactId}): ${msg}`);
      return null;
    }

    if (!response.ok) {
      // Drain body to avoid connection leaks before returning.
      await response.text().catch(() => undefined);
      console.error(
        `[mcp-client] provenance.get(${artifactId}) HTTP ${response.status} ${response.statusText}`
      );
      return null;
    }

    let raw: string;
    try {
      // response.text() is also protected by the same AbortController signal.
      raw = await response.text();
    } catch (readErr) {
      const msg = readErr instanceof Error ? readErr.message : String(readErr);
      console.error(`[mcp-client] failed to read response body: ${msg}`);
      return null;
    }

    // Streamable HTTP can return SSE (text/event-stream) or plain JSON.
    // Extract the first JSON object from the body.
    const jsonText = extractJsonFromBody(raw);
    if (!jsonText) {
      console.error(`[mcp-client] provenance.get(${artifactId}): unparseable response body`);
      return null;
    }

    let parsed: McpCallToolResponse;
    try {
      parsed = JSON.parse(jsonText) as McpCallToolResponse;
    } catch {
      console.error(`[mcp-client] provenance.get(${artifactId}): JSON parse error`);
      return null;
    }

    if (parsed.error) {
      console.error(
        `[mcp-client] provenance.get(${artifactId}) MCP error ${parsed.error.code}: ${parsed.error.message}`
      );
      return null;
    }

    // Tool-level error: result.isError === true means the tool itself failed.
    if (parsed.result?.isError === true) {
      console.error(`[mcp-client] provenance.get(${artifactId}) tool-level error in result`);
      return null;
    }

    // The MCP tool returns the record in result.content[0].
    // The MCP SDK allows two content shapes:
    //   { type: "text", text: "<JSON string>" }  — current server emits this
    //   { type: "json", json: <value> }           — future-proof defensive support
    const content = parsed.result?.content;
    if (!content || content.length === 0) {
      return null;
    }

    const first = content[0];
    if (!first) {
      return null;
    }

    let record: unknown;
    if (first.type === "json" && "json" in first) {
      record = (first as { type: "json"; json: unknown }).json;
    } else if (first.type === "text" && "text" in first && (first as { text?: string }).text) {
      try {
        record = JSON.parse((first as { text: string }).text);
      } catch {
        console.error(`[mcp-client] provenance.get(${artifactId}): could not parse content text`);
        return null;
      }
    } else {
      return null;
    }

    if (record === null || typeof record !== "object") {
      // Tool returned null (no provenance record exists).
      return null;
    }

    return record as ProvenanceResult;
  } finally {
    // Always clear the timeout — even after body read completes.
    clearTimeout(timeoutId);
  }
}

/**
 * Call the tasks.spec.get MCP tool on the hosted Minsky server.
 *
 * Returns a discriminated result: `found` with the spec markdown, `not-found`
 * when the MCP returned no content, `disabled` when MCP config is missing,
 * or `error` with the tool-level / transport error message.
 *
 * Unlike callProvenanceGet which returns null on all failure modes, this one
 * distinguishes `not-found` from `error` because the reviewer logs record both
 * statuses separately (disabled / no-task-id / not-found / found / error).
 * Tool-level `{ success: false, error }` envelopes surface as `error` so
 * operational failures (e.g., schema / setup issues on the hosted MCP) aren't
 * hidden as "task missing."
 */
export async function callTasksSpecGet(
  taskId: string,
  config: ReviewerConfig
): Promise<TasksSpecGetResult> {
  const { mcpUrl, mcpToken } = config;

  if (!mcpUrl || !mcpToken) {
    return { kind: "disabled" };
  }

  const body: McpCallToolRequest = {
    jsonrpc: "2.0",
    id: nextRequestId++,
    method: "tools/call",
    params: {
      name: "tasks.spec.get",
      arguments: { taskId },
    },
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);

  try {
    let response: Response;
    try {
      response = await fetch(mcpUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          Authorization: `Bearer ${mcpToken}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (fetchErr) {
      const msg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
      return { kind: "error", message: `fetch failed: ${msg}` };
    }

    if (!response.ok) {
      await response.text().catch(() => undefined);
      return {
        kind: "error",
        message: `HTTP ${response.status} ${response.statusText}`,
      };
    }

    let raw: string;
    try {
      raw = await response.text();
    } catch (readErr) {
      const msg = readErr instanceof Error ? readErr.message : String(readErr);
      return { kind: "error", message: `body read failed: ${msg}` };
    }

    const jsonText = extractJsonFromBody(raw);
    if (!jsonText) {
      return { kind: "error", message: "unparseable response body" };
    }

    let parsed: McpCallToolResponse;
    try {
      parsed = JSON.parse(jsonText) as McpCallToolResponse;
    } catch {
      return { kind: "error", message: "JSON parse error" };
    }

    if (parsed.error) {
      return {
        kind: "error",
        message: `MCP error ${parsed.error.code}: ${parsed.error.message}`,
      };
    }

    if (parsed.result?.isError === true) {
      return { kind: "error", message: "tool-level error in result" };
    }

    const content = parsed.result?.content;
    if (!content || content.length === 0) {
      return { kind: "not-found" };
    }

    // Collect all envelope-bearing chunks. The Minsky MCP may emit
    //   { type: "text", text: "<JSON>" }
    // or (future-proof) { type: "json", json: <object> }.
    // Concatenate text chunks before parsing — multi-chunk responses for
    // large payloads land here — and accept the first json-typed entry as
    // a pre-parsed envelope.
    const jsonEntry = content.find(
      (b): b is { type: "json"; json: unknown } =>
        b?.type === "json" && "json" in (b as { json?: unknown })
    );
    let envelope: { success?: unknown; content?: unknown; error?: unknown } | null = null;
    if (jsonEntry) {
      envelope = jsonEntry.json as typeof envelope;
    } else {
      const textChunks = content
        .filter(
          (b): b is { type: "text"; text: string } =>
            b?.type === "text" && typeof (b as { text?: unknown }).text === "string"
        )
        .map((b) => b.text);
      if (textChunks.length === 0) {
        return { kind: "not-found" };
      }
      const joined = textChunks.join("");
      try {
        envelope = JSON.parse(joined) as typeof envelope;
      } catch {
        // Defensive: if the content is plain markdown rather than the JSON
        // envelope, accept it. The Minsky MCP's documented shape is
        // JSON-wrapped, but this keeps the client robust against future
        // shape changes.
        return joined.length > 0 ? { kind: "found", content: joined } : { kind: "not-found" };
      }
    }

    if (envelope && typeof envelope === "object" && envelope.success === false) {
      const message =
        typeof envelope.error === "string" && envelope.error.length > 0
          ? envelope.error
          : "tool returned success:false with no error message";
      return { kind: "error", message };
    }

    if (
      envelope &&
      typeof envelope === "object" &&
      envelope.success === true &&
      typeof envelope.content === "string" &&
      envelope.content.length > 0
    ) {
      return { kind: "found", content: envelope.content };
    }

    return { kind: "not-found" };
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Extract the last JSON object or array from a possibly SSE-formatted body.
 *
 * SSE lines look like:
 *   data: {"jsonrpc":"2.0",...}
 *
 * Plain JSON bodies are returned as-is.
 *
 * For SSE responses, the LAST well-formed JSON payload is returned rather than
 * the first, because real MCP streamable-HTTP responses may emit progress events
 * before the final tool-result event. Returning the first event would capture a
 * progress/log entry instead of the actual result.
 */
function extractJsonFromBody(body: string): string | null {
  const trimmed = body.trim();
  if (!trimmed) return null;

  // Plain JSON (no SSE framing).
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return trimmed;
  }

  // SSE framing: scan for data: lines, return the LAST well-formed JSON payload.
  // Earlier events may be progress/logs; the final event carries the tool result.
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
