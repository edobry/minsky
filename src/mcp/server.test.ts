/**
 * MCP Server Tests
 * @migrated Already using native Bun patterns
 * @refactored Uses project utilities and proper TypeScript imports
 */
import { describe, test, expect, beforeEach, mock } from "bun:test";
import { Server as SdkServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport as SdkStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import type { AddressInfo } from "net";
import { setupTestMocks } from "../utils/test-utils/mocking";
import { log } from "@minsky/shared/logger";

// Shared HTTP content-type constants used across integration tests
const CONTENT_TYPE_JSON = "application/json";
const ACCEPT_MCP = "application/json, text/event-stream";

// Shared response body constants
const SESSION_NOT_FOUND_MSG = "Session not found";

// Shared staleness-signal constants
const STALENESS_LOGGER = "minsky-staleness";

describe("MCP Server", () => {
  beforeEach(() => {
    setupTestMocks();
  });

  test("should import official MCP SDK module successfully", async () => {
    const { Server } = await import("@modelcontextprotocol/sdk/server/index.js");
    expect(Server).toBeDefined();
    expect(typeof Server).toBe("function");
  });

  test("should import stdio transport successfully", async () => {
    const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
    expect(StdioServerTransport).toBeDefined();
    expect(typeof StdioServerTransport).toBe("function");
  });

  test("should be able to import our server modules", async () => {
    // Test that our server-related modules can be imported without errors
    let importSucceeded = false;
    try {
      const { MinskyMCPServer } = await import("./server");
      expect(MinskyMCPServer).toBeDefined();
      expect(typeof MinskyMCPServer).toBe("function");
      importSucceeded = true;
    } catch (error) {
      log.error("Import failed:", error as any);
      importSucceeded = false;
    }
    expect(importSucceeded).toBe(true);
  });

  test("should create MinskyMCPServer instance", async () => {
    const { MinskyMCPServer } = await import("./server");
    const server = new MinskyMCPServer({
      name: "Test Server",
      version: "1.0.0",
      projectContext: { repositoryPath: "/mock/test-repo" },
    });

    expect(server).toBeDefined();
    expect(server.getProjectContext()).toBeDefined();
    expect(server.getTools()).toBeDefined();
    expect(server.getResources()).toBeDefined();
    expect(server.getPrompts()).toBeDefined();
  });

  test("HTTP transport: createConfiguredServer returns distinct Server instances", async () => {
    const { MinskyMCPServer } = await import("./server");
    const server = new MinskyMCPServer({
      name: "Test Server",
      version: "1.0.0",
      transportType: "http",
      projectContext: { repositoryPath: "/mock/test-repo" },
    });

    // createConfiguredServer is private but accessible via cast — the test
    // documents the factory contract: every call produces an independent
    // Server instance. The true regression guard is the Express-mounted
    // integration test below, which exercises handleHttpPost end-to-end.
    const factory = (
      server as unknown as { createConfiguredServer: () => unknown }
    ).createConfiguredServer.bind(server);

    const a = factory();
    const b = factory();
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(a).not.toBe(b);

    await server.close();
  });

  test("HTTP transport: two concurrent initialize requests both succeed with distinct session ids", async () => {
    // Integration regression guard for the singleton-transport bug. Spins up
    // MinskyMCPServer in HTTP mode behind a real Express app so the test
    // exercises handleHttpPost end-to-end — the actual code path where the
    // original bug lived ("Already connected to a transport" on second
    // new-session POST). Two concurrent initialize fetches must both return
    // 200 with distinct mcp-session-id headers.
    const { MinskyMCPServer } = await import("./server");
    const server = new MinskyMCPServer({
      name: "Test Server",
      version: "1.0.0",
      transportType: "http",
      httpConfig: { port: 0, host: "127.0.0.1", endpoint: "/mcp" },
      projectContext: { repositoryPath: "/mock/test-repo" },
    });

    const app = express();
    app.use(express.json());
    app.all("/mcp", async (req, res) => {
      await server.handleHttpRequest(req, res);
    });

    const httpServer = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => httpServer.on("listening", () => resolve()));
    const addr = httpServer.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${addr.port}/mcp`;

    try {
      const initBody = (clientName: string) =>
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: clientName, version: "0.1" },
          },
        });

      const doInit = (clientName: string) =>
        fetch(baseUrl, {
          method: "POST",
          headers: {
            "content-type": CONTENT_TYPE_JSON,
            accept: ACCEPT_MCP,
          },
          body: initBody(clientName),
        });

      const [r1, r2] = await Promise.all([doInit("client-a"), doInit("client-b")]);

      expect(r1.status).toBe(200);
      expect(r2.status).toBe(200);

      const sid1 = r1.headers.get("mcp-session-id");
      const sid2 = r2.headers.get("mcp-session-id");
      expect(sid1).toBeTruthy();
      expect(sid2).toBeTruthy();
      expect(sid1).not.toBe(sid2);

      // Drain the SSE bodies so fetch doesn't hold the connection open
      // longer than needed (avoids teardown races).
      await r1.text();
      await r2.text();

      const sessions = (
        server as unknown as {
          httpSessions: Map<string, unknown>;
        }
      ).httpSessions;
      expect(sessions.size).toBe(2);
    } finally {
      await new Promise<void>((resolve, reject) =>
        httpServer.close((err) => (err ? reject(err) : resolve()))
      );
      await server.close();
    }
  });

  test("HTTP transport: close() cleans up all active sessions", async () => {
    const { MinskyMCPServer } = await import("./server");
    const server = new MinskyMCPServer({
      name: "Test Server",
      version: "1.0.0",
      transportType: "http",
      projectContext: { repositoryPath: "/mock/test-repo" },
    });

    const { randomUUID } = await import("crypto");

    const sessions = (
      server as unknown as {
        httpSessions: Map<string, { server: unknown; transport: unknown; lastActiveAt: number }>;
      }
    ).httpSessions;

    for (const id of ["a", "b"]) {
      const s = new SdkServer(
        { name: "T", version: "0.0.1" },
        { capabilities: { tools: {}, resources: {}, prompts: {}, logging: {} } }
      );
      const t = new SdkStreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
      });
      await s.connect(t);
      sessions.set(id, { server: s, transport: t, lastActiveAt: Date.now() });
    }

    expect(sessions.size).toBe(2);
    await server.close();
    expect(sessions.size).toBe(0);
  });

  test("HTTP transport: reapIdleSessions drops sessions older than timeout", async () => {
    // Reaper sweeps httpSessions for entries whose lastActiveAt predates
    // SESSION_IDLE_TIMEOUT_MS. Verifies idle entries are dropped and fresh
    // entries survive. Exercised directly rather than via the interval timer
    // so the test stays hermetic.
    const { MinskyMCPServer } = await import("./server");
    const server = new MinskyMCPServer({
      name: "Test Server",
      version: "1.0.0",
      transportType: "http",
      projectContext: { repositoryPath: "/mock/test-repo" },
    });

    const { randomUUID } = await import("crypto");

    const serverAsAny = server as unknown as {
      httpSessions: Map<string, { server: unknown; transport: unknown; lastActiveAt: number }>;
      reapIdleSessions: () => Promise<void>;
      SESSION_IDLE_TIMEOUT_MS: number;
    };

    const makeSessionEntry = async (lastActiveAt: number) => {
      const s = new SdkServer(
        { name: "T", version: "0.0.1" },
        { capabilities: { tools: {}, resources: {}, prompts: {}, logging: {} } }
      );
      const t = new SdkStreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
      });
      await s.connect(t);
      return { server: s, transport: t, lastActiveAt };
    };

    const now = Date.now();
    const idleWindow = serverAsAny.SESSION_IDLE_TIMEOUT_MS;
    serverAsAny.httpSessions.set("fresh", await makeSessionEntry(now));
    serverAsAny.httpSessions.set("idle", await makeSessionEntry(now - idleWindow - 1000));

    await serverAsAny.reapIdleSessions();

    expect(serverAsAny.httpSessions.has("fresh")).toBe(true);
    expect(serverAsAny.httpSessions.has("idle")).toBe(false);

    await server.close();
  });

  test("HTTP transport: missing body-parser returns 500 JSON-RPC -32603", async () => {
    // Regression guard: if express.json() is omitted, req.body is undefined and the
    // old code would emit a confusing 400 protocol-violation error. With the guard in
    // place the handler must return 500 with code -32603 and a message that names
    // "express.json()" so the operator knows exactly what to fix.
    const { MinskyMCPServer } = await import("./server");
    const server = new MinskyMCPServer({
      name: "Test Server",
      version: "1.0.0",
      transportType: "http",
      httpConfig: { port: 0, host: "127.0.0.1", endpoint: "/mcp" },
      projectContext: { repositoryPath: "/mock/test-repo" },
    });

    // Intentionally omit express.json() so req.body is undefined
    const app = express();
    app.all("/mcp", async (req, res) => {
      await server.handleHttpRequest(req, res);
    });

    const httpServer = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => httpServer.on("listening", () => resolve()));
    const { port } = httpServer.address() as import("net").AddressInfo;
    const baseUrl = `http://127.0.0.1:${port}/mcp`;

    try {
      const res = await fetch(baseUrl, {
        method: "POST",
        headers: { "content-type": CONTENT_TYPE_JSON },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
      });

      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body).toMatchObject({
        jsonrpc: "2.0",
        error: { code: -32603 },
        id: null,
      });
      expect((body.error.message as string).toLowerCase()).toContain("express.json()");
    } finally {
      await new Promise<void>((resolve, reject) =>
        httpServer.close((err) => (err ? reject(err) : resolve()))
      );
      await server.close();
    }
  });

  test("HTTP transport: batch initialize creates a session", async () => {
    // Regression guard for JSON-RPC batch initialize. An array body whose first
    // element is an initialize request must create a new session and return an
    // mcp-session-id header, then the session must serve subsequent tool calls.
    const { MinskyMCPServer } = await import("./server");
    const server = new MinskyMCPServer({
      name: "Test Server",
      version: "1.0.0",
      transportType: "http",
      httpConfig: { port: 0, host: "127.0.0.1", endpoint: "/mcp" },
      projectContext: { repositoryPath: "/mock/test-repo" },
    });

    server.addTool({
      name: "ping",
      description: "A simple ping tool",
      handler: async () => "pong",
    });

    const app = express();
    app.use(express.json());
    app.all("/mcp", async (req, res) => {
      await server.handleHttpRequest(req, res);
    });

    const httpServer = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => httpServer.on("listening", () => resolve()));
    const { port } = httpServer.address() as import("net").AddressInfo;
    const baseUrl = `http://127.0.0.1:${port}/mcp`;

    try {
      // POST a single-element batch containing an initialize request
      const initRes = await fetch(baseUrl, {
        method: "POST",
        headers: {
          "content-type": CONTENT_TYPE_JSON,
          accept: ACCEPT_MCP,
        },
        body: JSON.stringify([
          {
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
              protocolVersion: "2025-06-18",
              capabilities: {},
              clientInfo: { name: "test", version: "1" },
            },
          },
        ]),
      });

      expect(initRes.status).toBe(200);
      const sessionId = initRes.headers.get("mcp-session-id");
      expect(sessionId).toBeTruthy();
      if (!sessionId) throw new Error("Expected mcp-session-id header in initialize response");

      // Drain the SSE body
      await initRes.text();

      // Verify the session can serve tool calls
      const toolsRes = await fetch(baseUrl, {
        method: "POST",
        headers: {
          "content-type": CONTENT_TYPE_JSON,
          accept: ACCEPT_MCP,
          "mcp-session-id": sessionId,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
      });

      expect(toolsRes.status).toBe(200);
      const toolsText = await toolsRes.text();
      expect(toolsText).toContain("ping");
    } finally {
      await new Promise<void>((resolve, reject) =>
        httpServer.close((err) => (err ? reject(err) : resolve()))
      );
      await server.close();
    }
  });

  test("HTTP transport: unknown session id returns 404 JSON-RPC -32001", async () => {
    // Regression guard: posting to a non-existent session ID must be rejected with
    // 404 and JSON-RPC error code -32001 ("Session not found"), matching the MCP
    // Streamable HTTP spec and the SDK's webStandardStreamableHttp behavior. This
    // gives compliant clients a retryable signal distinct from malformed-request errors.
    const { MinskyMCPServer } = await import("./server");
    const server = new MinskyMCPServer({
      name: "Test Server",
      version: "1.0.0",
      transportType: "http",
      httpConfig: { port: 0, host: "127.0.0.1", endpoint: "/mcp" },
      projectContext: { repositoryPath: "/mock/test-repo" },
    });

    const app = express();
    app.use(express.json());
    app.all("/mcp", async (req, res) => {
      await server.handleHttpRequest(req, res);
    });

    const httpServer = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => httpServer.on("listening", () => resolve()));
    const { port } = httpServer.address() as import("net").AddressInfo;
    const baseUrl = `http://127.0.0.1:${port}/mcp`;

    try {
      const res = await fetch(baseUrl, {
        method: "POST",
        headers: {
          "content-type": CONTENT_TYPE_JSON,
          "mcp-session-id": "00000000-0000-0000-0000-000000000000",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      });

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body).toMatchObject({
        jsonrpc: "2.0",
        error: { code: -32001, message: "Session not found" },
        id: null,
      });
    } finally {
      await new Promise<void>((resolve, reject) =>
        httpServer.close((err) => (err ? reject(err) : resolve()))
      );
      await server.close();
    }
  });

  test("HTTP transport GET: missing mcp-session-id header returns 404 plain text", async () => {
    // GET /mcp without an mcp-session-id header has no session to attach to;
    // the resource does not exist — the correct response is 404, not 405.
    const { MinskyMCPServer } = await import("./server");
    const server = new MinskyMCPServer({
      name: "Test Server",
      version: "1.0.0",
      transportType: "http",
      httpConfig: { port: 0, host: "127.0.0.1", endpoint: "/mcp" },
      projectContext: { repositoryPath: "/mock/test-repo" },
    });

    const app = express();
    app.use(express.json());
    app.all("/mcp", async (req, res) => {
      await server.handleHttpRequest(req, res);
    });

    const httpServer = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => httpServer.on("listening", () => resolve()));
    const { port } = httpServer.address() as import("net").AddressInfo;
    const baseUrl = `http://127.0.0.1:${port}/mcp`;

    try {
      const res = await fetch(baseUrl, { method: "GET" });

      expect(res.status).toBe(404);
      expect(res.headers.get("content-type")).toMatch(/^text\/plain/);
      const body = await res.text();
      expect(body).toBe(SESSION_NOT_FOUND_MSG);
    } finally {
      await new Promise<void>((resolve, reject) =>
        httpServer.close((err) => (err ? reject(err) : resolve()))
      );
      await server.close();
    }
  });

  test("HTTP transport GET: unknown mcp-session-id returns 404 plain text", async () => {
    // GET /mcp with an unrecognised session ID must return 404 (not 405).
    // GET is a valid method when a session exists; the error is a missing
    // resource, not a disallowed method.
    const { MinskyMCPServer } = await import("./server");
    const server = new MinskyMCPServer({
      name: "Test Server",
      version: "1.0.0",
      transportType: "http",
      httpConfig: { port: 0, host: "127.0.0.1", endpoint: "/mcp" },
      projectContext: { repositoryPath: "/mock/test-repo" },
    });

    const app = express();
    app.use(express.json());
    app.all("/mcp", async (req, res) => {
      await server.handleHttpRequest(req, res);
    });

    const httpServer = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => httpServer.on("listening", () => resolve()));
    const { port } = httpServer.address() as import("net").AddressInfo;
    const baseUrl = `http://127.0.0.1:${port}/mcp`;

    try {
      const res = await fetch(baseUrl, {
        method: "GET",
        headers: { "mcp-session-id": "00000000-0000-0000-0000-000000000000" },
      });

      expect(res.status).toBe(404);
      expect(res.headers.get("content-type")).toMatch(/^text\/plain/);
      const body = await res.text();
      expect(body).toBe(SESSION_NOT_FOUND_MSG);
    } finally {
      await new Promise<void>((resolve, reject) =>
        httpServer.close((err) => (err ? reject(err) : resolve()))
      );
      await server.close();
    }
  });

  test("tools/call success path triggers staleness signal when detector reports stale", async () => {
    // Regression guard for the handler wiring, not just triggerStaleSignal in isolation.
    // If the `if (this.stalenessDetector.getStaleWarning() ...)` check were removed from
    // the success branch of setupRequestHandlers, THIS test would fail even though the
    // existing triggerStaleSignal unit test would still pass.
    //
    // Strategy: invoke the registered tools/call handler directly via the SDK Server's
    // internal _requestHandlers map (keyed by method name "tools/call"), bypassing the
    // MCP protocol layer.  This is the same code path as a real client tool call without
    // the overhead of a full network round-trip.
    const { MinskyMCPServer } = await import("./server");

    const server = new MinskyMCPServer({
      name: "Test Server",
      version: "1.0.0",
      transportType: "stdio",
      projectContext: { repositoryPath: "/mock/test-repo" },
    });

    // Register a trivial tool that returns a deterministic value.
    server.addTool({
      name: "greet",
      description: "Returns a greeting",
      handler: async () => "hello from greet",
    });

    // Inject a fake StalenessDetector that always reports stale.
    const fakeStartupHead = "aabbccdd";
    const fakeCurrentHead = "eeff0011";
    const fakeStaleMessage =
      `\n\n The Minsky MCP server was loaded from commit ${fakeStartupHead} ` +
      `but the workspace is now at ${fakeCurrentHead}. Source files have changed. ` +
      `Run: /mcp then reconnect minsky`;
    const fakeDetector = {
      getStaleWarning: mock(() => fakeStaleMessage),
      isCurrentlyStale: mock(() => true),
    };
    (server as unknown as { stalenessDetector: typeof fakeDetector }).stalenessDetector =
      fakeDetector;

    // Intercept the exit indirection so we don't actually exit.
    const exitCalls: number[] = [];
    (server as unknown as { exit: (code: number) => void }).exit = (code: number) => {
      exitCalls.push(code);
    };

    // Intercept sendLoggingMessage on the SDK server instance.
    const loggingCalls: Array<{ level: string; logger?: string; data: unknown }> = [];
    const sdkServer = (server as unknown as { server: { sendLoggingMessage: unknown } }).server;
    sdkServer.sendLoggingMessage = mock(
      async (params: { level: string; logger?: string; data: unknown }) => {
        loggingCalls.push(params);
      }
    );

    // Invoke the registered tools/call handler via the SDK Protocol's internal
    // _requestHandlers map (keyed by "tools/call"). This exercises the actual
    // wiring in setupRequestHandlers — the getStaleWarning() check must be present
    // for sendLoggingMessage to fire here.
    const handlers = (sdkServer as unknown as { _requestHandlers: Map<string, Function> })
      ._requestHandlers;
    const toolsCallHandler = handlers.get("tools/call");
    if (!toolsCallHandler) throw new Error("Expected tools/call handler to be registered");

    const syntheticRequest = {
      method: "tools/call",
      params: {
        name: "greet",
        arguments: {},
      },
    };

    const response = await toolsCallHandler(syntheticRequest, {});

    // The tool response must be returned correctly regardless of staleness.
    expect(response).toMatchObject({
      content: [{ type: "text", text: "hello from greet" }],
    });

    // sendLoggingMessage must have been called once with the correct shape —
    // proving the handler wiring (not just triggerStaleSignal itself) is intact.
    expect(loggingCalls.length).toBe(1);
    const call = loggingCalls[0];
    if (!call) throw new Error("Expected loggingCalls[0] to be defined");
    expect(call.level).toBe("alert");
    expect(call.logger).toBe(STALENESS_LOGGER);
    const data = call.data as { text: string; startupHead: string; currentHead: string };
    expect(data.text).toContain("reconnect via /mcp");
    expect(data.startupHead).toBe(fakeStartupHead);
    expect(data.currentHead).toBe(fakeCurrentHead);

    // Wait for the exit timer (200ms) to fire so it doesn't leak into other tests.
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
    expect(exitCalls.length).toBe(1);

    await server.close();
  });

  test("tools/call error path triggers staleness signal when detector reports stale", async () => {
    // Parallel to the success-path wiring test above. Verifies that the error branch
    // of the tools/call handler also checks for staleness — removing the
    // getStaleWarning() check from the catch block would make this test fail.
    const { MinskyMCPServer } = await import("./server");

    const server = new MinskyMCPServer({
      name: "Test Server",
      version: "1.0.0",
      transportType: "stdio",
      projectContext: { repositoryPath: "/mock/test-repo" },
    });

    // Register a tool that always throws.
    server.addTool({
      name: "fail",
      description: "Always fails",
      handler: async () => {
        throw new Error("deliberate failure");
      },
    });

    // Inject a fake StalenessDetector that always reports stale.
    const fakeStartupHead = "11223344";
    const fakeCurrentHead = "55667788";
    const fakeStaleMessage =
      `\n\n The Minsky MCP server was loaded from commit ${fakeStartupHead} ` +
      `but the workspace is now at ${fakeCurrentHead}. Source files have changed. ` +
      `Run: /mcp then reconnect minsky`;
    const fakeDetector = {
      getStaleWarning: mock(() => fakeStaleMessage),
      isCurrentlyStale: mock(() => true),
    };
    (server as unknown as { stalenessDetector: typeof fakeDetector }).stalenessDetector =
      fakeDetector;

    // Intercept the exit indirection.
    const exitCalls: number[] = [];
    (server as unknown as { exit: (code: number) => void }).exit = (code: number) => {
      exitCalls.push(code);
    };

    // Intercept sendLoggingMessage on the SDK server instance.
    const loggingCalls: Array<{ level: string; logger?: string; data: unknown }> = [];
    const sdkServer = (server as unknown as { server: { sendLoggingMessage: unknown } }).server;
    sdkServer.sendLoggingMessage = mock(
      async (params: { level: string; logger?: string; data: unknown }) => {
        loggingCalls.push(params);
      }
    );

    const handlers = (sdkServer as unknown as { _requestHandlers: Map<string, Function> })
      ._requestHandlers;
    const toolsCallHandler = handlers.get("tools/call");
    if (!toolsCallHandler) throw new Error("Expected tools/call handler to be registered");

    const syntheticRequest = {
      method: "tools/call",
      params: {
        name: "fail",
        arguments: {},
      },
    };

    // The handler re-throws — verify the error reaches the caller.
    await expect(toolsCallHandler(syntheticRequest, {})).rejects.toThrow(
      "Tool execution failed: deliberate failure"
    );

    // sendLoggingMessage must still fire even on the error path.
    expect(loggingCalls.length).toBe(1);
    const call = loggingCalls[0];
    if (!call) throw new Error("Expected loggingCalls[0] to be defined");
    expect(call.level).toBe("alert");
    expect(call.logger).toBe(STALENESS_LOGGER);

    // Wait for the exit timer (200ms) to fire so it doesn't leak into other tests.
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
    expect(exitCalls.length).toBe(1);

    await server.close();
  });

  test("staleness signal: sendLoggingMessage called at alert level and exit scheduled when stale", async () => {
    // Verifies that when StalenessDetector returns a non-null warning:
    // (a) the tool response is still returned correctly,
    // (b) server.sendLoggingMessage is called once with level="alert" and
    //     logger="minsky-staleness",
    // (c) the exit indirection is invoked (not the real process.exit).
    const { MinskyMCPServer } = await import("./server");

    const server = new MinskyMCPServer({
      name: "Test Server",
      version: "1.0.0",
      transportType: "stdio",
      projectContext: { repositoryPath: "/mock/test-repo" },
    });

    // Register a trivial tool
    server.addTool({
      name: "echo",
      description: "Echo a value",
      handler: async (args: Record<string, unknown>) => String(args.value ?? "ok"),
    });

    // Inject a fake StalenessDetector that always reports stale.
    // The stale message uses real-looking hex commit hashes so triggerStaleSignal's
    // regex ([0-9a-f]{7,8}) can extract them. Mirrors the format from StalenessDetector.
    const fakeStartupHead = "abc01234";
    const fakeCurrentHead = "def56789";
    const fakeStaleMessage =
      `\n\n⚠️ The Minsky MCP server was loaded from commit ${fakeStartupHead} ` +
      `but the workspace is now at ${fakeCurrentHead}. Source files have changed. ` +
      `Run: /mcp then reconnect minsky`;
    const fakeDetector = {
      getStaleWarning: mock(() => fakeStaleMessage),
      isCurrentlyStale: mock(() => true),
    };
    (server as unknown as { stalenessDetector: typeof fakeDetector }).stalenessDetector =
      fakeDetector;

    // Intercept the exit indirection so we don't actually exit
    const exitCalls: number[] = [];
    (server as unknown as { exit: (code: number) => void }).exit = (code: number) => {
      exitCalls.push(code);
    };

    // Intercept sendLoggingMessage on the internal SDK server instance.
    // The private `server` field holds the SDK Server for stdio mode.
    const loggingCalls: Array<{ level: string; logger?: string; data: unknown }> = [];
    const sdkServer = (server as unknown as { server: { sendLoggingMessage: unknown } }).server;
    sdkServer.sendLoggingMessage = mock(
      async (params: { level: string; logger?: string; data: unknown }) => {
        loggingCalls.push(params);
      }
    );

    // Access the private setupRequestHandlers result by invoking the handler directly.
    // We exercise it via the internal tools map + the handler logic in setupRequestHandlers,
    // which is invoked by calling the registered CallToolRequestSchema handler.
    // Since MinskyMCPServer wires handlers to its private `server`, we call the handler
    // by simulating a tool call via the internal handler map.
    const toolsMap = server.getTools();
    const echoTool = toolsMap.get("echo");
    if (!echoTool) throw new Error("Expected echo tool to be registered");

    // Simulate the tools/call handler internals: call the tool handler and check staleness.
    // We replicate the handler's logic here to avoid needing a full MCP protocol round-trip.
    // The actual staleness check lives in setupRequestHandlers which is already called
    // during construction. We test triggerStaleSignal directly.
    const triggerStaleSignal = (
      server as unknown as { triggerStaleSignal: (s: typeof sdkServer) => void }
    ).triggerStaleSignal.bind(server);

    // Verify tool call succeeds (handler is set; getHandler was not used here)
    if (!echoTool.handler) throw new Error("echoTool.handler unexpectedly undefined");
    const result = await echoTool.handler({ value: "hello" });
    expect(result).toBe("hello");

    // Verify stale signal not yet triggered
    expect(exitCalls.length).toBe(0);
    expect(loggingCalls.length).toBe(0);

    // Trigger the stale signal (as the handler would)
    triggerStaleSignal(sdkServer as any);

    // sendLoggingMessage should be called immediately (before the setTimeout fires)
    expect(loggingCalls.length).toBe(1);
    const firstCall = loggingCalls[0];
    if (!firstCall) throw new Error("Expected loggingCalls[0] to be defined");
    expect(firstCall.level).toBe("alert");
    expect(firstCall.logger).toBe(STALENESS_LOGGER);
    const data = firstCall.data as { text: string; startupHead: string; currentHead: string };
    expect(data.text).toContain("reconnect via /mcp");
    expect(data.startupHead).toBe(fakeStartupHead);
    expect(data.currentHead).toBe(fakeCurrentHead);

    // hasTriggeredStaleSignal should now be true — calling again is a no-op
    triggerStaleSignal(sdkServer as any);
    expect(loggingCalls.length).toBe(1); // no second call

    // exit is scheduled via setTimeout(200ms) — advance using fake timers isn't
    // available in bun:test, so we wait for the timer to fire naturally.
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
    expect(exitCalls.length).toBe(1);
    const firstExitCode = exitCalls[0];
    if (firstExitCode === undefined) throw new Error("Expected exitCalls[0] to be defined");
    expect(firstExitCode).toBe(0);

    await server.close();
  });

  // ---------------------------------------------------------------------------
  // Admission control: concurrent-session cap (mt#1204)
  // ---------------------------------------------------------------------------

  /**
   * Helper: spin up MinskyMCPServer in HTTP mode with env-injected cap behind an
   * Express app on a random port. Returns { baseUrl, httpServer, server }.
   * The caller is responsible for cleanup (httpServer.close + server.close).
   */
  async function startHttpServer(maxSessions?: string): Promise<{
    baseUrl: string;
    httpServer: ReturnType<typeof import("net").createServer>;
    server: import("./server").MinskyMCPServer;
  }> {
    // Temporarily set the env var before constructing the server so the
    // constructor reads the injected value.
    const originalEnv = process.env.MINSKY_MCP_MAX_SESSIONS;
    if (maxSessions !== undefined) {
      process.env.MINSKY_MCP_MAX_SESSIONS = maxSessions;
    } else {
      delete process.env.MINSKY_MCP_MAX_SESSIONS;
    }

    const { MinskyMCPServer } = await import("./server");
    const server = new MinskyMCPServer({
      name: "Test Server",
      version: "1.0.0",
      transportType: "http",
      httpConfig: { port: 0, host: "127.0.0.1", endpoint: "/mcp" },
      projectContext: { repositoryPath: "/mock/test-repo" },
    });

    // Restore original env after construction
    if (originalEnv !== undefined) {
      process.env.MINSKY_MCP_MAX_SESSIONS = originalEnv;
    } else {
      delete process.env.MINSKY_MCP_MAX_SESSIONS;
    }

    const app = express();
    app.use(express.json());
    app.all("/mcp", async (req, res) => {
      await server.handleHttpRequest(req, res);
    });

    const httpServer = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => httpServer.on("listening", () => resolve()));
    const addr = httpServer.address() as import("net").AddressInfo;
    const baseUrl = `http://127.0.0.1:${addr.port}/mcp`;

    return { baseUrl, httpServer: httpServer as any, server };
  }

  function makeInitBody(clientName: string): string {
    return JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: clientName, version: "0.1" },
      },
    });
  }

  async function doInit(baseUrl: string, clientName: string): Promise<Response> {
    return fetch(baseUrl, {
      method: "POST",
      headers: {
        "content-type": CONTENT_TYPE_JSON,
        accept: ACCEPT_MCP,
      },
      body: makeInitBody(clientName),
    });
  }

  test("admission control: sub-cap initialize requests succeed", async () => {
    // With MINSKY_MCP_MAX_SESSIONS=2, two concurrent initializes must both succeed.
    const { baseUrl, httpServer, server } = await startHttpServer("2");

    try {
      expect(server.getMaxSessions()).toBe(2);

      const [r1, r2] = await Promise.all([doInit(baseUrl, "c1"), doInit(baseUrl, "c2")]);

      expect(r1.status).toBe(200);
      expect(r2.status).toBe(200);
      expect(r1.headers.get("mcp-session-id")).toBeTruthy();
      expect(r2.headers.get("mcp-session-id")).toBeTruthy();
      await r1.text();
      await r2.text();

      expect(server.getSessionCount()).toBe(2);
    } finally {
      await new Promise<void>((resolve, reject) =>
        httpServer.close((err: Error | undefined) => (err ? reject(err) : resolve()))
      );
      await server.close();
    }
  });

  test("admission control: initialize beyond cap returns 503 + Retry-After", async () => {
    // With cap=2, the third initialize must get 503 Service Unavailable with a
    // Retry-After header. The first two succeed.
    const { baseUrl, httpServer, server } = await startHttpServer("2");

    try {
      const r1 = await doInit(baseUrl, "c1");
      expect(r1.status).toBe(200);
      await r1.text();

      const r2 = await doInit(baseUrl, "c2");
      expect(r2.status).toBe(200);
      await r2.text();

      // Cap is now full — third request must be rejected.
      const r3 = await doInit(baseUrl, "c3");
      expect(r3.status).toBe(503);

      const retryAfter = r3.headers.get("retry-after");
      expect(retryAfter).toBeTruthy();
      const retryAfterNum = Number(retryAfter);
      expect(retryAfterNum).toBeGreaterThan(0);

      const body = await r3.json();
      expect(body).toMatchObject({
        jsonrpc: "2.0",
        error: { code: -32603 },
        id: null,
      });
      expect((body.error.message as string).toLowerCase()).toContain("cap");

      // Session count stays at 2.
      expect(server.getSessionCount()).toBe(2);
    } finally {
      await new Promise<void>((resolve, reject) =>
        httpServer.close((err: Error | undefined) => (err ? reject(err) : resolve()))
      );
      await server.close();
    }
  });

  test("admission control: session close releases capacity for a new session", async () => {
    // After closing one of the two capped sessions, a new initialize must succeed.
    const { baseUrl, httpServer, server } = await startHttpServer("2");

    try {
      const r1 = await doInit(baseUrl, "c1");
      expect(r1.status).toBe(200);
      const sid1 = r1.headers.get("mcp-session-id");
      await r1.text();

      const r2 = await doInit(baseUrl, "c2");
      expect(r2.status).toBe(200);
      await r2.text();

      // Cap reached — verify rejection before releasing.
      const rejected = await doInit(baseUrl, "c3-before-release");
      expect(rejected.status).toBe(503);
      await rejected.text();

      // Tear down session 1 by sending DELETE (MCP session-close convention).
      // The SDK transport also removes the session from httpSessions on DELETE.
      // We simulate natural close by directly deleting from the internal map
      // (same effect as a client calling DELETE /mcp with the session id).
      if (sid1) {
        const sessions = (
          server as unknown as {
            httpSessions: Map<
              string,
              { server: unknown; transport: { close: () => Promise<void> }; lastActiveAt: number }
            >;
          }
        ).httpSessions;
        const entry = sessions.get(sid1);
        if (entry) {
          sessions.delete(sid1);
          await entry.transport.close();
        }
      }

      // Now a new initialize must succeed — capacity was freed.
      const r4 = await doInit(baseUrl, "c4-after-release");
      expect(r4.status).toBe(200);
      await r4.text();

      expect(server.getSessionCount()).toBe(2);
    } finally {
      await new Promise<void>((resolve, reject) =>
        httpServer.close((err: Error | undefined) => (err ? reject(err) : resolve()))
      );
      await server.close();
    }
  });

  test("admission control: no cap when MINSKY_MCP_MAX_SESSIONS is unset", async () => {
    // Without the env var, sessions must not be capped regardless of count.
    const { baseUrl, httpServer, server } = await startHttpServer(undefined);

    try {
      expect(server.getMaxSessions()).toBeNull();

      // Three concurrent initializes must all succeed.
      const [r1, r2, r3] = await Promise.all([
        doInit(baseUrl, "c1"),
        doInit(baseUrl, "c2"),
        doInit(baseUrl, "c3"),
      ]);

      expect(r1.status).toBe(200);
      expect(r2.status).toBe(200);
      expect(r3.status).toBe(200);

      await r1.text();
      await r2.text();
      await r3.text();

      expect(server.getSessionCount()).toBe(3);
    } finally {
      await new Promise<void>((resolve, reject) =>
        httpServer.close((err: Error | undefined) => (err ? reject(err) : resolve()))
      );
      await server.close();
    }
  });

  test("admission control: getSessionCount returns 0 for stdio transport", async () => {
    const { MinskyMCPServer } = await import("./server");
    const server = new MinskyMCPServer({
      name: "Test Server",
      version: "1.0.0",
      transportType: "stdio",
      projectContext: { repositoryPath: "/mock/test-repo" },
    });
    expect(server.getSessionCount()).toBe(0);
    expect(server.getMaxSessions()).toBeNull();
    await server.close();
  });
});

