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
 *
 * Note: callAuthorshipGet and callTasksSpecGet were removed in mt#2121
 * (migrated to direct domain imports in tier-routing.ts and task-spec-fetch.ts).
 * Their test coverage lives in tier-routing.test.ts and task-spec-fetch.test.ts.
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
