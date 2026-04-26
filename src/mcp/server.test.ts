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
import { log } from "../utils/logger";

// Shared HTTP content-type constants used across integration tests
const CONTENT_TYPE_JSON = "application/json";
const ACCEPT_MCP = "application/json, text/event-stream";

// Shared response body constants
const SESSION_NOT_FOUND_MSG = "Session not found";

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

    // Verify tool call succeeds
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
    expect(firstCall.logger).toBe("minsky-staleness");
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
});