describe("MinskyMCPServer.addTool — Claude Desktop alias dual-registration (mt#1779)", () => {
  // Claude Desktop's frontend validator regex — the source of the bug this
  // suite protects against. Any tool name surfaced in `tools/list` MUST match.
  const CLAUDE_DESKTOP_TOOL_NAME_REGEX = /^[a-zA-Z0-9_-]{1,64}$/;

  // Shared test-fixture client identities (avoids the no-magic-string-duplication
  // lint rule).
  const NON_CLAUDE_CLIENT_NAME = "custom-mcp-client";
  const CLAUDE_CLIENT_NAME = "claude-ai";

  // Mirror of the production `toClaudeDesktopName` — kept local rather than
  // imported to keep the test asserting against the wire shape, not against
  // a function that could regress in lockstep with the production code.
  const expectedDesktopName = (name: string): string => name.replace(/\./g, "_");

  function buildToolDef(name: string): {
    name: string;
    description: string;
    inputSchema: object;
    handler: (args: Record<string, unknown>) => Promise<unknown>;
  } {
    return {
      name,
      description: `Test tool ${name}`,
      inputSchema: { type: "object", properties: {}, additionalProperties: true },
      handler: async () => ({ ok: true, name }),
    };
  }

  test("dotted tool name is dual-registered: both the dotted canonical AND the underscored alias resolve", async () => {
    const { MinskyMCPServer: MMS } = await import("./server");
    const server = new MMS({
      name: "Test Server",
      version: "1.0.0",
      transportType: "stdio",
      projectContext: { repositoryPath: "/mock/test-repo" },
    });

    server.addTool(buildToolDef("session.pr.get"));

    // Both forms must be dispatchable via the internal tools map (the
    // CallTool handler does `this.tools.get(request.params.name)`).
    const tools = (server as unknown as { tools: Map<string, unknown> }).tools;
    expect(tools.has("session.pr.get")).toBe(true);
    expect(tools.has("session_pr_get")).toBe(true);
    expect(tools.get("session.pr.get")).toBe(tools.get("session_pr_get"));

    await server.close();
  });

  test("non-dotted tool name is registered exactly once (no spurious alias)", async () => {
    const { MinskyMCPServer: MMS } = await import("./server");
    const server = new MMS({
      name: "Test Server",
      version: "1.0.0",
      transportType: "stdio",
      projectContext: { repositoryPath: "/mock/test-repo" },
    });

    const before = (server as unknown as { tools: Map<string, unknown> }).tools.size;
    server.addTool(buildToolDef("plain_name"));
    const after = (server as unknown as { tools: Map<string, unknown> }).tools.size;

    expect(after - before).toBe(1);

    await server.close();
  });

  // Drive tools/list through the real SDK handler. The SDK Server class is
  // wired in `setupRequestHandlers` which fires when an SDK Server is connected
  // to a transport. To exercise it deterministically without a real transport
  // round-trip, we cast through to the SDK Server's private `_requestHandlers`
  // map and invoke the handler directly. Mirrors the test pattern used by
  // mt#1751's defer-DI suite.
  async function callToolsListHandler(
    server: import("./server").MinskyMCPServer,
    clientInfo?: { name: string; version: string }
  ): Promise<{ tools: Array<{ name: string; description: string; inputSchema: object }> }> {
    // Stdio mode constructs an internal SDK Server during start(); for tests we
    // pluck it via the per-session creation path.
    const sdkServer = (
      server as unknown as { createConfiguredServer: (k: string) => unknown }
    ).createConfiguredServer("test-session-key") as {
      _requestHandlers: Map<string, (req: unknown, extra: unknown) => Promise<unknown>>;
      _clientVersion?: { name: string; version: string };
    };
    if (clientInfo) sdkServer._clientVersion = clientInfo;
    const handler = sdkServer._requestHandlers.get("tools/list");
    if (!handler) throw new Error("SDK did not register tools/list handler");
    return (await handler({ method: "tools/list", params: {} }, {})) as {
      tools: Array<{ name: string; description: string; inputSchema: object }>;
    };
  }

  test("regression: every name surfaced to tools/list matches Claude Desktop's validator regex (Claude client)", async () => {
    const { MinskyMCPServer: MMS } = await import("./server");
    const server = new MMS({
      name: "Test Server",
      version: "1.0.0",
      transportType: "stdio",
      projectContext: { repositoryPath: "/mock/test-repo" },
    });

    // Register a representative set spanning the kinds of names production uses.
    const names = [
      "session.list",
      "session.pr.get",
      "session.apply_post_merge_state_sync",
      "tasks.list",
      "tasks.spec.get",
      "debug.echo",
      "debug.listMethods",
      "rules.create",
      "git.log",
      "persistence.check",
      "validate.lint",
      "plain_name",
    ];
    for (const n of names) server.addTool(buildToolDef(n));

    // Drive through the real SDK handler with a Claude-Desktop-shaped client.
    const result = await callToolsListHandler(server, {
      name: CLAUDE_CLIENT_NAME,
      version: "1.0",
    });

    // Every emitted name must pass Claude Desktop's validator regex.
    for (const tool of result.tools) {
      expect(tool.name).toMatch(CLAUDE_DESKTOP_TOOL_NAME_REGEX);
      expect(tool.name).not.toContain(".");
    }
    // Each tool surfaces exactly once.
    expect(result.tools.length).toBe(names.length);
    // The Claude-Desktop-mangled names match the expectedDesktopName() of each canonical.
    const emittedSet = new Set(result.tools.map((t) => t.name));
    for (const canonical of names) {
      expect(emittedSet.has(expectedDesktopName(canonical))).toBe(true);
    }

    await server.close();
  });

  test("mt#1785: DEFAULT (no env var) emits underscored regardless of client identity", async () => {
    // mt#1785: the new default is `underscore`. Even a non-Claude client now
    // receives validator-clean names. Use case: Anthropic's tools-list cache
    // is keyed by MCP-server name and persists snapshots; ensuring EVERY
    // snapshot is underscored prevents the cached-dotted-name failure mode.
    const { MinskyMCPServer: MMS } = await import("./server");
    const server = new MMS({
      name: "Test Server",
      version: "1.0.0",
      transportType: "stdio",
      projectContext: { repositoryPath: "/mock/test-repo" },
    });

    server.addTool(buildToolDef("tasks.list"));
    server.addTool(buildToolDef("session.pr.get"));

    // Belt-and-suspenders: make sure MINSKY_MCP_TOOL_NAMES is not set (so the
    // test exercises the actual default), restore on exit.
    const prev = process.env.MINSKY_MCP_TOOL_NAMES;
    delete process.env.MINSKY_MCP_TOOL_NAMES;
    try {
      // Non-Claude client + no env var → underscored by default (mt#1785).
      const result = await callToolsListHandler(server, {
        name: NON_CLAUDE_CLIENT_NAME,
        version: "1",
      });
      const emittedNames = result.tools.map((t) => t.name).sort();
      expect(emittedNames).toEqual(["session_pr_get", "tasks_list"]);
    } finally {
      if (prev === undefined) delete process.env.MINSKY_MCP_TOOL_NAMES;
      else process.env.MINSKY_MCP_TOOL_NAMES = prev;
    }

    await server.close();
  });

  test("mt#1785: MINSKY_MCP_TOOL_NAMES=auto restores feature-detect (non-Claude → dotted)", async () => {
    // The mt#1779 behavior is preserved as an opt-in mode. Non-Claude clients
    // see canonical dotted; Claude clients see underscored.
    const { MinskyMCPServer: MMS } = await import("./server");
    const server = new MMS({
      name: "Test Server",
      version: "1.0.0",
      transportType: "stdio",
      projectContext: { repositoryPath: "/mock/test-repo" },
    });

    server.addTool(buildToolDef("tasks.list"));

    const prev = process.env.MINSKY_MCP_TOOL_NAMES;
    process.env.MINSKY_MCP_TOOL_NAMES = "auto";
    try {
      // Non-Claude in `auto` mode → canonical dotted.
      const nonClaude = await callToolsListHandler(server, {
        name: NON_CLAUDE_CLIENT_NAME,
        version: "1",
      });
      expect(nonClaude.tools.map((t) => t.name)).toEqual(["tasks.list"]);

      // Claude client in `auto` mode → underscored.
      const claude = await callToolsListHandler(server, {
        name: CLAUDE_CLIENT_NAME,
        version: "1",
      });
      expect(claude.tools.map((t) => t.name)).toEqual(["tasks_list"]);
    } finally {
      if (prev === undefined) delete process.env.MINSKY_MCP_TOOL_NAMES;
      else process.env.MINSKY_MCP_TOOL_NAMES = prev;
    }

    await server.close();
  });

  test("env override MINSKY_MCP_TOOL_NAMES=underscore forces aliases for all clients", async () => {
    const { MinskyMCPServer: MMS } = await import("./server");
    const server = new MMS({
      name: "Test Server",
      version: "1.0.0",
      transportType: "stdio",
      projectContext: { repositoryPath: "/mock/test-repo" },
    });

    server.addTool(buildToolDef("tasks.list"));

    const prev = process.env.MINSKY_MCP_TOOL_NAMES;
    process.env.MINSKY_MCP_TOOL_NAMES = "underscore";
    try {
      const result = await callToolsListHandler(server, {
        name: NON_CLAUDE_CLIENT_NAME,
        version: "1",
      });
      expect(result.tools.map((t) => t.name)).toEqual(["tasks_list"]);
    } finally {
      if (prev === undefined) delete process.env.MINSKY_MCP_TOOL_NAMES;
      else process.env.MINSKY_MCP_TOOL_NAMES = prev;
    }

    await server.close();
  });

  test("env override MINSKY_MCP_TOOL_NAMES=dotted forces canonical for all clients (incl. Claude)", async () => {
    const { MinskyMCPServer: MMS } = await import("./server");
    const server = new MMS({
      name: "Test Server",
      version: "1.0.0",
      transportType: "stdio",
      projectContext: { repositoryPath: "/mock/test-repo" },
    });

    server.addTool(buildToolDef("tasks.list"));

    const prev = process.env.MINSKY_MCP_TOOL_NAMES;
    process.env.MINSKY_MCP_TOOL_NAMES = "dotted";
    try {
      const result = await callToolsListHandler(server, {
        name: CLAUDE_CLIENT_NAME,
        version: "1.0",
      });
      expect(result.tools.map((t) => t.name)).toEqual(["tasks.list"]);
    } finally {
      if (prev === undefined) delete process.env.MINSKY_MCP_TOOL_NAMES;
      else process.env.MINSKY_MCP_TOOL_NAMES = prev;
    }

    await server.close();
  });

  test("mt#1785 PR #1074 R1 BLOCKING: unknown env value falls back to safe default 'underscore' (does NOT route to dotted via auto)", async () => {
    // PR #1074 R1 BLOCKING: a typo like `MINSKY_MCP_TOOL_NAMES=underscroe` or
    // any unrecognized value previously fell through to the `auto` branch.
    // With clientInfo absent or non-Claude, that emitted dotted names — the
    // exact failure mode mt#1785 set out to prevent. Validate the safe-default
    // for both Claude and non-Claude clients, and reset the one-time warning
    // latch between cases so each test can be observed independently.
    const { MinskyMCPServer: MMS } = await import("./server");
    const { __resetUnknownModeWarningForTests } = await import("./tool-name");
    const server = new MMS({
      name: "Test Server",
      version: "1.0.0",
      transportType: "stdio",
      projectContext: { repositoryPath: "/mock/test-repo" },
    });

    server.addTool(buildToolDef("tasks.list"));

    const prev = process.env.MINSKY_MCP_TOOL_NAMES;
    process.env.MINSKY_MCP_TOOL_NAMES = "underscroe"; // operator typo
    try {
      __resetUnknownModeWarningForTests();
      // Non-Claude → still underscored (safe fallback, not `auto`'s dotted).
      const nonClaude = await callToolsListHandler(server, {
        name: NON_CLAUDE_CLIENT_NAME,
        version: "1",
      });
      expect(nonClaude.tools.map((t) => t.name)).toEqual(["tasks_list"]);

      __resetUnknownModeWarningForTests();
      // Claude → also underscored (matches the safe default; no surprise).
      const claude = await callToolsListHandler(server, {
        name: CLAUDE_CLIENT_NAME,
        version: "1",
      });
      expect(claude.tools.map((t) => t.name)).toEqual(["tasks_list"]);
    } finally {
      if (prev === undefined) delete process.env.MINSKY_MCP_TOOL_NAMES;
      else process.env.MINSKY_MCP_TOOL_NAMES = prev;
    }

    await server.close();
  });

  test("PR #1071 R1 BLOCKING #1: canonical-key collision refuses to overwrite (symmetric with alias collision)", async () => {
    const { MinskyMCPServer: MMS } = await import("./server");
    const server = new MMS({
      name: "Test Server",
      version: "1.0.0",
      transportType: "stdio",
      projectContext: { repositoryPath: "/mock/test-repo" },
    });

    // Register `foo.bar` first — this also creates the alias key `foo_bar`.
    const first = buildToolDef("foo.bar");
    server.addTool(first);

    // Now attempt to register a DIFFERENT tool with canonical name `foo_bar`.
    // The pre-fix code would set tools[foo_bar] = second silently, breaking
    // any subsequent call by foo_bar (which is also the alias for first).
    const second = buildToolDef("foo_bar");
    server.addTool(second);

    // The collision must be refused: the alias key still points to first.
    const tools = (server as unknown as { tools: Map<string, unknown> }).tools;
    expect(tools.get("foo_bar")).toBe(first);
    // And the canonical `foo.bar` key is unchanged.
    expect(tools.get("foo.bar")).toBe(first);

    await server.close();
  });

  test("PR #1071 R1 BLOCKING #1: alias-key collision refuses to overwrite", async () => {
    const { MinskyMCPServer: MMS } = await import("./server");
    const server = new MMS({
      name: "Test Server",
      version: "1.0.0",
      transportType: "stdio",
      projectContext: { repositoryPath: "/mock/test-repo" },
    });

    // Register `foo_bar` first (canonical, no alias since no dot).
    const first = buildToolDef("foo_bar");
    server.addTool(first);

    // Now register `foo.bar` — its alias `foo_bar` collides with first.
    const second = buildToolDef("foo.bar");
    server.addTool(second);

    // Refused: `foo_bar` still maps to first; `foo.bar` was NOT registered.
    const tools = (server as unknown as { tools: Map<string, unknown> }).tools;
    expect(tools.get("foo_bar")).toBe(first);
    expect(tools.has("foo.bar")).toBe(false);

    await server.close();
  });

  test("idempotent re-add of same ToolDefinition is a no-op", async () => {
    const { MinskyMCPServer: MMS } = await import("./server");
    const server = new MMS({
      name: "Test Server",
      version: "1.0.0",
      transportType: "stdio",
      projectContext: { repositoryPath: "/mock/test-repo" },
    });

    const tool = buildToolDef("tasks.list");
    server.addTool(tool);
    server.addTool(tool); // same object — should be allowed
    server.addTool(tool);

    // Both keys still point to the SAME tool; map size unchanged.
    const tools = (server as unknown as { tools: Map<string, unknown> }).tools;
    expect(tools.get("tasks.list")).toBe(tool);
    expect(tools.get("tasks_list")).toBe(tool);
    expect(tools.size).toBe(2);

    await server.close();
  });
});

