/**
 * Tests for the Minsky MCP client module.
 *
 * All tests use a module-level fetch stub — never hit the live Railway endpoint.
 * Fetch is stubbed by temporarily replacing globalThis.fetch with a mock(),
 * following the pattern in src/domain/auth/token-provider.test.ts.
 *
 * @see mt#1085
 */

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import type { ReviewerConfig } from "./config";

// ---------------------------------------------------------------------------
// Config fixture
// ---------------------------------------------------------------------------

const CONFIG_WITH_MCP: ReviewerConfig = {
  appId: 1,
  privateKey: "",
  installationId: 1,
  webhookSecret: "",
  provider: "openai",
  providerApiKey: "sk-test",
  providerModel: "gpt-5",
  tier2Enabled: false,
  mcpUrl: "https://minsky-mcp-test.example.com/mcp",
  mcpToken: "test-bearer-token",
  port: 3000,
  logLevel: "info",
};

const CONFIG_NO_MCP: ReviewerConfig = {
  ...CONFIG_WITH_MCP,
  mcpUrl: undefined,
  mcpToken: undefined,
};

// ---------------------------------------------------------------------------
// Helper: build a mock Response
// ---------------------------------------------------------------------------

function mockJsonResponse(body: unknown, status = 200): Response {
  const text = JSON.stringify(body);
  return new Response(text, {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function mockSseResponse(jsonObject: unknown, status = 200): Response {
  const text = `data: ${JSON.stringify(jsonObject)}\n\n`;
  return new Response(text, {
    status,
    headers: { "Content-Type": "text/event-stream" },
  });
}

// ---------------------------------------------------------------------------
// Helper: replace globalThis.fetch with a mock for the duration of a test
// (same pattern as token-provider.test.ts)
// ---------------------------------------------------------------------------

let originalFetch: typeof fetch;
let fetchMock: ReturnType<typeof mock> | undefined;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  // Reset between tests so "no fetch called" assertions are reliable
  // regardless of test execution order.
  fetchMock = undefined;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function setFetch(impl: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>): void {
  fetchMock = mock(impl);
  // Two-step cast: Mock<...> does not extend typeof fetch (which has .preconnect etc.),
  // so we go through unknown first.
  globalThis.fetch = fetchMock as unknown as typeof fetch;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("callAuthorshipGet", () => {
  test("returns null immediately when mcpUrl is missing", async () => {
    const { callAuthorshipGet } = await import("./mcp-client");
    const result = await callAuthorshipGet("42", "pr", CONFIG_NO_MCP);
    expect(result).toBeNull();
    // fetch should never be called when config is missing — verify by checking
    // that the global fetch was never replaced.
    expect(fetchMock).toBeUndefined();
  });

  test("returns null immediately when mcpToken is missing", async () => {
    const { callAuthorshipGet } = await import("./mcp-client");
    const result = await callAuthorshipGet("42", "pr", { ...CONFIG_WITH_MCP, mcpToken: undefined });
    expect(result).toBeNull();
    expect(fetchMock).toBeUndefined();
  });

  test("returns the authorship result on a successful plain-JSON response", async () => {
    const authorshipRecord = {
      tier: 3,
      rationale: "fully agent-authored",
      policyVersion: "1.0.0",
    };

    const mcpResponse = {
      jsonrpc: "2.0",
      id: 1,
      result: {
        content: [{ type: "text", text: JSON.stringify(authorshipRecord) }],
      },
    };

    setFetch(() => Promise.resolve(mockJsonResponse(mcpResponse)));

    const { callAuthorshipGet } = await import("./mcp-client");
    const result = await callAuthorshipGet("42", "pr", CONFIG_WITH_MCP);

    expect(result).not.toBeNull();
    expect(result?.tier).toBe(3);
    expect(result?.rationale).toBe("fully agent-authored");
  });

  test("returns the authorship result on a successful SSE response", async () => {
    const authorshipRecord = { tier: 1, policyVersion: "1.0.0" };
    const mcpResponse = {
      jsonrpc: "2.0",
      id: 1,
      result: { content: [{ type: "text", text: JSON.stringify(authorshipRecord) }] },
    };

    setFetch(() => Promise.resolve(mockSseResponse(mcpResponse)));

    const { callAuthorshipGet } = await import("./mcp-client");
    const result = await callAuthorshipGet("7", "pr", CONFIG_WITH_MCP);

    expect(result?.tier).toBe(1);
  });

  test("returns null when MCP result content text is null (no authorship record)", async () => {
    const mcpResponse = {
      jsonrpc: "2.0",
      id: 1,
      result: { content: [{ type: "text", text: "null" }] },
    };

    setFetch(() => Promise.resolve(mockJsonResponse(mcpResponse)));

    const { callAuthorshipGet } = await import("./mcp-client");
    const result = await callAuthorshipGet("999", "pr", CONFIG_WITH_MCP);

    expect(result).toBeNull();
  });

  test("returns null on HTTP 500 error (drains body, no throw)", async () => {
    setFetch(() => Promise.resolve(new Response("Internal Server Error", { status: 500 })));

    const { callAuthorshipGet } = await import("./mcp-client");
    const result = await callAuthorshipGet("42", "pr", CONFIG_WITH_MCP);

    expect(result).toBeNull();
  });

  test("returns null on HTTP 401 Unauthorized (drains body)", async () => {
    setFetch(() => Promise.resolve(new Response("Unauthorized", { status: 401 })));

    const { callAuthorshipGet } = await import("./mcp-client");
    const result = await callAuthorshipGet("42", "pr", CONFIG_WITH_MCP);

    expect(result).toBeNull();
  });

  test("returns null when fetch throws (network error)", async () => {
    setFetch(() => Promise.reject(new Error("ECONNREFUSED")));

    const { callAuthorshipGet } = await import("./mcp-client");
    const result = await callAuthorshipGet("42", "pr", CONFIG_WITH_MCP);

    expect(result).toBeNull();
  });

  test("returns null on MCP-level error response", async () => {
    const mcpErrorResponse = {
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32601, message: "Method not found" },
    };

    setFetch(() => Promise.resolve(mockJsonResponse(mcpErrorResponse)));

    const { callAuthorshipGet } = await import("./mcp-client");
    const result = await callAuthorshipGet("42", "pr", CONFIG_WITH_MCP);

    expect(result).toBeNull();
  });

  test("returns null on empty result content array", async () => {
    const mcpResponse = { jsonrpc: "2.0", id: 1, result: { content: [] } };
    setFetch(() => Promise.resolve(mockJsonResponse(mcpResponse)));

    const { callAuthorshipGet } = await import("./mcp-client");
    const result = await callAuthorshipGet("42", "pr", CONFIG_WITH_MCP);

    expect(result).toBeNull();
  });

  test("sends Authorization header with bearer token", async () => {
    const mcpResponse = {
      jsonrpc: "2.0",
      id: 1,
      result: { content: [{ type: "text", text: "null" }] },
    };

    let capturedInit: RequestInit | undefined;
    setFetch((_url, init) => {
      capturedInit = init;
      return Promise.resolve(mockJsonResponse(mcpResponse));
    });

    const { callAuthorshipGet } = await import("./mcp-client");
    await callAuthorshipGet("42", "pr", CONFIG_WITH_MCP);

    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers?.["Authorization"]).toBe(`Bearer ${CONFIG_WITH_MCP.mcpToken}`);
  });

  test("sends request to the configured mcpUrl", async () => {
    const mcpResponse = {
      jsonrpc: "2.0",
      id: 1,
      result: { content: [{ type: "text", text: "null" }] },
    };

    let capturedUrl: string | undefined;
    setFetch((url, _init) => {
      capturedUrl = url as string;
      return Promise.resolve(mockJsonResponse(mcpResponse));
    });

    const { callAuthorshipGet } = await import("./mcp-client");
    await callAuthorshipGet("42", "pr", CONFIG_WITH_MCP);

    // CONFIG_WITH_MCP.mcpUrl is defined; the cast to string is safe here.
    expect(capturedUrl).toBe(CONFIG_WITH_MCP.mcpUrl as string);
  });

  test("returns the authorship result when content type is 'json'", async () => {
    const authorshipRecord = {
      tier: 2,
      rationale: "co-authored",
      policyVersion: "1.0.0",
    };

    const mcpResponse = {
      jsonrpc: "2.0",
      id: 1,
      result: {
        // MCP SDK can emit { type: "json", json: <value> } instead of text
        content: [{ type: "json", json: authorshipRecord }],
      },
    };

    setFetch(() => Promise.resolve(mockJsonResponse(mcpResponse)));

    const { callAuthorshipGet } = await import("./mcp-client");
    const result = await callAuthorshipGet("55", "commit", CONFIG_WITH_MCP);

    expect(result).not.toBeNull();
    expect(result?.tier).toBe(2);
    expect(result?.rationale).toBe("co-authored");
  });

  test("returns null when result.isError is true", async () => {
    const mcpResponse = {
      jsonrpc: "2.0",
      id: 1,
      result: {
        isError: true,
        content: [{ type: "text", text: "tool execution failed" }],
      },
    };

    setFetch(() => Promise.resolve(mockJsonResponse(mcpResponse)));

    const { callAuthorshipGet } = await import("./mcp-client");
    const result = await callAuthorshipGet("42", "pr", CONFIG_WITH_MCP);

    expect(result).toBeNull();
  });

  test("uses the LAST SSE data event when a progress event precedes the tool result", async () => {
    // Real MCP streamable-HTTP responses may emit a progress event first and the
    // actual tool result last. extractJsonFromBody must return the final payload.
    const progressEvent = { type: "progress", message: "looking up record..." };
    const toolResult = {
      jsonrpc: "2.0",
      id: 1,
      result: {
        content: [
          {
            type: "text",
            text: JSON.stringify({ tier: 2, policyVersion: "1.0.0" }),
          },
        ],
      },
    };

    const sseBody = `data: ${JSON.stringify(progressEvent)}\n\ndata: ${JSON.stringify(toolResult)}\n\n`;

    setFetch(() =>
      Promise.resolve(
        new Response(sseBody, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        })
      )
    );

    const { callAuthorshipGet } = await import("./mcp-client");
    const result = await callAuthorshipGet("77", "pr", CONFIG_WITH_MCP);

    // Should pick the tool-result event (last), not the progress event (first).
    expect(result).not.toBeNull();
    expect(result?.tier).toBe(2);
  });

  test("handles multi-chunk text content by concatenating before parse", async () => {
    // The MCP server may emit the JSON payload split across multiple text chunks.
    // callAuthorshipGet must concatenate all type:"text" entries before JSON.parse.
    const authorshipRecord = { tier: 1, rationale: "human-authored", policyVersion: "2.0.0" };
    const fullJson = JSON.stringify(authorshipRecord);
    const mid = Math.floor(fullJson.length / 2);

    const mcpResponse = {
      jsonrpc: "2.0",
      id: 1,
      result: {
        content: [
          { type: "text", text: fullJson.slice(0, mid) },
          { type: "text", text: fullJson.slice(mid) },
        ],
      },
    };

    setFetch(() => Promise.resolve(mockJsonResponse(mcpResponse)));

    const { callAuthorshipGet } = await import("./mcp-client");
    const result = await callAuthorshipGet("11", "pr", CONFIG_WITH_MCP);

    expect(result).not.toBeNull();
    expect(result?.tier).toBe(1);
    expect(result?.rationale).toBe("human-authored");
    expect(result?.policyVersion).toBe("2.0.0");
  });

  test("prefers type:'json' entry and ignores extra type:'text' chunks", async () => {
    // When a type:"json" entry is present alongside type:"text" chunks, the json
    // entry takes priority and the text chunks are ignored entirely.
    const authorshipRecord = { tier: 3, rationale: "agent-authored", policyVersion: "1.0.0" };

    const mcpResponse = {
      jsonrpc: "2.0",
      id: 1,
      result: {
        content: [
          { type: "json", json: authorshipRecord },
          // These text chunks contain a different (wrong) value — they must be ignored.
          { type: "text", text: JSON.stringify({ tier: 9, rationale: "should be ignored" }) },
        ],
      },
    };

    setFetch(() => Promise.resolve(mockJsonResponse(mcpResponse)));

    const { callAuthorshipGet } = await import("./mcp-client");
    const result = await callAuthorshipGet("22", "commit", CONFIG_WITH_MCP);

    expect(result).not.toBeNull();
    expect(result?.tier).toBe(3);
    expect(result?.rationale).toBe("agent-authored");
  });
});

describe("callTasksSpecGet", () => {
  const makeEnvelope = (content: string) =>
    JSON.stringify({ success: true, taskId: "mt#1187", content });

  test("returns disabled immediately when mcpUrl is missing", async () => {
    const { callTasksSpecGet } = await import("./mcp-client");
    const result = await callTasksSpecGet("mt#1187", CONFIG_NO_MCP);
    expect(result.kind).toBe("disabled");
    expect(fetchMock).toBeUndefined();
  });

  test("returns disabled immediately when mcpToken is missing", async () => {
    const { callTasksSpecGet } = await import("./mcp-client");
    const result = await callTasksSpecGet("mt#1187", { ...CONFIG_WITH_MCP, mcpToken: undefined });
    expect(result.kind).toBe("disabled");
    expect(fetchMock).toBeUndefined();
  });

  test("returns found with spec content on a successful plain-JSON envelope", async () => {
    const mcpResponse = {
      jsonrpc: "2.0",
      id: 1,
      result: {
        content: [{ type: "text", text: makeEnvelope("## Summary\n\nreal spec") }],
      },
    };
    setFetch(() => Promise.resolve(mockJsonResponse(mcpResponse)));

    const { callTasksSpecGet } = await import("./mcp-client");
    const result = await callTasksSpecGet("mt#1187", CONFIG_WITH_MCP);

    expect(result.kind).toBe("found");
    if (result.kind === "found") {
      expect(result.content).toBe("## Summary\n\nreal spec");
    }
  });

  test("returns found on a successful SSE envelope", async () => {
    const mcpResponse = {
      jsonrpc: "2.0",
      id: 1,
      result: { content: [{ type: "text", text: makeEnvelope("## SSE spec") }] },
    };
    setFetch(() => Promise.resolve(mockSseResponse(mcpResponse)));

    const { callTasksSpecGet } = await import("./mcp-client");
    const result = await callTasksSpecGet("mt#1187", CONFIG_WITH_MCP);
    expect(result.kind).toBe("found");
    if (result.kind === "found") expect(result.content).toContain("SSE spec");
  });

  test("accepts a type:'json' content entry (pre-parsed envelope)", async () => {
    const mcpResponse = {
      jsonrpc: "2.0",
      id: 1,
      result: {
        content: [
          {
            type: "json",
            json: { success: true, taskId: "mt#1187", content: "## pre-parsed" },
          },
        ],
      },
    };
    setFetch(() => Promise.resolve(mockJsonResponse(mcpResponse)));

    const { callTasksSpecGet } = await import("./mcp-client");
    const result = await callTasksSpecGet("mt#1187", CONFIG_WITH_MCP);
    expect(result.kind).toBe("found");
    if (result.kind === "found") expect(result.content).toBe("## pre-parsed");
  });

  test("concatenates multi-chunk text content before envelope parse", async () => {
    const envelope = makeEnvelope("## multi-chunk spec");
    const mid = Math.floor(envelope.length / 2);
    const mcpResponse = {
      jsonrpc: "2.0",
      id: 1,
      result: {
        content: [
          { type: "text", text: envelope.slice(0, mid) },
          { type: "text", text: envelope.slice(mid) },
        ],
      },
    };
    setFetch(() => Promise.resolve(mockJsonResponse(mcpResponse)));

    const { callTasksSpecGet } = await import("./mcp-client");
    const result = await callTasksSpecGet("mt#1187", CONFIG_WITH_MCP);
    expect(result.kind).toBe("found");
    if (result.kind === "found") expect(result.content).toBe("## multi-chunk spec");
  });

  test("falls back to treating plain markdown as the spec when inner text is not JSON", async () => {
    const mcpResponse = {
      jsonrpc: "2.0",
      id: 1,
      result: { content: [{ type: "text", text: "## Plain markdown body" }] },
    };
    setFetch(() => Promise.resolve(mockJsonResponse(mcpResponse)));

    const { callTasksSpecGet } = await import("./mcp-client");
    const result = await callTasksSpecGet("mt#1187", CONFIG_WITH_MCP);
    expect(result.kind).toBe("found");
    if (result.kind === "found") expect(result.content).toContain("Plain markdown body");
  });

  test("returns not-found when result content is empty", async () => {
    const mcpResponse = {
      jsonrpc: "2.0",
      id: 1,
      result: { content: [] },
    };
    setFetch(() => Promise.resolve(mockJsonResponse(mcpResponse)));

    const { callTasksSpecGet } = await import("./mcp-client");
    const result = await callTasksSpecGet("mt#1187", CONFIG_WITH_MCP);
    expect(result.kind).toBe("not-found");
  });

  test("returns not-found when envelope has success:true but no content field", async () => {
    const mcpResponse = {
      jsonrpc: "2.0",
      id: 1,
      result: {
        content: [{ type: "text", text: JSON.stringify({ success: true, taskId: "mt#42" }) }],
      },
    };
    setFetch(() => Promise.resolve(mockJsonResponse(mcpResponse)));

    const { callTasksSpecGet } = await import("./mcp-client");
    const result = await callTasksSpecGet("mt#42", CONFIG_WITH_MCP);
    expect(result.kind).toBe("not-found");
  });

  test("returns error with tool message on success:false envelope", async () => {
    const mcpResponse = {
      jsonrpc: "2.0",
      id: 1,
      result: {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: false,
              error: "Developer setup incomplete. Run 'minsky setup' first.",
            }),
          },
        ],
      },
    };
    setFetch(() => Promise.resolve(mockJsonResponse(mcpResponse)));

    const { callTasksSpecGet } = await import("./mcp-client");
    const result = await callTasksSpecGet("mt#1187", CONFIG_WITH_MCP);
    expect(result.kind).toBe("error");
    if (result.kind === "error") expect(result.message).toContain("Developer setup incomplete");
  });

  test("returns error with fallback message on success:false without error field", async () => {
    const mcpResponse = {
      jsonrpc: "2.0",
      id: 1,
      result: {
        content: [{ type: "text", text: JSON.stringify({ success: false }) }],
      },
    };
    setFetch(() => Promise.resolve(mockJsonResponse(mcpResponse)));

    const { callTasksSpecGet } = await import("./mcp-client");
    const result = await callTasksSpecGet("mt#1187", CONFIG_WITH_MCP);
    expect(result.kind).toBe("error");
    if (result.kind === "error") expect(result.message).toContain("success:false");
  });

  test("returns error on non-200 HTTP responses", async () => {
    setFetch(() =>
      Promise.resolve(
        new Response("server went home", {
          status: 503,
          statusText: "Service Unavailable",
        })
      )
    );

    const { callTasksSpecGet } = await import("./mcp-client");
    const result = await callTasksSpecGet("mt#1187", CONFIG_WITH_MCP);
    expect(result.kind).toBe("error");
    if (result.kind === "error") expect(result.message).toContain("503");
  });

  test("returns error on JSON-RPC error envelopes", async () => {
    const mcpResponse = {
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32000, message: "Bad Request: Server not initialized" },
    };
    setFetch(() => Promise.resolve(mockJsonResponse(mcpResponse)));

    const { callTasksSpecGet } = await import("./mcp-client");
    const result = await callTasksSpecGet("mt#1187", CONFIG_WITH_MCP);
    expect(result.kind).toBe("error");
    if (result.kind === "error") expect(result.message).toContain("Server not initialized");
  });

  test("returns error when fetch itself throws", async () => {
    setFetch(() => Promise.reject(new Error("ECONNREFUSED")));

    const { callTasksSpecGet } = await import("./mcp-client");
    const result = await callTasksSpecGet("mt#1187", CONFIG_WITH_MCP);
    expect(result.kind).toBe("error");
    if (result.kind === "error") expect(result.message).toContain("fetch failed");
  });
});
