/**
 * Tests for the Minsky MCP client module.
 *
 * Two-phase flow under test:
 *   1. POST initialize (no session id, captures Mcp-Session-Id from response header)
 *   2. POST notifications/initialized (best-effort, ignored on failure)
 *   3. POST tools/call (with the captured Mcp-Session-Id header)
 *
 * The fetch mock is keyed on request body's `method` field so each phase
 * returns the correct response shape. `resetMcpClientSessions()` runs in
 * beforeEach so module-scope state doesn't leak across tests.
 *
 * @see mt#1085, mt#1187, mt#1821 (initialize handshake fix)
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
  modelTimeoutMs: 120_000,
  githubTimeoutMs: 30_000,
};

const CONFIG_NO_MCP: ReviewerConfig = {
  ...CONFIG_WITH_MCP,
  mcpUrl: undefined,
  mcpToken: undefined,
};

const TEST_SESSION_ID = "test-session-abc123";

// ---------------------------------------------------------------------------
// Helpers: build mock Responses for each phase
// ---------------------------------------------------------------------------

function mockJsonResponse(
  body: unknown,
  status = 200,
  extraHeaders: Record<string, string> = {}
): Response {
  const text = JSON.stringify(body);
  return new Response(text, {
    status,
    headers: { "Content-Type": "application/json", ...extraHeaders },
  });
}

function mockSseResponse(
  jsonObject: unknown,
  status = 200,
  extraHeaders: Record<string, string> = {}
): Response {
  const text = `data: ${JSON.stringify(jsonObject)}\n\n`;
  return new Response(text, {
    status,
    headers: { "Content-Type": "text/event-stream", ...extraHeaders },
  });
}

/** Standard initialize response — 200 with Mcp-Session-Id header. */
function mockInitializeResponse(sessionId = TEST_SESSION_ID): Response {
  return mockJsonResponse(
    {
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        serverInfo: { name: "minsky-mcp", version: "1.0.0" },
      },
    },
    200,
    { "Mcp-Session-Id": sessionId }
  );
}

/** Standard notifications/initialized response — 202 with empty body. */
function mockNotifResponse(): Response {
  return new Response(null, { status: 202 });
}

/**
 * Parse the request body to determine which phase a fetch call is in.
 *
 * Returns one of: "initialize", "notifications/initialized", "tools/call", or
 * the literal method string for unknown phases.
 */
