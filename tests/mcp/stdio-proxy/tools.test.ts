/**
 * Unit tests for src/mcp/stdio-proxy/tools.ts
 *
 * Tests cover:
 *   - augmentToolsListResponse: appends tool, is idempotent, ignores non-matching messages
 *   - isProxyRestartRequest: matches the correct tool-call pattern
 *   - makeToolCallResponse: returns well-formed JSON-RPC response
 *   - PROXY_RESTART_TOOL_ENTRY: schema contract
 */

import { describe, it, expect } from "bun:test";
import {
  PROXY_RESTART_TOOL_NAME,
  PROXY_RESTART_TOOL_ENTRY,
  augmentToolsListResponse,
  isProxyRestartRequest,
  makeToolCallResponse,
  type JsonRpcMessage,
} from "../../../src/mcp/stdio-proxy/tools.ts";

// ---------------------------------------------------------------------------
// Helper builders
// ---------------------------------------------------------------------------

function makeToolsListResponse(tools: Array<{ name: string }>): JsonRpcMessage {
  return {
    jsonrpc: "2.0",
    id: 1,
    result: {
      tools,
    },
  };
}

function makeToolsCallRequest(name: string, id: string | number = 42): JsonRpcMessage {
  return {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name },
  };
}

// ---------------------------------------------------------------------------
// augmentToolsListResponse
// ---------------------------------------------------------------------------

