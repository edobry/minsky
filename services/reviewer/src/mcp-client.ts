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

/** MCP JSON-RPC 2.0 response shape (success). */
interface McpCallToolResponse {
  jsonrpc: "2.0";
  id: number;
  result?: {
    content?: Array<{ type: string; text?: string }>;
    isError?: boolean;
  };
  error?: { code: number; message: string };
}

const CALL_TIMEOUT_MS = 10_000;

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
    id: 1,
    method: "tools/call",
    params: {
      name: "provenance.get",
      arguments: { artifactId, artifactType },
    },
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);

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
    clearTimeout(timeoutId);
    const msg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
    console.error(`[mcp-client] fetch failed for provenance.get(${artifactId}): ${msg}`);
    return null;
  } finally {
    clearTimeout(timeoutId);
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

  // The MCP tool returns the record serialised in result.content[0].text
  const content = parsed.result?.content;
  if (!content || content.length === 0) {
    return null;
  }

  const first = content[0];
  if (!first || first.type !== "text" || !first.text) {
    return null;
  }

  let record: unknown;
  try {
    record = JSON.parse(first.text);
  } catch {
    console.error(`[mcp-client] provenance.get(${artifactId}): could not parse content text`);
    return null;
  }

  if (record === null || typeof record !== "object") {
    // Tool returned null (no provenance record exists).
    return null;
  }

  return record as ProvenanceResult;
}

/**
 * Extract the first JSON object or array from a possibly SSE-formatted body.
 *
 * SSE lines look like:
 *   data: {"jsonrpc":"2.0",...}
 *
 * Plain JSON bodies are returned as-is.
 */
function extractJsonFromBody(body: string): string | null {
  const trimmed = body.trim();
  if (!trimmed) return null;

  // Try plain JSON first.
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return trimmed;
  }

  // SSE format: scan for a "data:" line that starts with {
  for (const line of trimmed.split("\n")) {
    const stripped = line.trim();
    if (stripped.startsWith("data:")) {
      const payload = stripped.slice("data:".length).trim();
      if (payload.startsWith("{") || payload.startsWith("[")) {
        return payload;
      }
    }
  }

  return null;
}
