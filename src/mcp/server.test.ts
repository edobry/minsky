/**
 * MCP Server Tests
 * @migrated Already using native Bun patterns
 * @refactored Uses project utilities and proper TypeScript imports
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { Server as SdkServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport as SdkStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import type { AddressInfo } from "net";
import { setupTestMocks } from "../utils/test-utils/mocking";
import { log } from "../utils/logger";

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
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
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
});