describe("augmentToolsListResponse", () => {
  it("appends __proxy_restart_server to a tools/list response", () => {
    const msg = makeToolsListResponse([{ name: "existingTool" }]);
    const augmented = augmentToolsListResponse(msg);

    const result = augmented.result as { tools: Array<{ name: string }> };
    const names = result.tools.map((t) => t.name);
    expect(names).toContain(PROXY_RESTART_TOOL_NAME);
    expect(names).toContain("existingTool");
  });

  it("returns a different object reference for matching tools/list responses", () => {
    const msg = makeToolsListResponse([{ name: "someTool" }]);
    const augmented = augmentToolsListResponse(msg);
    // Should NOT be the same reference (new object created)
    expect(augmented).not.toBe(msg);
  });

  it("does NOT modify non-tools/list messages (returns same reference)", () => {
    const notAToolsListResponse: JsonRpcMessage = {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "someOtherTool" },
    };
    const result = augmentToolsListResponse(notAToolsListResponse);
    expect(result).toBe(notAToolsListResponse);
  });

  it("does NOT modify a response that has an error field", () => {
    const errorResponse: JsonRpcMessage = {
      jsonrpc: "2.0",
      id: 3,
      result: { tools: [{ name: "whatever" }] },
      error: { code: -32000, message: "something failed" },
    };
    const result = augmentToolsListResponse(errorResponse);
    expect(result).toBe(errorResponse);
  });

  it("does NOT modify a response with no result", () => {
    const notificationMsg: JsonRpcMessage = {
      jsonrpc: "2.0",
      method: "notifications/progress",
      params: { progressToken: 1, progress: 50 },
    };
    const result = augmentToolsListResponse(notificationMsg);
    expect(result).toBe(notificationMsg);
  });

  it("does NOT append twice if __proxy_restart_server is already in the list (idempotent)", () => {
    // When the tools list already contains __proxy_restart_server, the function
    // returns the original message reference unchanged (isToolsListResponse returns
    // false early, before the collision guard code is reached).
    const msgWithTool = makeToolsListResponse([{ name: PROXY_RESTART_TOOL_NAME }]);
    const result = augmentToolsListResponse(msgWithTool);
    // Returns original reference unchanged.
    expect(result).toBe(msgWithTool);
    // The tools array is not modified.
    const tools = (result.result as { tools: Array<{ name: string }> }).tools;
    const restartCount = tools.filter((t) => t.name === PROXY_RESTART_TOOL_NAME).length;
    expect(restartCount).toBe(1);
  });

  it("does not append a second copy if called twice on the already-augmented output", () => {
    const msg = makeToolsListResponse([{ name: "alpha" }]);
    const once = augmentToolsListResponse(msg);
    const twice = augmentToolsListResponse(once);
    // Second call should return the same reference (already contains the tool).
    expect(twice).toBe(once);
    const tools = (twice.result as { tools: Array<{ name: string }> }).tools;
    const restartCount = tools.filter((t) => t.name === PROXY_RESTART_TOOL_NAME).length;
    expect(restartCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// isProxyRestartRequest
// ---------------------------------------------------------------------------

describe("isProxyRestartRequest", () => {
  it("returns true for a valid tools/call request for __proxy_restart_server", () => {
    const msg = makeToolsCallRequest(PROXY_RESTART_TOOL_NAME);
    expect(isProxyRestartRequest(msg)).toBe(true);
  });

  it("returns false for a tools/call request for a different tool", () => {
    const msg = makeToolsCallRequest("some_other_tool");
    expect(isProxyRestartRequest(msg)).toBe(false);
  });

  it("returns false for a non-tools/call method", () => {
    const msg: JsonRpcMessage = {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {},
    };
    expect(isProxyRestartRequest(msg)).toBe(false);
  });

  it("returns false for a JSON-RPC response (no method)", () => {
    const msg: JsonRpcMessage = {
      jsonrpc: "2.0",
      id: 1,
      result: { tools: [] },
    };
    expect(isProxyRestartRequest(msg)).toBe(false);
  });

  it("returns false for a notification (no params name)", () => {
    const msg: JsonRpcMessage = {
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    };
    expect(isProxyRestartRequest(msg)).toBe(false);
  });

  it("returns false for a tools/call with missing params", () => {
    const msg: JsonRpcMessage = {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
    };
    expect(isProxyRestartRequest(msg)).toBe(false);
  });

  it("returns false for a tools/call with a null name", () => {
    const msg: JsonRpcMessage = {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: null as unknown as string },
    };
    expect(isProxyRestartRequest(msg)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// makeToolCallResponse
// ---------------------------------------------------------------------------

describe("makeToolCallResponse", () => {
  it("returns a well-formed JSON-RPC response with the request id", () => {
    const request: JsonRpcMessage = { jsonrpc: "2.0", id: 99, method: "tools/call" };
    const response = makeToolCallResponse(request, "server restarted");
    expect(response.jsonrpc).toBe("2.0");
    expect(response.id).toBe(99);
    expect(response.result).toBeDefined();
  });

  it("includes the provided text in the content array", () => {
    const request: JsonRpcMessage = { jsonrpc: "2.0", id: "abc", method: "tools/call" };
    const response = makeToolCallResponse(request, "my text message");
    const content = (response.result as { content: Array<{ type: string; text: string }> }).content;
    expect(Array.isArray(content)).toBe(true);
    const first = content[0];
    expect(first?.type).toBe("text");
    expect(first?.text).toBe("my text message");
  });

  it("uses null id when request has no id", () => {
    const request: JsonRpcMessage = { jsonrpc: "2.0", method: "tools/call" };
    const response = makeToolCallResponse(request, "text");
    expect(response.id).toBeNull();
  });

  it("preserves string ids", () => {
    const request: JsonRpcMessage = { jsonrpc: "2.0", id: "req-xyz", method: "tools/call" };
    const response = makeToolCallResponse(request, "ok");
    expect(response.id).toBe("req-xyz");
  });
});

// ---------------------------------------------------------------------------
// PROXY_RESTART_TOOL_ENTRY schema contract
// ---------------------------------------------------------------------------

describe("PROXY_RESTART_TOOL_ENTRY", () => {
  it("has the canonical name", () => {
    expect(PROXY_RESTART_TOOL_ENTRY.name).toBe(PROXY_RESTART_TOOL_NAME);
    expect(PROXY_RESTART_TOOL_ENTRY.name).toBe("__proxy_restart_server");
  });

  it("has a description", () => {
    expect(typeof PROXY_RESTART_TOOL_ENTRY.description).toBe("string");
    expect((PROXY_RESTART_TOOL_ENTRY.description ?? "").length).toBeGreaterThan(0);
  });

  it("has inputSchema with type=object, empty properties, no additionalProperties", () => {
    const schema = PROXY_RESTART_TOOL_ENTRY.inputSchema;
    expect(schema).toBeDefined();
    if (schema === undefined) throw new Error("schema is undefined");
    expect(schema["type"]).toBe("object");
    expect(schema["properties"]).toEqual({});
    expect(schema["additionalProperties"]).toBe(false);
  });
});
