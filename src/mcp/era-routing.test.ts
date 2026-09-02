import { describe, expect, test } from "bun:test";
import type { NodeIncomingMessageLike } from "@modelcontextprotocol/node";
import { isModernEraRequest } from "./era-routing";

const CONTENT_TYPE_HEADER = "content-type";
const JSON_CONTENT_TYPE = "application/json";
const PROTOCOL_VERSION_HEADER = "mcp-protocol-version";
const MODERN_REVISION = "2026-07-28";
const LEGACY_REVISION = "2025-11-25";

/**
 * Minimal `NodeIncomingMessageLike` (mt#4608).
 *
 * The parsed body is handed to `isModernEraRequest` explicitly, exactly as
 * Express does once `express.json()` has run, so the stream is never consumed —
 * the async iterator exists to satisfy the interface, not to serve data.
 */
function makeRequest(
  method: string,
  headers: Record<string, string> = {}
): NodeIncomingMessageLike {
  return {
    method,
    url: "/mcp",
    headers: { [CONTENT_TYPE_HEADER]: JSON_CONTENT_TYPE, ...headers },
    async *[Symbol.asyncIterator]() {
      // intentionally empty: callers always pass parsedBody
    },
  };
}

const INITIALIZE_2025 = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: LEGACY_REVISION,
    capabilities: {},
    clientInfo: { name: "era-routing-test", version: "1.0.0" },
  },
};

const TOOLS_LIST_2026 = {
  jsonrpc: "2.0",
  id: 2,
  method: "tools/list",
  params: {
    _meta: { "io.modelcontextprotocol/protocolVersion": MODERN_REVISION },
  },
};

describe("isModernEraRequest (mt#4608)", () => {
  test("a 2025-era initialize POST is NOT modern — it stays on the sessionful wiring", async () => {
    expect(await isModernEraRequest(makeRequest("POST"), INITIALIZE_2025)).toBe(false);
  });

  test("a 2026-07-28 POST IS modern — it routes to createMcpHandler", async () => {
    const req = makeRequest("POST", { [PROTOCOL_VERSION_HEADER]: MODERN_REVISION });

    expect(await isModernEraRequest(req, TOOLS_LIST_2026)).toBe(true);
  });

  test("a POST with no parsed body is NOT modern — the vendor short-circuits it to legacy", async () => {
    // `classifyEntryRequest` returns `step: "no-json-body"` before any other
    // rule runs, so a malformed or bodyless POST reaches the existing wiring
    // rather than a handler with no session semantics to answer it.
    expect(await isModernEraRequest(makeRequest("POST"), undefined)).toBe(false);
  });

  test("a 2025-era GET (the SSE stream) is NOT modern", async () => {
    const req = makeRequest("GET", {
      "mcp-session-id": "d3b07384-d9a0-4f1e-9c9f-1f0b8a2b7c11",
      [PROTOCOL_VERSION_HEADER]: LEGACY_REVISION,
    });

    expect(await isModernEraRequest(req, undefined)).toBe(false);
  });

  test("the BODY's `_meta` envelope decides, not the header — same body, no header, still modern", async () => {
    // This assertion was written the other way round first and failed, which is
    // how the rule got established rather than assumed. `classifyInboundRequest`
    // routes a POST on its BODY: `modernOnlyStrictRejection` names the legacy
    // reasons `initialize` and `no-claim` — "the request did not name a protocol
    // version" — so it is the `_meta` envelope that claims the era. The
    // protocol-version header is read, but it is not what makes a request modern.
    //
    // Consequence for the dual-path split: an existing 2025 client cannot be
    // routed modern by accident, because it never emits that `_meta` key.
    expect(await isModernEraRequest(makeRequest("POST"), TOOLS_LIST_2026)).toBe(true);
  });

  test("a non-POST is legacy even carrying a modern header AND envelope", async () => {
    // `classifyInboundRequest` returns `{ kind: "legacy", reason: "http-method" }`
    // for any non-POST before it looks at the body at all. This is the guarantee
    // the 2025 SSE stream rests on: no combination of headers or body can pull a
    // GET onto the modern handler, which has no session semantics to serve it.
    const req = makeRequest("GET", { [PROTOCOL_VERSION_HEADER]: MODERN_REVISION });

    expect(await isModernEraRequest(req, TOOLS_LIST_2026)).toBe(false);
  });
});