// ---------------------------------------------------------------------------
// mt#1625 spike: `instructions` option — constructor-time bundle injection
// ---------------------------------------------------------------------------

describe("MinskyMCPServer instructions option — mt#1625 spike", () => {
  beforeEach(() => {
    setupTestMocks();
  });

  test("instructions option appends bundle to stdio Server's instructions field at construction time", async () => {
    const { MinskyMCPServer } = await import("./server");
    const bundle =
      '<memory-bundle count="1" source="minsky-db">\n[feedback/user] Test\n  A test\n  Content\n---\n</memory-bundle>';
    const server = new MinskyMCPServer({
      transportType: "stdio",
      projectContext: { repositoryPath: "/mock/test-repo" },
      instructions: bundle,
    });

    // The SDK Server should have been constructed with the composed
    // instructions (baseInstructions + bundle). We read it via the SDK's
    // public getter pattern (here through internal field for test purposes).
    const sdkServer = (server as unknown as { server: SdkServer }).server;
    const instructions = (sdkServer as unknown as { _instructions?: string })["_instructions"];

    expect(instructions).toBeDefined();
    expect(instructions).toContain("You are connected to the Minsky MCP server");
    expect(instructions).toContain(bundle);

    await server.close();
  });

  test("HTTP per-session createConfiguredServer picks up the instructions bundle", async () => {
    const { MinskyMCPServer } = await import("./server");
    const bundle = '<memory-bundle count="1" source="minsky-db">\nTest bundle</memory-bundle>';
    const server = new MinskyMCPServer({
      transportType: "http",
      projectContext: { repositoryPath: "/mock/test-repo" },
      httpConfig: { port: 0, host: "127.0.0.1" },
      instructions: bundle,
    });

    // Create a configured server (simulates HTTP session creation)
    const sdkServerForSession = (
      server as unknown as { createConfiguredServer: (key: string) => SdkServer }
    ).createConfiguredServer("test-session-key");

    const instructions = (sdkServerForSession as unknown as { _instructions?: string })[
      "_instructions"
    ];
    expect(instructions).toContain(bundle);

    await server.close();
  });
});

