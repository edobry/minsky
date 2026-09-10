/**
 * One MCP session over Streamable HTTP, for the monitor's secondary alert
 * channel (mt#4012).
 *
 * ## Why this is its own module
 *
 * It was a closure inside `scripts/post-deploy-health-monitor.ts`, which calls
 * `main()` at module scope and therefore cannot be imported by anything — the
 * same constraint that put the monitor's decisions in `monitor-ask-alert.ts`
 * and its P0 handling in `monitor-p0-resolution.ts`.
 *
 * That mattered more here than anywhere else, because this is the one piece of
 * the channel whose correctness is a claim about the WIRE, and the wire is
 * exactly what no unit test can settle. Unreachable code cannot be exercised
 * against a live server, so for the whole life of this channel there was no way
 * to run it except by waiting for a production outage to run it for you — and
 * when one did, it failed on every tick for at least eight hours while the
 * monitor's own log called the failure `non-fatal` (mt#4012 `## Diagnosis`).
 *
 * Extracted so `scripts/verify-monitor-ask-channel.ts` drives the SAME code
 * path against a real server, rather than copying its shape and verifying a
 * duplicate.
 *
 * ## What stays here vs. in `monitor-ask-alert.ts`
 *
 * This module owns the session and the JSON-RPC envelope — the IO. Every
 * decision and every response reading stays in `monitor-ask-alert.ts`, pure and
 * tested. The one non-obvious rule lives on the boundary between them and is
 * documented at the `content-type` branch below.
 *
 * @see mt#2782 — the channel
 * @see mt#4012 — this extraction and the SSE fix
 */

import { parseSseEventData } from "../../../../src/mcp/shim/sse";
import {
  describeResponseBody,
  selectJsonRpcResponse,
  type McpToolCaller,
} from "./monitor-ask-alert";

/** Production MCP endpoint the monitor alerts through. */
export const MINSKY_MCP_URL = "https://minsky-mcp-production.up.railway.app/mcp";

/** Bound on the whole session — init plus every tool call it makes. */
export const MCP_TIMEOUT_MS = 15_000;

export interface McpSessionOptions {
  authToken: string;
  /** Defaults to the production endpoint; overridden to probe a local server. */
  url?: string;
  timeoutMs?: number;
  /** Reported to the server as `clientInfo.name`. */
  clientName?: string;
}

/**
 * Open an MCP session, run `fn` against it, and always clear the timeout.
 *
 * Request ids start at 2 because `initialize` uses 1.
 */
export async function withMcpSession<T>(
  options: McpSessionOptions,
  fn: (callTool: McpToolCaller) => Promise<T>
): Promise<T> {
  const url = options.url ?? MINSKY_MCP_URL;
  const clientName = options.clientName ?? "post-deploy-health-monitor";
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), options.timeoutMs ?? MCP_TIMEOUT_MS);

  const headers = (extra: Record<string, string> = {}): Record<string, string> => ({
    Authorization: `Bearer ${options.authToken}`,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    ...extra,
  });

  try {
    const initRes = await fetch(url, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: clientName, version: "1.0" },
        },
      }),
      signal: controller.signal,
    });

    if (!initRes.ok) {
      throw new Error(`MCP init HTTP ${initRes.status}`);
    }

    // Read from the HEADER, and note what that implies: `initialize` never
    // parses its own body. That is why this channel's defect presented as a
    // failure at the first TOOL CALL rather than at the handshake — the init
    // response is SSE-framed too, and went unnoticed because nothing looked.
    const sessionId = initRes.headers.get("mcp-session-id");
    if (!sessionId) {
      throw new Error("MCP init response missing mcp-session-id header");
    }

    let nextRequestId = 2;

    const callTool: McpToolCaller = async (name, args) => {
      const id = nextRequestId++;
      const res = await fetch(url, {
        method: "POST",
        headers: headers({ "mcp-session-id": sessionId }),
        body: JSON.stringify({
          jsonrpc: "2.0",
          id,
          method: "tools/call",
          params: { name, arguments: args },
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        // Still checked — a transport failure is a real failure. It is just no
        // longer treated as the ONLY way this can fail.
        throw new Error(`MCP ${name} HTTP ${res.status}`);
      }

      // mt#4012: read the body according to what the transport ACTUALLY sends.
      //
      // This was `await res.json()`, and it threw `SyntaxError: Failed to parse
      // JSON` on every call this channel ever made. The MCP Streamable-HTTP
      // transport answers `tools/call` with `Content-Type: text/event-stream` —
      // `enableJsonResponse` defaults to false and `src/mcp/server.ts` does not
      // set it — so the body is `event: message\ndata: {...}`.
      //
      // Nothing upstream could catch it: the response is a genuine HTTP 200, so
      // the `!res.ok` guard above never fires.
      //
      // Deliberately untyped at this boundary: the parsers in
      // `monitor-ask-alert.ts` take `unknown` and do the narrowing, which is
      // where the shape assertions are tested. Typing it here would be a claim
      // about the wire format that nothing checks.
      const contentType = res.headers.get("content-type");
      const bodyText = await res.text();
      try {
        if (contentType?.includes("text/event-stream")) {
          return selectJsonRpcResponse(parseSseEventData(bodyText), id);
        }
        return JSON.parse(bodyText);
      } catch (err) {
        // Name the body's SHAPE, not just the exception. The original defect
        // discarded the body before anything could look at it, so 43 minutes of
        // production failure yielded one repeated exception name and no
        // diagnosis. `describeResponseBody` emits no payload content — this
        // line lands in a public Actions log.
        throw new Error(
          `MCP ${name}: could not read response body ` +
            `(${describeResponseBody(contentType, bodyText)}): ${err}`
        );
      }
    };

    return await fn(callTool);
  } finally {
    clearTimeout(timeoutId);
  }
}
