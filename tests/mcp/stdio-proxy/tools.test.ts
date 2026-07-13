/**
 * Unit tests for src/mcp/stdio-proxy/tools.ts
 *
 * Tests cover:
 *   - augmentToolsListResponse: appends tool, is idempotent, ignores non-matching messages
 *   - augmentToolsListResponse: collision detection — inner server exposes same name
 *   - isProxyRestartRequest: matches the correct tool-call pattern
 *   - makeToolCallResponse: returns well-formed JSON-RPC response
 *   - PROXY_RESTART_TOOL_ENTRY: schema contract
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
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

  // ---------------------------------------------------------------------------
  // Idempotency: already-augmented messages
  // ---------------------------------------------------------------------------

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

  // ---------------------------------------------------------------------------
  // Collision detection: inner server already exposes __proxy_restart_server
  // (BLOCKING 3, PR #1039 R1)
  // ---------------------------------------------------------------------------

  describe("collision handling", () => {
    // Capture stderr output during collision tests.
    let stderrOutput: string;
    const originalStderrWrite = process.stderr.write.bind(process.stderr);

    beforeEach(() => {
      stderrOutput = "";
      // Patch process.stderr.write to capture output.
      process.stderr.write = (chunk: unknown, ..._args: unknown[]): boolean => {
        stderrOutput += String(chunk);
        return true;
      };
    });

    afterEach(() => {
      // Restore original stderr.
      process.stderr.write = originalStderrWrite;
    });

    it("returns the original message unchanged when inner server exposes __proxy_restart_server", () => {
      // Inner server's own version of the tool — a different object than PROXY_RESTART_TOOL_ENTRY.
      const innerServerTool = {
        name: PROXY_RESTART_TOOL_NAME,
        description: "inner server's own version",
      };
      const msg = makeToolsListResponse([{ name: "normalTool" }, innerServerTool]);
      const result = augmentToolsListResponse(msg);

      // Must return the SAME reference — not augmented.
      expect(result).toBe(msg);
    });

    it("does NOT append a duplicate __proxy_restart_server on collision", () => {
      const innerServerTool = {
        name: PROXY_RESTART_TOOL_NAME,
        description: "inner server's own version",
      };
      const msg = makeToolsListResponse([innerServerTool]);
      augmentToolsListResponse(msg);

      const tools = (msg.result as { tools: Array<{ name: string }> }).tools;
      const restartCount = tools.filter((t) => t.name === PROXY_RESTART_TOOL_NAME).length;
      expect(restartCount).toBe(1);
    });

    it("writes a warning to stderr when collision is detected", () => {
      // The inner server exposes a different object with the same name — collision.
      const innerServerTool = {
        name: PROXY_RESTART_TOOL_NAME,
        description: "inner server's own version — not the proxy entry",
      };
      const msg = makeToolsListResponse([innerServerTool]);
      augmentToolsListResponse(msg);

      // A warning must have been written to stderr naming the tool and describing the collision.
      expect(stderrOutput).toContain(PROXY_RESTART_TOOL_NAME);
      // The warning message uses "collides" — accept either "collide" or "collision".
      expect(stderrOutput.toLowerCase()).toMatch(/collis|collid/);
    });

    it("does NOT write a stderr warning for the idempotent already-augmented case", () => {
      // First call: augments the message — adds PROXY_RESTART_TOOL_ENTRY (the same object).
      const msg = makeToolsListResponse([{ name: "foo" }]);
      const augmented = augmentToolsListResponse(msg);

      // Reset stderr capture before the second call.
      stderrOutput = "";

      // Second call: the tool is already present (same object as PROXY_RESTART_TOOL_ENTRY).
      augmentToolsListResponse(augmented);

      // No warning should be emitted — this is the idempotent case, not a collision.
      expect(stderrOutput).toBe("");
    });
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