describe("MinskyMCPServer init setters — mt#1962 symmetric mutual-exclusivity (PR #1188 R1 B1)", () => {
  test("setInitPromise clears any previously-set initController", async () => {
    const { MinskyMCPServer } = await import("./server");
    const { RetryingInitController } = await import("./init-retry");
    const server = new MinskyMCPServer({
      transportType: "stdio",
      projectContext: { repositoryPath: "/mock/test-repo" },
    });

    // Set a controller first.
    const controllerInitCount = { n: 0 };
    const controller = new RetryingInitController({
      initializer: async () => {
        controllerInitCount.n++;
      },
    });
    server.setInitController(controller);
    expect((server as unknown as { initController: unknown }).initController).toBe(controller);

    // Now overlay a promise — controller must be cleared.
    const promise = Promise.resolve();
    server.setInitPromise(promise);
    expect((server as unknown as { initController: unknown }).initController).toBeNull();
    expect((server as unknown as { initPromise: unknown }).initPromise).toBe(promise);

    await server.close();
  });

  test("setInitController clears any previously-set initPromise", async () => {
    const { MinskyMCPServer } = await import("./server");
    const { RetryingInitController } = await import("./init-retry");
    const server = new MinskyMCPServer({
      transportType: "stdio",
      projectContext: { repositoryPath: "/mock/test-repo" },
    });

    const promise = Promise.resolve();
    server.setInitPromise(promise);
    expect((server as unknown as { initPromise: unknown }).initPromise).toBe(promise);

    const controller = new RetryingInitController({
      initializer: async () => {},
    });
    server.setInitController(controller);
    expect((server as unknown as { initPromise: unknown }).initPromise).toBeNull();
    expect((server as unknown as { initController: unknown }).initController).toBe(controller);

    await server.close();
  });
});