function parseRequestPhase(init: RequestInit | undefined): string {
  if (!init?.body) return "unknown";
  const bodyText = typeof init.body === "string" ? init.body : "";
  try {
    const parsed = JSON.parse(bodyText) as { method?: string };
    return parsed.method ?? "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Compose a fetch mock that handles all three phases (init, notif, tools/call).
 * The toolsCallResponseFactory builds the response for the tools/call phase.
 */
function setupHandshakeFetch(
  toolsCallResponseFactory: (
    init: RequestInit | undefined,
    callIndex: number
  ) => Response | Promise<Response>,
  options: {
    sessionId?: string;
    initResponse?: () => Response;
    notifResponse?: () => Response;
    capture?: { initInits: RequestInit[]; toolCalls: Array<{ url: string; init?: RequestInit }> };
  } = {}
): ReturnType<typeof mock> {
  const initResponseFactory =
    options.initResponse ?? (() => mockInitializeResponse(options.sessionId));
  const notifResponseFactory = options.notifResponse ?? mockNotifResponse;
  let toolCallIndex = 0;

  const handler: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch> = (url, init) => {
    const phase = parseRequestPhase(init);
    if (phase === "initialize") {
      options.capture?.initInits.push(init ?? ({} as RequestInit));
      return Promise.resolve(initResponseFactory());
    }
    if (phase === "notifications/initialized") {
      return Promise.resolve(notifResponseFactory());
    }
    if (phase === "tools/call") {
      options.capture?.toolCalls.push({ url: url as string, init });
      const idx = toolCallIndex++;
      return Promise.resolve(toolsCallResponseFactory(init, idx));
    }
    return Promise.resolve(new Response("unexpected phase", { status: 500 }));
  };

  return installFetch(handler);
}

// ---------------------------------------------------------------------------
// Fetch swap mechanics
// ---------------------------------------------------------------------------

let originalFetch: typeof fetch;
let fetchMock: ReturnType<typeof mock> | undefined;

beforeEach(async () => {
  originalFetch = globalThis.fetch;
  fetchMock = undefined;
  // Clear module-scope session cache between tests so each starts from a clean state.
  const { resetMcpClientSessions } = await import("./mcp-client");
  resetMcpClientSessions();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function installFetch(
  impl: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>
): ReturnType<typeof mock> {
  fetchMock = mock(impl);
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

function setFetch(impl: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>): void {
  installFetch(impl);
}

// ---------------------------------------------------------------------------
// callMcp: initialize-handshake contract
// ---------------------------------------------------------------------------

describe("callMcp — initialize handshake", () => {
  test("sends initialize first, captures Mcp-Session-Id, then sends tools/call with the session-id header", async () => {
    const capture = {
      initInits: [] as RequestInit[],
      toolCalls: [] as Array<{ url: string; init?: RequestInit }>,
    };
    setupHandshakeFetch(
      () =>
        mockJsonResponse({
          jsonrpc: "2.0",
          id: 2,
          result: { content: [{ type: "text", text: "ok" }] },
        }),
      { capture, sessionId: TEST_SESSION_ID }
    );

    const { callMcp } = await import("./mcp-client");
    const result = await callMcp(
      "session.list",
      {},
      { mcpUrl: CONFIG_WITH_MCP.mcpUrl as string, mcpToken: CONFIG_WITH_MCP.mcpToken as string }
    );

    expect(result.ok).toBe(true);
    expect(capture.initInits.length).toBe(1);
    expect(capture.toolCalls.length).toBe(1);

    const initHeaders = capture.initInits[0]?.headers as Record<string, string>;
    expect(initHeaders.Authorization).toBe(`Bearer ${CONFIG_WITH_MCP.mcpToken}`);
    // Initialize MUST NOT carry a session id header (it has nothing to carry yet).
    expect(initHeaders["Mcp-Session-Id"]).toBeUndefined();

    const callHeaders = capture.toolCalls[0]?.init?.headers as Record<string, string>;
    expect(callHeaders.Authorization).toBe(`Bearer ${CONFIG_WITH_MCP.mcpToken}`);
    expect(callHeaders["Mcp-Session-Id"]).toBe(TEST_SESSION_ID);
  });

  test("reuses the cached session id on subsequent calls (no second initialize)", async () => {
    const capture = {
      initInits: [] as RequestInit[],
      toolCalls: [] as Array<{ url: string; init?: RequestInit }>,
    };
    setupHandshakeFetch(
      () =>
        mockJsonResponse({
          jsonrpc: "2.0",
          id: 99,
          result: { content: [{ type: "text", text: "ok" }] },
        }),
      { capture, sessionId: TEST_SESSION_ID }
    );

    const { callMcp } = await import("./mcp-client");
    const config = {
      mcpUrl: CONFIG_WITH_MCP.mcpUrl as string,
      mcpToken: CONFIG_WITH_MCP.mcpToken as string,
    };
    const first = await callMcp("session.list", {}, config);
    const second = await callMcp("session.list", { foo: "bar" }, config);
    const third = await callMcp("session.list", {}, config);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(third.ok).toBe(true);

    // Exactly ONE initialize across three callMcp() invocations.
    expect(capture.initInits.length).toBe(1);
    expect(capture.toolCalls.length).toBe(3);
    for (const call of capture.toolCalls) {
      const headers = call.init?.headers as Record<string, string>;
      expect(headers["Mcp-Session-Id"]).toBe(TEST_SESSION_ID);
    }
  });

  test("re-initializes once on -32001 'Session not found' and retries the tools/call", async () => {
    const capture = {
      initInits: [] as RequestInit[],
      toolCalls: [] as Array<{ url: string; init?: RequestInit }>,
    };
    let initCount = 0;
    setupHandshakeFetch(
      (_init, callIndex) => {
        if (callIndex === 0) {
          return mockJsonResponse({
            jsonrpc: "2.0",
            id: 2,
            error: { code: -32001, message: "Session not found" },
          });
        }
        return mockJsonResponse({
          jsonrpc: "2.0",
          id: 3,
          result: { content: [{ type: "text", text: "retry-success" }] },
        });
      },
      {
        capture,
        initResponse: () => {
          initCount++;
          return mockInitializeResponse(`session-${initCount}`);
        },
      }
    );

    const { callMcp } = await import("./mcp-client");
    const result = await callMcp(
      "session.list",
      {},
      { mcpUrl: CONFIG_WITH_MCP.mcpUrl as string, mcpToken: CONFIG_WITH_MCP.mcpToken as string }
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.contentText).toBe("retry-success");
    // Two initializes (the initial one, then the re-init after -32001).
    expect(capture.initInits.length).toBe(2);
    // Two tools/calls (the failed one + the retry).
    expect(capture.toolCalls.length).toBe(2);
    // The retry must use the NEW session id.
    const retryHeaders = capture.toolCalls[1]?.init?.headers as Record<string, string>;
    expect(retryHeaders["Mcp-Session-Id"]).toBe("session-2");
  });

  test("re-initializes once on HTTP 404 and retries the tools/call", async () => {
    const capture = {
      initInits: [] as RequestInit[],
      toolCalls: [] as Array<{ url: string; init?: RequestInit }>,
    };
    setupHandshakeFetch(
      (_init, callIndex) => {
        if (callIndex === 0) {
          return new Response("session gone", { status: 404 });
        }
        return mockJsonResponse({
          jsonrpc: "2.0",
          id: 3,
          result: { content: [{ type: "text", text: "retry-success" }] },
        });
      },
      { capture }
    );

    const { callMcp } = await import("./mcp-client");
    const result = await callMcp(
      "session.list",
      {},
      { mcpUrl: CONFIG_WITH_MCP.mcpUrl as string, mcpToken: CONFIG_WITH_MCP.mcpToken as string }
    );

    expect(result.ok).toBe(true);
    expect(capture.initInits.length).toBe(2);
    expect(capture.toolCalls.length).toBe(2);
  });

  test("returns init-failed when initialize itself returns no session id header", async () => {
    setupHandshakeFetch(
      () =>
        mockJsonResponse({
          jsonrpc: "2.0",
          id: 2,
          result: { content: [{ type: "text", text: "won't reach" }] },
        }),
      {
        // No Mcp-Session-Id header — server bug.
        initResponse: () =>
          mockJsonResponse(
            { jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-03-26" } },
            200
          ),
      }
    );

    const { callMcp } = await import("./mcp-client");
    const result = await callMcp(
      "session.list",
      {},
      { mcpUrl: CONFIG_WITH_MCP.mcpUrl as string, mcpToken: CONFIG_WITH_MCP.mcpToken as string }
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("init-failed");
  });

  test("returns init-failed when initialize fetch itself rejects", async () => {
    setFetch((_url, init) => {
      const phase = parseRequestPhase(init);
      if (phase === "initialize") {
        return Promise.reject(new Error("ECONNREFUSED"));
      }
      return Promise.resolve(new Response("unreached", { status: 500 }));
    });

    const { callMcp } = await import("./mcp-client");
    const result = await callMcp(
      "session.list",
      {},
      { mcpUrl: CONFIG_WITH_MCP.mcpUrl as string, mcpToken: CONFIG_WITH_MCP.mcpToken as string }
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("init-failed");
  });

  test("returns config-missing without fetching when mcpUrl is empty", async () => {
    setFetch(() => Promise.resolve(new Response("should not be called", { status: 500 })));

    const { callMcp } = await import("./mcp-client");
    const result = await callMcp("session.list", {}, { mcpUrl: "", mcpToken: "tok" });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("config-missing");
    // The fetch mock should NEVER have been called.
    expect(fetchMock?.mock.calls.length ?? 0).toBe(0);
  });

  test("sends notifications/initialized after initialize and tolerates non-2xx on it", async () => {
    let notifSeen = false;
    let toolsCallSeen = false;
    setFetch((_url, init) => {
      const phase = parseRequestPhase(init);
      if (phase === "initialize") return Promise.resolve(mockInitializeResponse());
      if (phase === "notifications/initialized") {
        notifSeen = true;
        return Promise.resolve(new Response("nope", { status: 500 }));
      }
      if (phase === "tools/call") {
        toolsCallSeen = true;
        return Promise.resolve(
          mockJsonResponse({
            jsonrpc: "2.0",
            id: 2,
            result: { content: [{ type: "text", text: "ok" }] },
          })
        );
      }
      return Promise.resolve(new Response("unexpected", { status: 500 }));
    });

    const { callMcp } = await import("./mcp-client");
    const result = await callMcp(
      "session.list",
      {},
      { mcpUrl: CONFIG_WITH_MCP.mcpUrl as string, mcpToken: CONFIG_WITH_MCP.mcpToken as string }
    );

    expect(notifSeen).toBe(true);
    expect(toolsCallSeen).toBe(true);
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// callAuthorshipGet — existing behavioral suite, retrofitted to handshake flow
// ---------------------------------------------------------------------------

describe("callAuthorshipGet", () => {
  test("returns null immediately when mcpUrl is missing", async () => {
    const { callAuthorshipGet } = await import("./mcp-client");
    const result = await callAuthorshipGet("42", "pr", CONFIG_NO_MCP);
    expect(result).toBeNull();
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
    setupHandshakeFetch(() =>
      mockJsonResponse({
        jsonrpc: "2.0",
        id: 2,
        result: { content: [{ type: "text", text: JSON.stringify(authorshipRecord) }] },
      })
    );

    const { callAuthorshipGet } = await import("./mcp-client");
    const result = await callAuthorshipGet("42", "pr", CONFIG_WITH_MCP);

    expect(result).not.toBeNull();
    expect(result?.tier).toBe(3);
    expect(result?.rationale).toBe("fully agent-authored");
  });

  test("returns the authorship result on a successful SSE response", async () => {
    const authorshipRecord = { tier: 1, policyVersion: "1.0.0" };
    setupHandshakeFetch(() =>
      mockSseResponse({
        jsonrpc: "2.0",
        id: 2,
        result: { content: [{ type: "text", text: JSON.stringify(authorshipRecord) }] },
      })
    );

    const { callAuthorshipGet } = await import("./mcp-client");
    const result = await callAuthorshipGet("7", "pr", CONFIG_WITH_MCP);

    expect(result?.tier).toBe(1);
  });

  test("returns null when MCP result content text is null (no authorship record)", async () => {
    setupHandshakeFetch(() =>
      mockJsonResponse({
        jsonrpc: "2.0",
        id: 2,
        result: { content: [{ type: "text", text: "null" }] },
      })
    );

    const { callAuthorshipGet } = await import("./mcp-client");
    const result = await callAuthorshipGet("999", "pr", CONFIG_WITH_MCP);

    expect(result).toBeNull();
  });

  test("returns null on HTTP 500 error (drains body, no throw)", async () => {
    setupHandshakeFetch(() => new Response("Internal Server Error", { status: 500 }));

    const { callAuthorshipGet } = await import("./mcp-client");
    const result = await callAuthorshipGet("42", "pr", CONFIG_WITH_MCP);

    expect(result).toBeNull();
  });

  test("returns null on HTTP 401 Unauthorized (drains body)", async () => {
    setupHandshakeFetch(() => new Response("Unauthorized", { status: 401 }));

    const { callAuthorshipGet } = await import("./mcp-client");
    const result = await callAuthorshipGet("42", "pr", CONFIG_WITH_MCP);

    expect(result).toBeNull();
  });

  test("returns null when fetch throws (network error)", async () => {
    // Reject ANY fetch — including the initialize fetch.
    setFetch(() => Promise.reject(new Error("ECONNREFUSED")));

    const { callAuthorshipGet } = await import("./mcp-client");
    const result = await callAuthorshipGet("42", "pr", CONFIG_WITH_MCP);

    expect(result).toBeNull();
  });

  test("returns null on MCP-level error response", async () => {
    setupHandshakeFetch(() =>
      mockJsonResponse({
        jsonrpc: "2.0",
        id: 2,
        error: { code: -32601, message: "Method not found" },
      })
    );

    const { callAuthorshipGet } = await import("./mcp-client");
    const result = await callAuthorshipGet("42", "pr", CONFIG_WITH_MCP);

    expect(result).toBeNull();
  });

  test("returns null on empty result content array", async () => {
    setupHandshakeFetch(() => mockJsonResponse({ jsonrpc: "2.0", id: 2, result: { content: [] } }));

    const { callAuthorshipGet } = await import("./mcp-client");
    const result = await callAuthorshipGet("42", "pr", CONFIG_WITH_MCP);

    expect(result).toBeNull();
  });

  test("sends Authorization header with bearer token on tools/call", async () => {
    const capture = {
      initInits: [] as RequestInit[],
      toolCalls: [] as Array<{ url: string; init?: RequestInit }>,
    };
    setupHandshakeFetch(
      () =>
        mockJsonResponse({
          jsonrpc: "2.0",
          id: 2,
          result: { content: [{ type: "text", text: "null" }] },
        }),
      { capture }
    );

    const { callAuthorshipGet } = await import("./mcp-client");
    await callAuthorshipGet("42", "pr", CONFIG_WITH_MCP);

    const headers = capture.toolCalls[0]?.init?.headers as Record<string, string>;
    expect(headers?.Authorization).toBe(`Bearer ${CONFIG_WITH_MCP.mcpToken}`);
  });

  test("sends request to the configured mcpUrl", async () => {
    const capture = {
      initInits: [] as RequestInit[],
      toolCalls: [] as Array<{ url: string; init?: RequestInit }>,
    };
    setupHandshakeFetch(
      () =>
        mockJsonResponse({
          jsonrpc: "2.0",
          id: 2,
          result: { content: [{ type: "text", text: "null" }] },
        }),
      { capture }
    );

    const { callAuthorshipGet } = await import("./mcp-client");
    await callAuthorshipGet("42", "pr", CONFIG_WITH_MCP);

    expect(capture.toolCalls[0]?.url).toBe(CONFIG_WITH_MCP.mcpUrl as string);
  });

  test("returns the authorship result when content type is 'json'", async () => {
    const authorshipRecord = {
      tier: 2,
      rationale: "co-authored",
      policyVersion: "1.0.0",
    };
    setupHandshakeFetch(() =>
      mockJsonResponse({
        jsonrpc: "2.0",
        id: 2,
        result: { content: [{ type: "json", json: authorshipRecord }] },
      })
    );

    const { callAuthorshipGet } = await import("./mcp-client");
    const result = await callAuthorshipGet("55", "commit", CONFIG_WITH_MCP);

    expect(result).not.toBeNull();
    expect(result?.tier).toBe(2);
    expect(result?.rationale).toBe("co-authored");
  });

  test("returns null when result.isError is true", async () => {
    setupHandshakeFetch(() =>
      mockJsonResponse({
        jsonrpc: "2.0",
        id: 2,
        result: { isError: true, content: [{ type: "text", text: "tool execution failed" }] },
      })
    );

    const { callAuthorshipGet } = await import("./mcp-client");
    const result = await callAuthorshipGet("42", "pr", CONFIG_WITH_MCP);

    expect(result).toBeNull();
  });

  test("uses the LAST SSE data event when a progress event precedes the tool result", async () => {
    const progressEvent = { type: "progress", message: "looking up record..." };
    const toolResult = {
      jsonrpc: "2.0",
      id: 2,
      result: {
        content: [{ type: "text", text: JSON.stringify({ tier: 2, policyVersion: "1.0.0" }) }],
      },
    };
    const sseBody = `data: ${JSON.stringify(progressEvent)}\n\ndata: ${JSON.stringify(toolResult)}\n\n`;

    setupHandshakeFetch(
      () =>
        new Response(sseBody, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        })
    );

    const { callAuthorshipGet } = await import("./mcp-client");
    const result = await callAuthorshipGet("77", "pr", CONFIG_WITH_MCP);

    expect(result).not.toBeNull();
    expect(result?.tier).toBe(2);
  });

  test("handles multi-chunk text content by concatenating before parse", async () => {
    const authorshipRecord = { tier: 1, rationale: "human-authored", policyVersion: "2.0.0" };
    const fullJson = JSON.stringify(authorshipRecord);
    const mid = Math.floor(fullJson.length / 2);

    setupHandshakeFetch(() =>
      mockJsonResponse({
        jsonrpc: "2.0",
        id: 2,
        result: {
          content: [
            { type: "text", text: fullJson.slice(0, mid) },
            { type: "text", text: fullJson.slice(mid) },
          ],
        },
      })
    );

    const { callAuthorshipGet } = await import("./mcp-client");
    const result = await callAuthorshipGet("11", "pr", CONFIG_WITH_MCP);

    expect(result).not.toBeNull();
    expect(result?.tier).toBe(1);
    expect(result?.rationale).toBe("human-authored");
    expect(result?.policyVersion).toBe("2.0.0");
  });

  test("prefers type:'json' entry and ignores extra type:'text' chunks", async () => {
    const authorshipRecord = { tier: 3, rationale: "agent-authored", policyVersion: "1.0.0" };

    setupHandshakeFetch(() =>
      mockJsonResponse({
        jsonrpc: "2.0",
        id: 2,
        result: {
          content: [
            { type: "json", json: authorshipRecord },
            { type: "text", text: JSON.stringify({ tier: 9, rationale: "should be ignored" }) },
          ],
        },
      })
    );

    const { callAuthorshipGet } = await import("./mcp-client");
    const result = await callAuthorshipGet("22", "commit", CONFIG_WITH_MCP);

    expect(result).not.toBeNull();
    expect(result?.tier).toBe(3);
    expect(result?.rationale).toBe("agent-authored");
  });
});

// ---------------------------------------------------------------------------
// callTasksSpecGet — existing behavioral suite, retrofitted to handshake flow
// ---------------------------------------------------------------------------

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
    setupHandshakeFetch(() =>
      mockJsonResponse({
        jsonrpc: "2.0",
        id: 2,
        result: { content: [{ type: "text", text: makeEnvelope("## Summary\n\nreal spec") }] },
      })
    );

    const { callTasksSpecGet } = await import("./mcp-client");
    const result = await callTasksSpecGet("mt#1187", CONFIG_WITH_MCP);

    expect(result.kind).toBe("found");
    if (result.kind === "found") expect(result.content).toBe("## Summary\n\nreal spec");
  });

  test("returns found on a successful SSE envelope", async () => {
    setupHandshakeFetch(() =>
      mockSseResponse({
        jsonrpc: "2.0",
        id: 2,
        result: { content: [{ type: "text", text: makeEnvelope("## SSE spec") }] },
      })
    );

    const { callTasksSpecGet } = await import("./mcp-client");
    const result = await callTasksSpecGet("mt#1187", CONFIG_WITH_MCP);
    expect(result.kind).toBe("found");
    if (result.kind === "found") expect(result.content).toContain("SSE spec");
  });

  test("accepts a type:'json' content entry (pre-parsed envelope)", async () => {
    setupHandshakeFetch(() =>
      mockJsonResponse({
        jsonrpc: "2.0",
        id: 2,
        result: {
          content: [
            { type: "json", json: { success: true, taskId: "mt#1187", content: "## pre-parsed" } },
          ],
        },
      })
    );

    const { callTasksSpecGet } = await import("./mcp-client");
    const result = await callTasksSpecGet("mt#1187", CONFIG_WITH_MCP);
    expect(result.kind).toBe("found");
    if (result.kind === "found") expect(result.content).toBe("## pre-parsed");
  });

  test("concatenates multi-chunk text content before envelope parse", async () => {
    const envelope = makeEnvelope("## multi-chunk spec");
    const mid = Math.floor(envelope.length / 2);
    setupHandshakeFetch(() =>
      mockJsonResponse({
        jsonrpc: "2.0",
        id: 2,
        result: {
          content: [
            { type: "text", text: envelope.slice(0, mid) },
            { type: "text", text: envelope.slice(mid) },
          ],
        },
      })
    );

    const { callTasksSpecGet } = await import("./mcp-client");
    const result = await callTasksSpecGet("mt#1187", CONFIG_WITH_MCP);
    expect(result.kind).toBe("found");
    if (result.kind === "found") expect(result.content).toBe("## multi-chunk spec");
  });

  test("falls back to treating plain markdown as the spec when inner text is not JSON", async () => {
    setupHandshakeFetch(() =>
      mockJsonResponse({
        jsonrpc: "2.0",
        id: 2,
        result: { content: [{ type: "text", text: "## Plain markdown body" }] },
      })
    );

    const { callTasksSpecGet } = await import("./mcp-client");
    const result = await callTasksSpecGet("mt#1187", CONFIG_WITH_MCP);
    expect(result.kind).toBe("found");
    if (result.kind === "found") expect(result.content).toContain("Plain markdown body");
  });

  test("returns not-found when result content is empty", async () => {
    setupHandshakeFetch(() => mockJsonResponse({ jsonrpc: "2.0", id: 2, result: { content: [] } }));

    const { callTasksSpecGet } = await import("./mcp-client");
    const result = await callTasksSpecGet("mt#1187", CONFIG_WITH_MCP);
    expect(result.kind).toBe("not-found");
  });

  test("returns not-found when envelope has success:true but no content field", async () => {
    setupHandshakeFetch(() =>
      mockJsonResponse({
        jsonrpc: "2.0",
        id: 2,
        result: {
          content: [{ type: "text", text: JSON.stringify({ success: true, taskId: "mt#42" }) }],
        },
      })
    );

    const { callTasksSpecGet } = await import("./mcp-client");
    const result = await callTasksSpecGet("mt#42", CONFIG_WITH_MCP);
    expect(result.kind).toBe("not-found");
  });

  test("returns error with tool message on success:false envelope", async () => {
    setupHandshakeFetch(() =>
      mockJsonResponse({
        jsonrpc: "2.0",
        id: 2,
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
      })
    );

    const { callTasksSpecGet } = await import("./mcp-client");
    const result = await callTasksSpecGet("mt#1187", CONFIG_WITH_MCP);
    expect(result.kind).toBe("error");
    if (result.kind === "error") expect(result.message).toContain("Developer setup incomplete");
  });

  test("returns error with fallback message on success:false without error field", async () => {
    setupHandshakeFetch(() =>
      mockJsonResponse({
        jsonrpc: "2.0",
        id: 2,
        result: { content: [{ type: "text", text: JSON.stringify({ success: false }) }] },
      })
    );

    const { callTasksSpecGet } = await import("./mcp-client");
    const result = await callTasksSpecGet("mt#1187", CONFIG_WITH_MCP);
    expect(result.kind).toBe("error");
    if (result.kind === "error") expect(result.message).toContain("success:false");
  });

  test("returns error on non-200 HTTP responses", async () => {
    setupHandshakeFetch(
      () => new Response("server went home", { status: 503, statusText: "Service Unavailable" })
    );

    const { callTasksSpecGet } = await import("./mcp-client");
    const result = await callTasksSpecGet("mt#1187", CONFIG_WITH_MCP);
    expect(result.kind).toBe("error");
    if (result.kind === "error") expect(result.message).toContain("503");
  });

  test("returns error on JSON-RPC error envelopes", async () => {
    setupHandshakeFetch(() =>
      mockJsonResponse({
        jsonrpc: "2.0",
        id: 2,
        error: { code: -32000, message: "Bad Request: Server not initialized" },
      })
    );

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
    if (result.kind === "error") expect(result.message).toContain("initialize failed");
  });
});
