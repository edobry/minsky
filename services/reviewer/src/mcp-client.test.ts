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
let fetchMock: ReturnType<typeof mock>;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function setFetch(impl: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>): void {
  fetchMock = mock(impl);
  globalThis.fetch = fetchMock as typeof fetch;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("callProvenanceGet", () => {
  test("returns null immediately when mcpUrl is missing", async () => {
    const { callProvenanceGet } = await import("./mcp-client");
    const result = await callProvenanceGet("42", "pr", CONFIG_NO_MCP);
    expect(result).toBeNull();
    // fetch should never be called when config is missing — verify by checking
    // that the global fetch was never replaced.
    expect(fetchMock).toBeUndefined();
  });

  test("returns null immediately when mcpToken is missing", async () => {
    const { callProvenanceGet } = await import("./mcp-client");
    const result = await callProvenanceGet("42", "pr", { ...CONFIG_WITH_MCP, mcpToken: undefined });
    expect(result).toBeNull();
    expect(fetchMock).toBeUndefined();
  });

  test("returns the provenance record on a successful plain-JSON response", async () => {
    const provenanceRecord = {
      artifactId: "42",
      artifactType: "pr",
      authorshipTier: 3,
      taskId: "mt#1085",
    };

    const mcpResponse = {
      jsonrpc: "2.0",
      id: 1,
      result: {
        content: [{ type: "text", text: JSON.stringify(provenanceRecord) }],
      },
    };

    setFetch(() => Promise.resolve(mockJsonResponse(mcpResponse)));

    const { callProvenanceGet } = await import("./mcp-client");
    const result = await callProvenanceGet("42", "pr", CONFIG_WITH_MCP);

    expect(result).not.toBeNull();
    expect(result?.authorshipTier).toBe(3);
    expect(result?.artifactId).toBe("42");
  });

  test("returns the provenance record on a successful SSE response", async () => {
    const provenanceRecord = { artifactId: "7", artifactType: "pr", authorshipTier: 1 };
    const mcpResponse = {
      jsonrpc: "2.0",
      id: 1,
      result: { content: [{ type: "text", text: JSON.stringify(provenanceRecord) }] },
    };

    setFetch(() => Promise.resolve(mockSseResponse(mcpResponse)));

    const { callProvenanceGet } = await import("./mcp-client");
    const result = await callProvenanceGet("7", "pr", CONFIG_WITH_MCP);

    expect(result?.authorshipTier).toBe(1);
  });

  test("returns null when MCP result content text is null (no provenance record)", async () => {
    const mcpResponse = {
      jsonrpc: "2.0",
      id: 1,
      result: { content: [{ type: "text", text: "null" }] },
    };

    setFetch(() => Promise.resolve(mockJsonResponse(mcpResponse)));

    const { callProvenanceGet } = await import("./mcp-client");
    const result = await callProvenanceGet("999", "pr", CONFIG_WITH_MCP);

    expect(result).toBeNull();
  });

  test("returns null on HTTP 500 error (drains body, no throw)", async () => {
    setFetch(() => Promise.resolve(new Response("Internal Server Error", { status: 500 })));

    const { callProvenanceGet } = await import("./mcp-client");
    const result = await callProvenanceGet("42", "pr", CONFIG_WITH_MCP);

    expect(result).toBeNull();
  });

  test("returns null on HTTP 401 Unauthorized (drains body)", async () => {
    setFetch(() => Promise.resolve(new Response("Unauthorized", { status: 401 })));

    const { callProvenanceGet } = await import("./mcp-client");
    const result = await callProvenanceGet("42", "pr", CONFIG_WITH_MCP);

    expect(result).toBeNull();
  });

  test("returns null when fetch throws (network error)", async () => {
    setFetch(() => Promise.reject(new Error("ECONNREFUSED")));

    const { callProvenanceGet } = await import("./mcp-client");
    const result = await callProvenanceGet("42", "pr", CONFIG_WITH_MCP);

    expect(result).toBeNull();
  });

  test("returns null on MCP-level error response", async () => {
    const mcpErrorResponse = {
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32601, message: "Method not found" },
    };

    setFetch(() => Promise.resolve(mockJsonResponse(mcpErrorResponse)));

    const { callProvenanceGet } = await import("./mcp-client");
    const result = await callProvenanceGet("42", "pr", CONFIG_WITH_MCP);

    expect(result).toBeNull();
  });

  test("returns null on empty result content array", async () => {
    const mcpResponse = { jsonrpc: "2.0", id: 1, result: { content: [] } };
    setFetch(() => Promise.resolve(mockJsonResponse(mcpResponse)));

    const { callProvenanceGet } = await import("./mcp-client");
    const result = await callProvenanceGet("42", "pr", CONFIG_WITH_MCP);

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

    const { callProvenanceGet } = await import("./mcp-client");
    await callProvenanceGet("42", "pr", CONFIG_WITH_MCP);

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

    const { callProvenanceGet } = await import("./mcp-client");
    await callProvenanceGet("42", "pr", CONFIG_WITH_MCP);

    expect(capturedUrl).toBe(CONFIG_WITH_MCP.mcpUrl);
  });
});
